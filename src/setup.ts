/**
 * Interactive configuration wizard for akm.
 *
 * Walks users through service detection, embedding/LLM setup,
 * registry selection, stash sources, and agent platform discovery.
 * Collects all choices and writes config once at the end.
 */

import * as p from "@clack/prompts";
import type {
  AkmConfig,
  EmbeddingConnectionConfig,
  LlmConnectionConfig,
  RegistryConfigEntry,
  StashConfigEntry,
} from "./config";
import { DEFAULT_CONFIG, getConfigPath, loadConfig, saveConfig } from "./config";
import { detectAgentPlatforms, detectOllama, detectOpenViking } from "./detect";
import { akmInit } from "./init";
import { getDefaultStashDir } from "./paths";

// ── Helpers ─────────────────────────────────────────────────────────────────

function bail(): never {
  p.cancel("Setup cancelled.");
  process.exit(0);
}

function cancelled(value: unknown): value is symbol {
  return p.isCancel(value);
}

// ── Steps ───────────────────────────────────────────────────────────────────

async function stepStashDir(current: AkmConfig): Promise<string> {
  const defaultDir = current.stashDir ?? getDefaultStashDir();

  const choice = await p.select({
    message: "Where should akm store skills, commands, and other assets?",
    options: [
      { value: "default", label: defaultDir, hint: current.stashDir ? "current" : "default" },
      { value: "custom", label: "Enter a custom path..." },
    ],
  });
  if (cancelled(choice)) bail();

  if (choice === "default") return defaultDir;

  const customPath = await p.text({
    message: "Enter the stash directory path:",
    placeholder: defaultDir,
    validate: (v) => {
      if (!v?.trim()) return "Path cannot be empty";
    },
  });
  if (cancelled(customPath)) bail();

  return customPath.trim();
}

interface OllamaChoices {
  embedding?: EmbeddingConnectionConfig;
  llm?: LlmConnectionConfig;
}

async function stepOllama(current: AkmConfig): Promise<OllamaChoices> {
  const spin = p.spinner();
  spin.start("Checking for Ollama...");

  const ollama = await detectOllama();

  if (!ollama.available) {
    spin.stop("Ollama not detected");
    p.log.info(
      "Ollama is not running. Embeddings will use the built-in local model.\n" +
        "To use Ollama later, install it from https://ollama.com and re-run `akm setup`.",
    );
    return {};
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

  const embChoice = await p.select({
    message: "Which embedding provider should akm use?",
    options: embeddingOptions,
    initialValue: hasEmbeddingModels ? embeddingModels[0] : "local",
  });
  if (cancelled(embChoice)) bail();

  if (embChoice === "keep") {
    embedding = current.embedding;
  } else if (embChoice !== "local") {
    embedding = {
      provider: "ollama",
      endpoint: `${ollama.endpoint}/v1/embeddings`,
      model: embChoice,
      dimension: 384,
    };
  }
  // else: undefined → use built-in local

  // LLM model selection
  const chatModels = ollama.models.filter((m) => !embeddingModels.includes(m));
  const allLlmCandidates = chatModels.length > 0 ? chatModels : ollama.models;

  let llm: LlmConnectionConfig | undefined;

  const llmOptions: Array<{ value: string; label: string; hint?: string }> = [];
  for (const m of allLlmCandidates) {
    llmOptions.push({ value: m, label: m, hint: "Ollama" });
  }
  llmOptions.push({
    value: "none",
    label: "Skip LLM enhancement",
    hint: "use heuristic metadata",
  });

  if (current.llm) {
    llmOptions.push({
      value: "keep",
      label: `Keep current: ${current.llm.provider ?? current.llm.endpoint}`,
      hint: current.llm.model,
    });
  }

  const llmChoice = await p.select({
    message: "Use an LLM for richer metadata during indexing?",
    options: llmOptions,
    initialValue: allLlmCandidates.length > 0 ? allLlmCandidates[0] : "none",
  });
  if (cancelled(llmChoice)) bail();

  if (llmChoice === "keep") {
    llm = current.llm;
  } else if (llmChoice !== "none") {
    llm = {
      provider: "ollama",
      endpoint: `${ollama.endpoint}/v1/chat/completions`,
      model: llmChoice,
      temperature: 0.3,
      maxTokens: 512,
    };
  }

  return { embedding, llm };
}

async function stepRegistries(current: AkmConfig): Promise<RegistryConfigEntry[]> {
  const defaults = DEFAULT_CONFIG.registries ?? [];
  const currentUrls = new Set((current.registries ?? defaults).filter((r) => r.enabled !== false).map((r) => r.url));

  const options = defaults.map((r) => ({
    value: r.url,
    label: r.name ?? r.url,
    hint: r.provider ?? "static index",
  }));

  const selected = await p.multiselect({
    message: "Which kit registries should be enabled?",
    options,
    initialValues: options.filter((o) => currentUrls.has(o.value)).map((o) => o.value),
  });
  if (cancelled(selected)) bail();

  return defaults.map((r) => ({
    ...r,
    enabled: selected.includes(r.url),
  }));
}

async function stepStashSources(current: AkmConfig): Promise<StashConfigEntry[]> {
  const stashes: StashConfigEntry[] = [...(current.stashes ?? [])];

  if (stashes.length > 0) {
    p.log.info(`You have ${stashes.length} existing stash source(s).`);
  }

  let addMore = true;
  while (addMore) {
    const action = await p.select({
      message: "Add a stash source?",
      options: [
        { value: "openviking", label: "OpenViking server", hint: "remote stash" },
        { value: "context-hub", label: "Context Hub", hint: "GitHub repo mirror" },
        { value: "filesystem", label: "Filesystem path", hint: "local directory" },
        { value: "done", label: "Done — no more sources" },
      ],
    });
    if (cancelled(action)) bail();

    if (action === "done") {
      addMore = false;
      break;
    }

    if (action === "openviking") {
      const url = await p.text({
        message: "Enter the OpenViking server URL:",
        placeholder: "https://your-openviking-server.example.com",
        validate: (v) => {
          if (!v?.trim()) return "URL cannot be empty";
          if (!v.startsWith("http://") && !v.startsWith("https://")) return "URL must start with http:// or https://";
        },
      });
      if (cancelled(url)) bail();

      const spin = p.spinner();
      spin.start("Checking OpenViking server...");
      const result = await detectOpenViking(url.trim());
      if (result.available) {
        spin.stop("Server is reachable");
      } else {
        spin.stop("Server not reachable — adding anyway (it may be temporarily down)");
      }

      const name = await p.text({
        message: "Give this stash a name (optional):",
        placeholder: "my-openviking",
      });
      if (cancelled(name)) bail();

      const entry: StashConfigEntry = { type: "openviking", url: url.trim() };
      if (name.trim()) entry.name = name.trim();
      if (!stashes.some((s) => s.url === entry.url)) {
        stashes.push(entry);
      } else {
        p.log.warn("This URL is already configured.");
      }
    }

    if (action === "context-hub") {
      const url = await p.text({
        message: "Enter the GitHub repository URL or context-hub:// URI:",
        placeholder: "https://github.com/owner/repo",
        validate: (v) => {
          if (!v?.trim()) return "URL cannot be empty";
        },
      });
      if (cancelled(url)) bail();

      const name = await p.text({
        message: "Give this stash a name (optional):",
        placeholder: "my-context-hub",
      });
      if (cancelled(name)) bail();

      const entry: StashConfigEntry = { type: "context-hub", url: url.trim() };
      if (name.trim()) entry.name = name.trim();
      if (!stashes.some((s) => s.url === entry.url)) {
        stashes.push(entry);
      } else {
        p.log.warn("This URL is already configured.");
      }
    }

    if (action === "filesystem") {
      const fsPath = await p.text({
        message: "Enter the directory path:",
        placeholder: "/path/to/stash",
        validate: (v) => {
          if (!v?.trim()) return "Path cannot be empty";
        },
      });
      if (cancelled(fsPath)) bail();

      const resolved = fsPath.trim();
      const name = await p.text({
        message: "Give this stash a name (optional):",
        placeholder: "my-stash",
      });
      if (cancelled(name)) bail();

      const entry: StashConfigEntry = { type: "filesystem", path: resolved };
      if (name.trim()) entry.name = name.trim();
      if (!stashes.some((s) => s.path === entry.path)) {
        stashes.push(entry);
      } else {
        p.log.warn("This path is already configured.");
      }
    }
  }

  return stashes;
}

async function stepAgentPlatforms(current: AkmConfig): Promise<StashConfigEntry[]> {
  const platforms = detectAgentPlatforms();

  if (platforms.length === 0) {
    p.log.info("No agent platform configurations detected.");
    return [];
  }

  const existingPaths = new Set((current.stashes ?? []).map((s) => s.path));

  // Filter out platforms already configured
  const newPlatforms = platforms.filter((pl) => !existingPaths.has(pl.path));

  if (newPlatforms.length === 0) {
    p.log.info(`Detected ${platforms.length} agent platform(s), all already configured as stash sources.`);
    return [];
  }

  const selected = await p.multiselect({
    message: "Found agent platform configurations. Add as stash sources?",
    options: newPlatforms.map((pl) => ({
      value: pl.path,
      label: pl.name,
      hint: pl.path,
    })),
    required: false,
  });
  if (cancelled(selected)) bail();

  return selected
    .map((selectedPath) => {
      const platform = newPlatforms.find((pl) => pl.path === selectedPath);
      if (!platform) return undefined;
      return {
        type: "filesystem" as const,
        path: platform.path,
        name: platform.name.toLowerCase().replace(/\s+/g, "-"),
      };
    })
    .filter((entry): entry is StashConfigEntry => entry !== undefined);
}

// ── Main Wizard ─────────────────────────────────────────────────────────────

export async function runSetupWizard(): Promise<void> {
  p.intro("akm setup");

  const current = loadConfig();
  const configPath = getConfigPath();

  // Step 1: Stash directory
  p.log.step("Step 1: Stash Directory");
  const stashDir = await stepStashDir(current);

  // Step 2: Ollama / Embedding / LLM
  p.log.step("Step 2: Embedding & LLM");
  const { embedding, llm } = await stepOllama(current);

  // Step 3: Registries
  p.log.step("Step 3: Registries");
  const registries = await stepRegistries(current);

  // Step 4: Stash sources
  p.log.step("Step 4: Stash Sources");
  const stashes = await stepStashSources(current);

  // Step 5: Agent platform detection
  p.log.step("Step 5: Agent Platform Detection");
  const platformStashes = await stepAgentPlatforms(current);

  // Merge platform stashes into main stashes list
  const allStashes = [...stashes];
  for (const ps of platformStashes) {
    if (!allStashes.some((s) => s.path === ps.path)) {
      allStashes.push(ps);
    }
  }

  // Build final config
  const newConfig: AkmConfig = {
    ...current,
    stashDir,
    embedding,
    llm,
    registries,
    stashes: allStashes.length > 0 ? allStashes : undefined,
    // Preserve existing fields
    semanticSearch: current.semanticSearch,
    installed: current.installed,
    output: current.output,
  };

  // Confirm before saving
  p.note(
    [
      `Stash directory:  ${stashDir}`,
      `Embedding:        ${embedding ? `${embedding.provider ?? "remote"} / ${embedding.model}` : "built-in local"}`,
      `LLM:              ${llm ? `${llm.provider ?? "remote"} / ${llm.model}` : "disabled"}`,
      `Registries:       ${registries.filter((r) => r.enabled !== false).length} enabled`,
      `Stash sources:    ${allStashes.length}`,
    ].join("\n"),
    "Configuration Summary",
  );

  const shouldSave = await p.confirm({
    message: "Save this configuration?",
    initialValue: true,
  });
  if (cancelled(shouldSave) || !shouldSave) bail();

  // Save config
  saveConfig(newConfig);

  // Initialize stash directory
  await akmInit({ dir: stashDir });

  // API key reminder
  if (embedding?.apiKey === undefined && embedding?.provider !== "ollama") {
    // Only remind about API keys for non-Ollama remote providers
    if (embedding?.endpoint && !embedding.endpoint.includes("localhost")) {
      p.log.info("Reminder: Set your embedding API key via the AKM_EMBED_API_KEY environment variable.");
    }
  }
  if (llm?.apiKey === undefined && llm?.provider !== "ollama") {
    if (llm?.endpoint && !llm.endpoint.includes("localhost")) {
      p.log.info("Reminder: Set your LLM API key via the AKM_LLM_API_KEY environment variable.");
    }
  }

  p.outro(`Configuration saved to ${configPath}\nRun \`akm index\` to build your search index.`);
}
