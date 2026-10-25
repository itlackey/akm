// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Setup wizard connection steps: embedding (Ollama) detection, LLM provider
 * selection, and the two-step small-model + agent connection configuration.
 */

import * as p from "../../cli/clack";
import type { AkmConfig, EmbeddingConnectionConfig } from "../../core/config/config";
import { detectAgentCliProfiles, pickDefaultAgentProfile } from "../../integrations/agent";
import type { HarnessLLMConfig } from "../../integrations/harnesses/shared";
import { detectLMStudio, detectOllama, type LMStudioDetectionResult } from "../detect";
import { verifyOpenAiCompatibleEndpoint } from "../detected-engines";
import {
  cloneLlmConnection,
  type HarnessSelection,
  readAgentEngineSelection,
  readCurrentLlmEngine,
  type SetupConnection,
} from "../engine-config";
import { prompt } from "../prompt";
import {
  keepCurrentOption,
  llmConnection,
  lmStudioOptionHint,
  probeLlmConnection,
  promptApiKeyEnvVarName,
  promptEndpointUrl,
  promptLmStudioModel,
  promptModelName,
} from "./connection-shared";

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
    hint: 'beta OpenAI-compat layer; apiKey: "$VAR" required; override the model if the default is unavailable',
  },
  {
    value: "openai",
    label: "OpenAI",
    endpoint: "https://api.openai.com/v1/chat/completions",
    defaultModel: "gpt-4o-mini",
    hint: 'apiKey: "$VAR" required',
  },
  {
    value: "google",
    label: "Google Gemini (OpenAI-compat)",
    endpoint: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    defaultModel: "gemini-2.0-flash",
    hint: 'OpenAI-compat endpoint, apiKey: "$VAR" required',
  },
];

/**
 * Step 3a: pick an LLM provider. Used for LLM-gated background features
 * (e.g. memory inference).
 *
 * @internal Exported for testing only.
 */
export async function stepLlm(
  current: AkmConfig,
  ollamaEndpoint?: string,
  ollamaChatModels?: string[],
  lmStudio?: LMStudioDetectionResult,
  harnessConfigs?: HarnessLLMConfig[],
): Promise<SetupConnection | undefined> {
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
  options.push({ value: "lmstudio", label: "LM Studio / local server", hint: lmStudioOptionHint(lmStudio) });
  options.push({ value: "custom", label: "Custom OpenAI-compatible endpoint" });
  options.push({ value: "none", label: "Skip LLM", hint: "LLM-gated background features stay disabled" });
  const currentLlm = readCurrentLlmEngine(current);
  if (currentLlm) {
    options.push(keepCurrentOption(currentLlm));
  }

  const initialValue = currentLlm ? "keep" : ollamaAvailable ? "ollama" : (LLM_PRESETS[0]?.value ?? "none");

  const choice = await prompt(() =>
    p.select({
      message: "Configure an LLM for background features:",
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
    const llmConfig: SetupConnection = {
      endpoint: verified.endpoint,
      model: harness.model ?? "",
      ...(harness.apiKeyEnvVar ? { apiKey: `\${${harness.apiKeyEnvVar}}` } : {}),
    };
    if (harness.provider) llmConfig.provider = harness.provider as string;
    return llmConfig;
  }

  let llm: SetupConnection;

  if (choice === "ollama") {
    const modelChoice = await prompt(() =>
      p.select({
        message: "Which Ollama model?",
        options: (ollamaChatModels ?? []).map((m) => ({ value: m, label: m })),
        initialValue: ollamaChatModels?.[0],
      }),
    );
    llm = llmConnection("ollama", `${ollamaEndpoint}/v1/chat/completions`, modelChoice);
  } else if (choice === "lmstudio") {
    const currentLmsLlm = currentLlm?.provider === "lmstudio" ? currentLlm : undefined;
    const defaultEndpoint =
      currentLmsLlm?.endpoint ??
      (lmStudio?.endpoint ? `${lmStudio.endpoint}/v1/chat/completions` : "http://localhost:1234/v1/chat/completions");
    const endpoint = await promptEndpointUrl({ placeholder: defaultEndpoint, defaultValue: defaultEndpoint });
    const model = await promptLmStudioModel(lmStudio, currentLmsLlm?.model);
    llm = llmConnection("lmstudio", endpoint.trim(), model.trim());
  } else if (choice === "custom") {
    const currentCustomLlm = currentLlm?.provider === "custom" ? currentLlm : undefined;
    const endpoint = await promptEndpointUrl({
      message: "OpenAI-compatible chat completions endpoint:",
      placeholder: currentCustomLlm?.endpoint ?? "https://your-host/v1/chat/completions",
      defaultValue: currentCustomLlm?.endpoint,
      schemeMessage: "Endpoint must start with http:// or https://",
    });
    const model = await promptModelName({
      placeholder: currentCustomLlm?.model ?? "gpt-4o-mini",
      defaultValue: currentCustomLlm?.model,
    });
    llm = llmConnection("custom", endpoint.trim(), model.trim());
  } else {
    const preset = LLM_PRESETS.find((p) => p.value === choice);
    if (!preset) return undefined;
    const model = await promptModelName({
      message: `Model for ${preset.label}:`,
      placeholder: preset.defaultModel,
      defaultValue: preset.defaultModel,
    });
    llm = llmConnection(preset.value, preset.endpoint, model.trim() || preset.defaultModel);
  }

  // Setup stores no key; remind the user to reference one.
  const needsKey = llm.provider !== "ollama" && !llm.endpoint.includes("localhost");
  if (needsKey && llm.apiKey === undefined) {
    p.log.info('This provider requires an API key: reference it on the connection as `apiKey: "$VAR"`.');
  }

  // Capability probe — best-effort, never blocks setup.
  await probeLlmConnection(llm);

  return llm;
}

// ── Two-step connection configuration ──────────────────────────────────────

/**
 * Result of the small model connection step.
 */
export interface SmallModelConnectionResult {
  llm?: SetupConnection;
  /** True when user chose to skip the small model step entirely. */
  skipped: boolean;
  /** Detected Ollama endpoint (when available), surfaced for the agent step. */
  ollamaEndpoint?: string;
}

/**
 * Step 1/2: Configure the small model connection used for bounded LLM features.
 *
 * Detects Ollama automatically and pre-selects it. The user may also choose
 * OpenAI, LM Studio, a custom endpoint, or skip the step entirely.
 */
export async function stepSmallModelConnection(current: AkmConfig): Promise<SmallModelConnectionResult> {
  p.log.step("Step 1/2: Configure your small model connection");

  p.note(
    [
      "This connection is used for background processing:",
      "  • akm improve         (lesson distillation)",
      "  • akm remember --enrich (memory compression)",
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
  providerOptions.push(
    { value: "openai", label: "OpenAI", hint: 'requires apiKey: "$VAR"' },
    { value: "lmstudio", label: "LM Studio / local server", hint: lmStudioOptionHint(lmStudio) },
    { value: "custom", label: "Custom OpenAI-compatible endpoint" },
    { value: "skip", label: "Skip — disable enrichment features" },
  );

  const currentLlmSmall = readCurrentLlmEngine(current);
  if (currentLlmSmall) {
    providerOptions.push(keepCurrentOption(currentLlmSmall));
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
        "  • akm improve         — lesson generation",
        "  • akm remember --enrich",
        "",
        "You can configure this later with `akm setup`.",
      ].join("\n"),
      "Warning",
    );
    return { llm: undefined, skipped: true, ollamaEndpoint };
  }

  let llm: SetupConnection;

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
        model = await promptModelName({ placeholder: "llama3.2" });
      }
    } else {
      const currentOllamaModel =
        currentLlmSmall?.provider === "ollama" ? (currentLlmSmall.model ?? "llama3.2") : "llama3.2";
      model = await promptModelName({
        message: "Model name (e.g. llama3.2):",
        placeholder: currentOllamaModel,
        defaultValue: currentOllamaModel,
      });
    }
    llm = llmConnection("ollama", `${ollama.endpoint}/v1/chat/completions`, model.trim());
  } else if (providerChoice === "openai") {
    const currentOpenAiModel =
      currentLlmSmall?.provider === "openai" ? (currentLlmSmall.model ?? "gpt-4o-mini") : "gpt-4o-mini";
    const model = await promptModelName({ placeholder: currentOpenAiModel, defaultValue: currentOpenAiModel });
    p.log.info('OpenAI requires an API key: reference it on the connection as `apiKey: "$VAR"`.');
    llm = llmConnection("openai", "https://api.openai.com/v1/chat/completions", model.trim() || currentOpenAiModel);
  } else if (providerChoice === "lmstudio") {
    const currentLmsEndpoint =
      currentLlmSmall?.provider === "lmstudio"
        ? (currentLlmSmall.endpoint ?? `${lmStudio.endpoint}/v1/chat/completions`)
        : `${lmStudio.endpoint}/v1/chat/completions`;
    const currentLmsModel = currentLlmSmall?.provider === "lmstudio" ? currentLlmSmall.model : undefined;
    const endpoint = await promptEndpointUrl({ placeholder: currentLmsEndpoint, defaultValue: currentLmsEndpoint });
    const model = await promptLmStudioModel(lmStudio, currentLmsModel);
    llm = llmConnection("lmstudio", endpoint.trim(), model.trim());
  } else {
    // custom
    const currentCustomEndpoint = currentLlmSmall?.provider === "custom" ? currentLlmSmall.endpoint : undefined;
    const currentCustomModel = currentLlmSmall?.provider === "custom" ? currentLlmSmall.model : undefined;
    const endpoint = await promptEndpointUrl({
      message: "OpenAI-compatible chat completions endpoint:",
      placeholder: currentCustomEndpoint ?? "https://your-host/v1/chat/completions",
      defaultValue: currentCustomEndpoint,
    });
    const model = await promptModelName({
      placeholder: currentCustomModel ?? "gpt-4o-mini",
      defaultValue: currentCustomModel,
    });
    const apiKeyInput = await promptApiKeyEnvVarName();
    llm = llmConnection(
      "custom",
      endpoint.trim(),
      model.trim(),
      apiKeyInput?.trim() ? { apiKey: `\${${apiKeyInput.trim()}}` } : {},
    );
  }

  // Best-effort probe — never blocks setup.
  await probeLlmConnection(llm);

  return { llm, skipped: false, ollamaEndpoint };
}

/**
 * Step 2/2: Configure how agentic features run.
 *
 * Agent work runs on an installed CLI agent (a harness), or, with none, on akm's own
 * runtime over the connection from Step 1.
 */
export async function stepAgentConnection(
  current: AkmConfig,
  smallModel: SmallModelConnectionResult,
): Promise<HarnessSelection | undefined> {
  p.log.step("Step 2/2: Configure your agent connection");

  p.note(
    [
      "This connection is used for agentic commands:",
      "  • akm proposal new (generate improvement proposals)",
      "  • akm improve       (run the reflect/distill/consolidate self-improvement pipeline)",
      "  • akm task run     (run automated task prompts)",
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
      label: "Run on the connection from Step 1",
      hint: `uses ${smallModel.llm.endpoint.replace(/\/chat\/completions$/, "")}`,
    });
  }

  if (availableClis.length > 0) {
    agentOptions.push({
      value: "cli-agent",
      label: "Installed CLI agent",
      hint: `${availableClis.map((d) => d.name).join(", ")} detected`,
    });
  }
  agentOptions.push({ value: "none", label: "None — disable agentic features" });

  if (currentAgentBlock) {
    agentOptions.push({
      value: "keep",
      label: `Keep current: ${currentAgentBlock.default ? `CLI: ${currentAgentBlock.default}` : "configured"}`,
    });
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
        '  • akm proposal new — will show "no agent configured" error',
        '  • akm improve — will show "no agent configured" error',
        '  • akm task run — will show "no agent configured" error',
        "",
        "You can configure this later with `akm setup`.",
      ].join("\n"),
      "Warning",
    );
    return { disabled: true };
  }

  if (agentChoice === "same-connection") {
    // With no harness enabled, agent work runs on akm's own runtime over the connection.
    return { disabled: true };
  }

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
