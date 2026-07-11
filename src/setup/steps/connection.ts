// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Setup wizard connection steps: embedding (Ollama) detection, LLM provider
 * selection, and the two-step small-model + agent connection configuration.
 */

import * as p from "../../cli/clack";
import type { AkmConfig, EmbeddingConnectionConfig, LlmConnectionConfig } from "../../core/config/config";
import { detectAgentCliProfiles, pickDefaultAgentProfile } from "../../integrations/agent";
import { probeLlmCapabilities } from "../../llm/client";
import { detectLMStudio, detectOllama, type LMStudioDetectionResult } from "../detect";
import { verifyOpenAiCompatibleEndpoint } from "../detected-engines";
import {
  type AgentEngineSelection,
  cloneLlmConnection,
  readAgentEngineSelection,
  readCurrentLlmEngine,
} from "../engine-config";
import type { HarnessLLMConfig } from "../harness-config-import";
import { prompt, promptOrBack } from "../prompt";

interface OllamaChoices {
  embedding?: EmbeddingConnectionConfig;
  /** Detected Ollama endpoint, surfaced to the LLM step so it can offer Ollama as a preset. */
  ollamaEndpoint?: string;
  /** Detected Ollama chat-capable model names. */
  ollamaChatModels?: string[];
}

export async function stepOllama(current: AkmConfig): Promise<OllamaChoices> {
  const spin = p.spinner();
  spin.start("Checking for Ollama...");

  const ollama = await detectOllama();

  if (!ollama.available) {
    spin.stop("Ollama not detected");
    p.log.info(
      "Ollama is not running. Embeddings will use the built-in local model.\n" +
        "To use Ollama later, install it from https://ollama.com and re-run `akm setup`.",
    );
    // Preserve existing embedding config when Ollama is not available
    return { embedding: current.embedding };
  }

  spin.stop(`Ollama detected at ${ollama.endpoint}`);

  if (ollama.models.length > 0) {
    p.log.info(`Available models: ${ollama.models.join(", ")}`);
  }

  // Embedding model selection
  const embeddingModels = ollama.models.filter(
    (m) => m.includes("embed") || m.includes("nomic") || m.includes("minilm") || m.includes("bge"),
  );
  const hasEmbeddingModels = embeddingModels.length > 0;

  let embedding: EmbeddingConnectionConfig | undefined;

  const embeddingOptions: Array<{ value: string; label: string; hint?: string }> = [];
  for (const m of embeddingModels) {
    embeddingOptions.push({ value: m, label: m, hint: "Ollama" });
  }
  embeddingOptions.push({
    value: "local",
    label: "Built-in local embeddings",
    hint: "no server needed",
  });

  if (current.embedding) {
    embeddingOptions.push({
      value: "keep",
      label: `Keep current: ${current.embedding.provider ?? current.embedding.endpoint}`,
      hint: current.embedding.model,
    });
  }

  const embChoice = await prompt(() =>
    p.select({
      message: "Which embedding provider should akm use?",
      options: embeddingOptions,
      initialValue: hasEmbeddingModels ? embeddingModels[0] : "local",
    }),
  );

  if (embChoice === "keep") {
    embedding = current.embedding;
  } else if (embChoice !== "local") {
    // Ask for dimension — different models produce different sizes.
    // Common dimensions: nomic-embed-text=768, mxbai-embed-large=1024,
    // all-minilm/bge-small=384. Default based on selected model.
    const knownDims: Record<string, number> = {
      nomic: 768,
      mxbai: 1024,
      minilm: 384,
      bge: 384,
      qwen3: 1024,
    };
    const guessedDim = Object.entries(knownDims).find(([k]) => embChoice.includes(k))?.[1] ?? 384;
    p.note(
      "Embedding dimension must match the model. Common values: 384 (BGE small), 768 (BGE base), 1024 (BGE large). Press Enter to accept the detected default.",
      "Embedding dimension",
    );
    const dimChoice = await prompt(() =>
      p.text({
        message: `Embedding dimension for ${embChoice}:`,
        placeholder: String(guessedDim),
        defaultValue: String(guessedDim),
        validate: (v) => {
          const n = Number(v);
          if (!Number.isInteger(n) || n <= 0) return "Must be a positive integer";
        },
      }),
    );

    embedding = {
      provider: "ollama",
      endpoint: `${ollama.endpoint}/v1/embeddings`,
      model: embChoice,
      dimension: Number(dimChoice),
    };

    p.note(
      [
        "Recommended Qwen embedding models (modern, high context support):",
        "  • qwen3-embedding-0.6b  — fast and lightweight (ollama pull qwen3-embedding-0.6b)",
        "  • qwen3-embedding-4b    — higher quality (ollama pull qwen3-embedding-4b)",
        "",
        "For long documents (wiki pages, large files), set context length to avoid 400 errors:",
        "  akm config set embedding.contextLength 8192",
      ].join("\n"),
      "Embedding tips",
    );
  }
  // else: undefined → use built-in local

  // Surface Ollama details to the LLM step so it can offer Ollama as a preset.
  const ollamaChatModels = ollama.models.filter((m) => !embeddingModels.includes(m));

  return { embedding, ollamaEndpoint: ollama.endpoint, ollamaChatModels };
}

// ── LLM provider step ──────────────────────────────────────────────────────

interface LlmPreset {
  value: string;
  label: string;
  endpoint: string;
  defaultModel: string;
  hint?: string;
}

const LLM_PRESETS: LlmPreset[] = [
  {
    value: "anthropic",
    label: "Anthropic Claude (OpenAI SDK compat beta)",
    endpoint: "https://api.anthropic.com/v1/chat/completions",
    defaultModel: "claude-sonnet-4-5",
    hint: "beta OpenAI-compat layer; set AKM_LLM_API_KEY; override the model if the default is unavailable",
  },
  {
    value: "openai",
    label: "OpenAI",
    endpoint: "https://api.openai.com/v1/chat/completions",
    defaultModel: "gpt-4o-mini",
    hint: "AKM_LLM_API_KEY required",
  },
  {
    value: "google",
    label: "Google Gemini (OpenAI-compat)",
    endpoint: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    defaultModel: "gemini-2.0-flash",
    hint: "OpenAI-compat endpoint, AKM_LLM_API_KEY required",
  },
];

/**
 * Step 3a: pick an LLM provider. Used for indexing-time metadata enhancement.
 *
 * @internal Exported for testing only.
 */
export async function stepLlm(
  current: AkmConfig,
  ollamaEndpoint?: string,
  ollamaChatModels?: string[],
  lmStudio?: LMStudioDetectionResult,
  harnessConfigs?: HarnessLLMConfig[],
): Promise<LlmConnectionConfig | undefined> {
  // Build "Import from <Harness>" options and prepend them before LLM_PRESETS
  const harnessOptions = (harnessConfigs ?? []).map((h) => ({
    value: `harness:${h.harnessName}`,
    label: `Import from ${h.harnessName}`,
    hint: [h.provider, h.model].filter(Boolean).join(" / ") || "detected",
  }));

  const options: Array<{ value: string; label: string; hint?: string }> = [
    ...harnessOptions,
    ...LLM_PRESETS.map((preset) => ({
      value: preset.value,
      label: preset.label,
      hint: preset.hint,
    })),
  ];

  const ollamaAvailable = Boolean(ollamaEndpoint && ollamaChatModels && ollamaChatModels.length > 0);
  if (ollamaAvailable) {
    options.push({
      value: "ollama",
      label: "Ollama (local)",
      hint: ollamaChatModels?.[0] ?? "local",
    });
  }
  const lmStudioHint = lmStudio?.available
    ? `${lmStudio.models.length} model${lmStudio.models.length === 1 ? "" : "s"} detected`
    : "http://localhost:1234";
  options.push({ value: "lmstudio", label: "LM Studio / local server", hint: lmStudioHint });
  options.push({ value: "custom", label: "Custom OpenAI-compatible endpoint" });
  options.push({ value: "none", label: "Skip LLM", hint: "no metadata enhancement during indexing" });
  const currentLlm = readCurrentLlmEngine(current);
  if (currentLlm) {
    options.push({
      value: "keep",
      label: `Keep current: ${currentLlm.provider ?? currentLlm.endpoint}`,
      hint: currentLlm.model,
    });
  }

  const initialValue = currentLlm ? "keep" : ollamaAvailable ? "ollama" : (LLM_PRESETS[0]?.value ?? "none");

  const choice = await prompt(() =>
    p.select({
      message: "Configure an LLM for richer metadata during indexing:",
      options,
      initialValue,
    }),
  );

  if (choice === "keep") return cloneLlmConnection(currentLlm);
  if (choice === "none") return undefined;

  // Handle "Import from <Harness>" choices
  if (typeof choice === "string" && choice.startsWith("harness:")) {
    const harness = (harnessConfigs ?? []).find((h) => `harness:${h.harnessName}` === choice);
    if (!harness) return undefined;
    // Show a summary before accepting
    p.log.info(
      `Importing LLM config from ${harness.harnessName}: ` +
        [harness.provider, harness.model, harness.baseUrl].filter(Boolean).join(", "),
    );
    if (!harness.baseUrl || !harness.model) {
      p.log.warn(`Skipping ${harness.harnessName}: no complete endpoint/model was detected.`);
      return undefined;
    }
    const verified = await verifyOpenAiCompatibleEndpoint({
      endpoint: harness.baseUrl,
      model: harness.model,
      apiKeyEnvVar: harness.apiKeyEnvVar,
    });
    if (!verified.ok) {
      p.log.warn(`Skipping ${harness.harnessName}: ${verified.reason}. Fix its endpoint/credential and retry setup.`);
      return undefined;
    }
    const llmConfig: LlmConnectionConfig = {
      endpoint: verified.endpoint,
      model: harness.model ?? "",
      temperature: 0.3,
      maxTokens: 1024,
      ...(harness.apiKeyEnvVar ? { apiKey: `\${${harness.apiKeyEnvVar}}` } : {}),
    };
    if (harness.provider) llmConfig.provider = harness.provider as LlmConnectionConfig["provider"];
    return llmConfig;
  }

  let llm: LlmConnectionConfig;

  if (choice === "ollama") {
    const modelChoice = await prompt(() =>
      p.select({
        message: "Which Ollama model?",
        options: (ollamaChatModels ?? []).map((m) => ({ value: m, label: m })),
        initialValue: ollamaChatModels?.[0],
      }),
    );
    llm = {
      provider: "ollama",
      endpoint: `${ollamaEndpoint}/v1/chat/completions`,
      model: modelChoice,
      temperature: 0.3,
      maxTokens: 1024,
    };
  } else if (choice === "lmstudio") {
    const currentLmsLlm = currentLlm?.provider === "lmstudio" ? currentLlm : undefined;
    const defaultEndpoint =
      currentLmsLlm?.endpoint ??
      (lmStudio?.endpoint ? `${lmStudio.endpoint}/v1/chat/completions` : "http://localhost:1234/v1/chat/completions");
    const endpoint = await prompt(() =>
      p.text({
        message: "Endpoint URL:",
        placeholder: defaultEndpoint,
        defaultValue: defaultEndpoint,
        validate: (v) => {
          if (!v?.trim()) return "Endpoint cannot be empty";
          if (!v.startsWith("http://") && !v.startsWith("https://")) return "Must start with http:// or https://";
        },
      }),
    );
    let model: string;
    const lmsModels = lmStudio?.available && lmStudio.models.length > 0 ? lmStudio.models : [];
    if (lmsModels.length > 0) {
      const modelChoice = await prompt(() =>
        p.select({
          message: "Model name:",
          options: [
            ...lmsModels.map((m) => ({ value: m, label: m })),
            { value: "__manual__", label: "Enter manually..." },
          ],
          initialValue:
            currentLmsLlm?.model && lmsModels.includes(currentLmsLlm.model) ? currentLmsLlm.model : lmsModels[0],
        }),
      );
      if (modelChoice === "__manual__") {
        model = await prompt(() =>
          p.text({
            message: "Model name:",
            placeholder: currentLmsLlm?.model ?? "local-model",
            ...(currentLmsLlm?.model ? { defaultValue: currentLmsLlm.model } : {}),
            validate: (v) => (!v?.trim() ? "Model name cannot be empty" : undefined),
          }),
        );
      } else {
        model = modelChoice;
      }
    } else {
      model = await prompt(() =>
        p.text({
          message: "Model name:",
          placeholder: currentLmsLlm?.model ?? "local-model",
          ...(currentLmsLlm?.model ? { defaultValue: currentLmsLlm.model } : {}),
          validate: (v) => (!v?.trim() ? "Model name cannot be empty" : undefined),
        }),
      );
    }
    llm = {
      provider: "lmstudio",
      endpoint: endpoint.trim(),
      model: model.trim(),
      temperature: 0.3,
      maxTokens: 1024,
    };
  } else if (choice === "custom") {
    const currentCustomLlm = currentLlm?.provider === "custom" ? currentLlm : undefined;
    const endpoint = await prompt(() =>
      p.text({
        message: "OpenAI-compatible chat completions endpoint:",
        placeholder: currentCustomLlm?.endpoint ?? "https://your-host/v1/chat/completions",
        ...(currentCustomLlm?.endpoint ? { defaultValue: currentCustomLlm.endpoint } : {}),
        validate: (v) => {
          if (!v?.trim()) return "Endpoint cannot be empty";
          if (!v.startsWith("http://") && !v.startsWith("https://"))
            return "Endpoint must start with http:// or https://";
        },
      }),
    );
    const model = await prompt(() =>
      p.text({
        message: "Model name:",
        placeholder: currentCustomLlm?.model ?? "gpt-4o-mini",
        ...(currentCustomLlm?.model ? { defaultValue: currentCustomLlm.model } : {}),
        validate: (v) => {
          if (!v?.trim()) return "Model name cannot be empty";
        },
      }),
    );
    llm = {
      provider: "custom",
      endpoint: endpoint.trim(),
      model: model.trim(),
      temperature: 0.3,
      maxTokens: 1024,
    };
  } else {
    const preset = LLM_PRESETS.find((p) => p.value === choice);
    if (!preset) return undefined;
    const model = await prompt(() =>
      p.text({
        message: `Model for ${preset.label}:`,
        placeholder: preset.defaultModel,
        defaultValue: preset.defaultModel,
        validate: (v) => {
          if (!v?.trim()) return "Model name cannot be empty";
        },
      }),
    );
    llm = {
      provider: preset.value,
      endpoint: preset.endpoint,
      model: model.trim() || preset.defaultModel,
      temperature: 0.3,
      maxTokens: 1024,
    };
  }

  // Remind the user about API key placement. We do not offer a "store in config"
  // option because saveConfig() strips apiKey fields before writing — persisting
  // secrets would need an encrypted/secure store that we don't ship.
  const needsKey = llm.provider !== "ollama" && !llm.endpoint.includes("localhost");
  if (needsKey && !process.env.AKM_LLM_API_KEY) {
    p.log.info(
      "This provider requires an API key. Set AKM_LLM_API_KEY in your shell (e.g. `export AKM_LLM_API_KEY=...`) before running `akm index`.",
    );
  }

  // Capability probe — best-effort, never blocks setup.
  const probeSpin = p.spinner();
  probeSpin.start("Probing LLM (structured-output round-trip)...");
  const probe = await probeLlmCapabilities(llm);
  if (probe.reachable && probe.structuredOutput) {
    probeSpin.stop("LLM reachable; structured output verified.");
    llm.capabilities = { ...(llm.capabilities ?? {}), structuredOutput: true };
  } else if (probe.reachable) {
    probeSpin.stop("LLM reachable but structured-output probe failed.");
    llm.capabilities = { ...(llm.capabilities ?? {}), structuredOutput: false };
  } else {
    probeSpin.stop("LLM not reachable.");
    p.log.warn(
      `Could not reach the LLM endpoint${probe.error ? ` (${probe.error})` : ""}. Configuration was saved; verify your endpoint and API key, then retry.`,
    );
  }

  return llm;
}

// ── Two-step connection configuration ──────────────────────────────────────

/**
 * Result of the small model connection step.
 */
export interface SmallModelConnectionResult {
  llm?: LlmConnectionConfig;
  /** True when user chose to skip the small model step entirely. */
  skipped: boolean;
  /** Detected Ollama endpoint (when available), surfaced for the agent step. */
  ollamaEndpoint?: string;
}

/**
 * Step 1/2: Configure the small model connection used for metadata and bounded LLM features.
 *
 * Detects Ollama automatically and pre-selects it. The user may also choose
 * OpenAI, LM Studio, a custom endpoint, or skip the step entirely.
 */
export async function stepSmallModelConnection(current: AkmConfig): Promise<SmallModelConnectionResult> {
  p.log.step("Step 1/2: Configure your small model connection");

  p.note(
    [
      "This connection is used for background processing:",
      "  • akm index           (metadata enhancement)",
      "  • akm distill         (lesson distillation)",
      "  • akm remember --enrich (memory compression)",
      "  • akm curate --rerank   (search reranking)",
    ].join("\n"),
  );

  // Probe for Ollama and LM Studio in the background while showing the note.
  const spin = p.spinner();
  spin.start("Detecting local services...");
  const [ollama, lmStudio] = await Promise.all([detectOllama(), detectLMStudio()]);
  const detectedServices = [
    ollama.available ? `Ollama at ${ollama.endpoint}` : null,
    lmStudio.available ? `LM Studio at ${lmStudio.endpoint}` : null,
  ]
    .filter(Boolean)
    .join(", ");
  spin.stop(detectedServices ? `Detected: ${detectedServices}` : "No local services detected");

  const ollamaEndpoint = ollama.available ? ollama.endpoint : undefined;

  const providerOptions: Array<{ value: string; label: string; hint?: string }> = [];
  if (ollama.available) {
    providerOptions.push({
      value: "ollama",
      label: "Ollama (local)",
      hint: `detected at ${ollama.endpoint}`,
    });
  }
  const lmStudioHint = lmStudio.available
    ? `${lmStudio.models.length} model${lmStudio.models.length === 1 ? "" : "s"} detected`
    : "http://localhost:1234";
  providerOptions.push(
    { value: "openai", label: "OpenAI", hint: "requires AKM_LLM_API_KEY" },
    { value: "lmstudio", label: "LM Studio / local server", hint: lmStudioHint },
    { value: "custom", label: "Custom OpenAI-compatible endpoint" },
    { value: "skip", label: "Skip — disable enrichment features" },
  );

  const currentLlmSmall = readCurrentLlmEngine(current);
  if (currentLlmSmall) {
    providerOptions.push({
      value: "keep",
      label: `Keep current: ${currentLlmSmall.provider ?? currentLlmSmall.endpoint}`,
      hint: currentLlmSmall.model,
    });
  }

  const initialValue = currentLlmSmall ? "keep" : ollama.available ? "ollama" : "openai";

  const providerChoice = await prompt(() =>
    p.select({
      message: "Provider:",
      options: providerOptions,
      initialValue,
    }),
  );

  if (providerChoice === "keep") {
    return { llm: cloneLlmConnection(currentLlmSmall), skipped: false, ollamaEndpoint };
  }

  if (providerChoice === "skip") {
    p.note(
      [
        "Enrichment features disabled:",
        "  • akm index           — metadata enhancement disabled",
        "  • akm distill         — lesson generation",
        "  • akm remember --enrich",
        "  • akm curate --rerank",
        "",
        "You can configure this later with `akm setup`.",
      ].join("\n"),
      "Warning",
    );
    return { llm: undefined, skipped: true, ollamaEndpoint };
  }

  let llm: LlmConnectionConfig;

  if (providerChoice === "ollama") {
    const ollamaChatModels = ollama.models.filter(
      (m) => !m.includes("embed") && !m.includes("nomic") && !m.includes("minilm") && !m.includes("bge"),
    );
    let model: string;
    if (ollamaChatModels.length > 0) {
      model = await prompt(() =>
        p.select({
          message: "Model name:",
          options: [
            ...ollamaChatModels.map((m) => ({ value: m, label: m })),
            { value: "__custom__", label: "Enter a model name manually..." },
          ],
          initialValue: ollamaChatModels[0],
        }),
      );
      if (model === "__custom__") {
        model = await prompt(() =>
          p.text({
            message: "Model name:",
            placeholder: "llama3.2",
            validate: (v) => (!v?.trim() ? "Model name cannot be empty" : undefined),
          }),
        );
      }
    } else {
      const currentOllamaModel =
        currentLlmSmall?.provider === "ollama" ? (currentLlmSmall.model ?? "llama3.2") : "llama3.2";
      model = await prompt(() =>
        p.text({
          message: "Model name (e.g. llama3.2):",
          placeholder: currentOllamaModel,
          defaultValue: currentOllamaModel,
          validate: (v) => (!v?.trim() ? "Model name cannot be empty" : undefined),
        }),
      );
    }
    llm = {
      provider: "ollama",
      endpoint: `${ollama.endpoint}/v1/chat/completions`,
      model: model.trim(),
      temperature: 0.3,
      maxTokens: 1024,
    };
  } else if (providerChoice === "openai") {
    const currentOpenAiModel =
      currentLlmSmall?.provider === "openai" ? (currentLlmSmall.model ?? "gpt-4o-mini") : "gpt-4o-mini";
    const model = await prompt(() =>
      p.text({
        message: "Model name:",
        placeholder: currentOpenAiModel,
        defaultValue: currentOpenAiModel,
        validate: (v) => (!v?.trim() ? "Model name cannot be empty" : undefined),
      }),
    );
    if (!process.env.AKM_LLM_API_KEY) {
      p.log.info("Set AKM_LLM_API_KEY in your shell before running `akm index`.");
    }
    llm = {
      provider: "openai",
      endpoint: "https://api.openai.com/v1/chat/completions",
      model: model.trim() || currentOpenAiModel,
      temperature: 0.3,
      maxTokens: 1024,
    };
  } else if (providerChoice === "lmstudio") {
    const currentLmsEndpoint =
      currentLlmSmall?.provider === "lmstudio"
        ? (currentLlmSmall.endpoint ?? `${lmStudio.endpoint}/v1/chat/completions`)
        : `${lmStudio.endpoint}/v1/chat/completions`;
    const currentLmsModel = currentLlmSmall?.provider === "lmstudio" ? currentLlmSmall.model : undefined;
    const endpoint = await prompt(() =>
      p.text({
        message: "Endpoint URL:",
        placeholder: currentLmsEndpoint,
        defaultValue: currentLmsEndpoint,
        validate: (v) => {
          if (!v?.trim()) return "Endpoint cannot be empty";
          if (!v.startsWith("http://") && !v.startsWith("https://")) return "Must start with http:// or https://";
        },
      }),
    );
    let model: string;
    const lmsModels = lmStudio.available && lmStudio.models.length > 0 ? lmStudio.models : [];
    if (lmsModels.length > 0) {
      const modelChoice = await prompt(() =>
        p.select({
          message: "Model name:",
          options: [
            ...lmsModels.map((m) => ({ value: m, label: m })),
            { value: "__manual__", label: "Enter manually..." },
          ],
          initialValue: currentLmsModel && lmsModels.includes(currentLmsModel) ? currentLmsModel : lmsModels[0],
        }),
      );
      if (modelChoice === "__manual__") {
        model = await prompt(() =>
          p.text({
            message: "Model name:",
            placeholder: currentLmsModel ?? "local-model",
            ...(currentLmsModel ? { defaultValue: currentLmsModel } : {}),
            validate: (v) => (!v?.trim() ? "Model name cannot be empty" : undefined),
          }),
        );
      } else {
        model = modelChoice;
      }
    } else {
      model = await prompt(() =>
        p.text({
          message: "Model name:",
          placeholder: currentLmsModel ?? "local-model",
          ...(currentLmsModel ? { defaultValue: currentLmsModel } : {}),
          validate: (v) => (!v?.trim() ? "Model name cannot be empty" : undefined),
        }),
      );
    }
    llm = {
      provider: "lmstudio",
      endpoint: endpoint.trim(),
      model: model.trim(),
      temperature: 0.3,
      maxTokens: 1024,
    };
  } else {
    // custom
    const currentCustomEndpoint = currentLlmSmall?.provider === "custom" ? currentLlmSmall.endpoint : undefined;
    const currentCustomModel = currentLlmSmall?.provider === "custom" ? currentLlmSmall.model : undefined;
    const endpoint = await prompt(() =>
      p.text({
        message: "OpenAI-compatible chat completions endpoint:",
        placeholder: currentCustomEndpoint ?? "https://your-host/v1/chat/completions",
        ...(currentCustomEndpoint ? { defaultValue: currentCustomEndpoint } : {}),
        validate: (v) => {
          if (!v?.trim()) return "Endpoint cannot be empty";
          if (!v.startsWith("http://") && !v.startsWith("https://")) return "Must start with http:// or https://";
        },
      }),
    );
    const model = await prompt(() =>
      p.text({
        message: "Model name:",
        placeholder: currentCustomModel ?? "gpt-4o-mini",
        ...(currentCustomModel ? { defaultValue: currentCustomModel } : {}),
        validate: (v) => (!v?.trim() ? "Model name cannot be empty" : undefined),
      }),
    );
    const apiKeyInput = await promptOrBack(() =>
      p.text({
        message: "API key environment variable name (optional):",
        placeholder: "CUSTOM_LLM_API_KEY",
        validate: (value) =>
          value && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)
            ? "Use an environment variable name, not a key value"
            : undefined,
      }),
    );
    llm = {
      provider: "custom",
      endpoint: endpoint.trim(),
      model: model.trim(),
      temperature: 0.3,
      maxTokens: 1024,
      ...(apiKeyInput?.trim() ? { apiKey: `\${${apiKeyInput.trim()}}` } : {}),
    };
  }

  // Best-effort probe — never blocks setup.
  const probeSpin = p.spinner();
  probeSpin.start("Probing LLM (structured-output round-trip)...");
  const probe = await probeLlmCapabilities(llm);
  if (probe.reachable && probe.structuredOutput) {
    probeSpin.stop("LLM reachable; structured output verified.");
    llm.capabilities = { ...(llm.capabilities ?? {}), structuredOutput: true };
  } else if (probe.reachable) {
    probeSpin.stop("LLM reachable but structured-output probe failed.");
    llm.capabilities = { ...(llm.capabilities ?? {}), structuredOutput: false };
  } else {
    probeSpin.stop("LLM not reachable.");
    p.log.warn(
      `Could not reach the LLM endpoint${probe.error ? ` (${probe.error})` : ""}. Configuration was saved; verify your endpoint and API key, then retry.`,
    );
  }

  return { llm, skipped: false, ollamaEndpoint };
}

/**
 * Step 2/2: Configure the agent connection used for agentic features.
 *
 * Options depend on whether Step 1 was completed or skipped.
 */
export async function stepAgentConnection(
  current: AkmConfig,
  smallModel: SmallModelConnectionResult,
): Promise<AgentEngineSelection | undefined> {
  p.log.step("Step 2/2: Configure your agent connection");

  p.note(
    [
      "This connection is used for agentic commands:",
      "  • akm propose   (generate improvement proposals)",
      "  • akm improve   (run the reflect/distill/consolidate self-improvement pipeline)",
      "  • akm tasks run (run automated task prompts)",
    ].join("\n"),
  );

  // Detect available CLI agents.
  const detections = detectAgentCliProfiles(current);
  const currentAgentBlock = readAgentEngineSelection(current);
  const availableClis = detections.filter((d) => d.available);

  const agentOptions: Array<{ value: string; label: string; hint?: string }> = [];

  if (!smallModel.skipped && smallModel.llm) {
    agentOptions.push({
      value: "same-connection",
      label: "Same connection, select model",
      hint: `uses ${smallModel.llm.endpoint.replace("/v1/chat/completions", "")}`,
    });
  }
  agentOptions.push({ value: "new-connection", label: "New connection (different endpoint)" });

  if (availableClis.length > 0) {
    agentOptions.push({
      value: "cli-agent",
      label: "Installed CLI agent",
      hint: `${availableClis.map((d) => d.name).join(", ")} detected`,
    });
  }
  agentOptions.push({ value: "none", label: "None — disable agentic features" });

  if (currentAgentBlock) {
    const currentDesc = currentAgentBlock.default
      ? `CLI: ${currentAgentBlock.default}`
      : currentAgentBlock.engines?.default?.model
        ? `SDK: ${currentAgentBlock.engines.default.model}`
        : "configured";
    agentOptions.push({ value: "keep", label: `Keep current: ${currentDesc}` });
  }

  const initialAgentValue = currentAgentBlock
    ? "keep"
    : availableClis.length > 0 && smallModel.skipped
      ? "cli-agent"
      : !smallModel.skipped && smallModel.llm
        ? "same-connection"
        : availableClis.length > 0
          ? "cli-agent"
          : "none";

  const agentChoice = await prompt(() =>
    p.select({
      message: "How do you want to run agent commands?",
      options: agentOptions,
      initialValue: initialAgentValue,
    }),
  );

  if (agentChoice === "keep") {
    return currentAgentBlock;
  }

  if (agentChoice === "none") {
    p.note(
      [
        "Agentic features disabled:",
        '  • akm propose — will show "no agent configured" error',
        '  • akm improve — will show "no agent configured" error',
        '  • akm tasks run — will show "no agent configured" error',
        "",
        "You can configure this later with `akm setup`.",
      ].join("\n"),
      "Warning",
    );
    return undefined;
  }

  if (agentChoice === "same-connection") {
    if (smallModel.skipped || !smallModel.llm) {
      p.log.warn(
        "You skipped the small model connection. Configure one to use the same connection. Falling back to 'new connection'.",
      );
      // Fall through to new-connection flow
    } else {
      const baseEndpoint = smallModel.llm.endpoint.replace("/v1/chat/completions", "");
      p.log.info(`Endpoint: ${baseEndpoint} (from Step 1)`);
      const profileName = `${smallModel.llm.provider ?? "default"}-agent`;
      // Pre-populate from existing agent profile for this provider, if any.
      const existingAgentModel = currentAgentBlock?.engines?.[profileName]?.model ?? smallModel.llm.model ?? undefined;
      const agentModel = await prompt(() =>
        p.text({
          message: "Model to use for agent tasks (same model is fine, larger models work better):",
          placeholder: existingAgentModel ?? "qwen2.5-coder:32b",
          ...(existingAgentModel ? { defaultValue: existingAgentModel } : {}),
          validate: (v) => (!v?.trim() ? "Model name cannot be empty" : undefined),
        }),
      );
      return {
        ...(currentAgentBlock ?? {}),
        engines: {
          ...(currentAgentBlock?.engines ?? {}),
          [profileName]: {
            ...(currentAgentBlock?.engines?.[profileName] ?? {}),
            kind: "agent",
            platform: "opencode-sdk",
            model: agentModel.trim(),
            ...(current.defaults?.llmEngine ? { llmEngine: current.defaults.llmEngine } : {}),
          },
        },
        default: profileName,
      };
    }
  }

  if (agentChoice === "cli-agent") {
    if (availableClis.length === 0) {
      p.log.warn("No agent CLIs detected on PATH.");
      return currentAgentBlock;
    }

    const initialCli = pickDefaultAgentProfile(detections, currentAgentBlock?.default) ?? availableClis[0]?.name;
    const selectedCli = await prompt(() =>
      p.select({
        message: "Which CLI agent?",
        options: availableClis.map((d) => ({
          value: d.name,
          label: d.name,
          hint: d.resolvedPath ?? d.bin,
        })),
        initialValue: initialCli,
      }),
    );

    return {
      ...(currentAgentBlock ?? {}),
      default: selectedCli,
    };
  }

  // "new-connection" (also fall-through from "same-provider" when Step 1 was skipped)
  // Pre-populate from current "custom" agent profile if available.
  const currentCustomAgentProfile = currentAgentBlock?.engines?.["custom-agent"];
  const currentNewEndpoint = undefined;
  const currentNewModel = currentCustomAgentProfile?.model ?? undefined;
  const newEndpoint = await prompt(() =>
    p.text({
      message: "OpenAI-compatible chat completions endpoint:",
      placeholder: currentNewEndpoint ?? "https://your-host/v1/chat/completions",
      ...(currentNewEndpoint ? { defaultValue: currentNewEndpoint } : {}),
      validate: (v) => {
        if (!v?.trim()) return "Endpoint cannot be empty";
        if (!v.startsWith("http://") && !v.startsWith("https://")) return "Must start with http:// or https://";
      },
    }),
  );
  const newApiKeyInput = await promptOrBack(() =>
    p.text({
      message: "API key environment variable name (optional):",
      placeholder: "CUSTOM_LLM_API_KEY",
      validate: (value) =>
        value && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)
          ? "Use an environment variable name, not a key value"
          : undefined,
    }),
  );
  const newModel = await prompt(() =>
    p.text({
      message: "Model name (larger is better, e.g. gpt-4o):",
      placeholder: currentNewModel ?? "gpt-4o",
      ...(currentNewModel ? { defaultValue: currentNewModel } : {}),
      validate: (v) => (!v?.trim() ? "Model name cannot be empty" : undefined),
    }),
  );

  const llmEngineName = "custom-llm";
  const agentEngineName = "custom-agent";
  const customProfile = {
    kind: "agent" as const,
    platform: "opencode-sdk" as const,
    llmEngine: llmEngineName,
    model: newModel.trim(),
  };

  return {
    ...(currentAgentBlock ?? {}),
    engines: {
      ...(currentAgentBlock?.engines ?? {}),
      [llmEngineName]: {
        kind: "llm",
        provider: "custom",
        endpoint: newEndpoint.trim(),
        model: newModel.trim(),
        ...(newApiKeyInput?.trim() ? { apiKey: `\${${newApiKeyInput.trim()}}` } : {}),
      },
      [agentEngineName]: customProfile,
    },
    default: agentEngineName,
  };
}
