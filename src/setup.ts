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

// ── Constants ───────────────────────────────────────────────────────────────

const CONTEXT_HUB_URL = "https://github.com/andrewyng/context-hub";

// ── Helpers ─────────────────────────────────────────────────────────────────

function bail(): never {
  p.cancel("Setup cancelled. No changes were saved.");
  process.exit(0);
}

/**
 * Check if a prompt result was cancelled (Escape). If so, ask the user
 * whether they really want to quit. Returns true if the user chose to
 * stay (i.e. the caller should re-prompt), or calls bail() to exit.
 */
async function onCancel(value: unknown): Promise<boolean> {
  if (!p.isCancel(value)) return false;

  const confirmExit = await p.confirm({
    message: "Exit the wizard? No changes will be saved.",
    initialValue: false,
  });

  // Double-cancel or confirmed exit → leave
  if (p.isCancel(confirmExit) || confirmExit) {
    bail();
  }

  // User chose to stay
  return true;
}

/**
 * Run a prompt function in a loop, retrying if the user presses Escape
 * but decides to stay. Returns the non-cancelled result.
 */
async function prompt<T>(fn: () => Promise<T | symbol>): Promise<T> {
  for (;;) {
    const result = await fn();
    if (await onCancel(result)) continue;
    return result as T;
  }
}

// ── Steps ───────────────────────────────────────────────────────────────────

async function stepStashDir(current: AkmConfig): Promise<string> {
  const defaultDir = current.stashDir ?? getDefaultStashDir();

  const choice = await prompt(() =>
    p.select({
      message: "Where should akm store skills, commands, and other assets?",
      options: [
        { value: "default", label: defaultDir, hint: current.stashDir ? "current" : "default" },
        { value: "custom", label: "Enter a custom path..." },
      ],
    }),
  );

  if (choice === "default") return defaultDir;

  const customPath = await prompt(() =>
    p.text({
      message: "Enter the stash directory path:",
      placeholder: defaultDir,
      validate: (v) => {
        if (!v?.trim()) return "Path cannot be empty";
      },
    }),
  );

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
    // Preserve existing embedding/LLM config when Ollama is not available
    return { embedding: current.embedding, llm: current.llm };
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
    // Ask for dimension — different models produce different sizes
    const dimChoice = await prompt(() =>
      p.text({
        message: "Embedding dimension (must match your index; 384 is common for MiniLM/nomic):",
        placeholder: "384",
        defaultValue: "384",
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

  const llmChoice = await prompt(() =>
    p.select({
      message: "Use an LLM for richer metadata during indexing?",
      options: llmOptions,
      initialValue: allLlmCandidates.length > 0 ? allLlmCandidates[0] : "none",
    }),
  );

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

async function stepRegistries(current: AkmConfig): Promise<RegistryConfigEntry[] | undefined> {
  const defaults = DEFAULT_CONFIG.registries ?? [];
  const currentRegistries = current.registries ?? defaults;
  const defaultUrls = new Set(defaults.map((r) => r.url));
  const enabledUrls = new Set(currentRegistries.filter((r) => r.enabled !== false).map((r) => r.url));

  // Collect custom (non-default) registries to preserve them
  const customRegistries = currentRegistries.filter((r) => !defaultUrls.has(r.url));

  // Show default registries for toggling
  const options = defaults.map((r) => ({
    value: r.url,
    label: r.name ?? r.url,
    hint: r.provider ?? "static index",
  }));

  if (customRegistries.length > 0) {
    p.log.info(
      `You have ${customRegistries.length} custom registr${customRegistries.length === 1 ? "y" : "ies"} that will be preserved.`,
    );
  }

  const selected = await prompt(() =>
    p.multiselect({
      message: "Which built-in registries should be enabled?",
      options,
      initialValues: options.filter((o) => enabledUrls.has(o.value)).map((o) => o.value),
    }),
  );

  // If all defaults are selected and there are no custom registries,
  // return undefined to use the built-in defaults (avoids pinning)
  const allDefaultsSelected = defaults.every((r) => selected.includes(r.url));
  if (allDefaultsSelected && customRegistries.length === 0) {
    return undefined;
  }

  // Build explicit list: toggled defaults + preserved custom registries
  const result: RegistryConfigEntry[] = defaults.map((r) => ({
    ...r,
    enabled: selected.includes(r.url),
  }));

  // Re-add custom registries unchanged
  for (const custom of customRegistries) {
    result.push(custom);
  }

  return result;
}

async function stepStashSources(current: AkmConfig): Promise<StashConfigEntry[]> {
  const stashes: StashConfigEntry[] = [...(current.stashes ?? [])];

  // Check if context-hub is already configured
  const hasContextHub = stashes.some((s) => s.type === "context-hub" && s.url === CONTEXT_HUB_URL);

  if (stashes.length > 0) {
    p.log.info(`You have ${stashes.length} existing stash source(s).`);
  }

  // Context Hub toggle — simple on/off for the default context-hub
  if (!hasContextHub) {
    const enableContextHub = await prompt(() =>
      p.confirm({
        message: "Enable Context Hub? (community knowledge from github.com/andrewyng/context-hub)",
        initialValue: true,
      }),
    );

    if (enableContextHub) {
      stashes.push({ type: "context-hub", url: CONTEXT_HUB_URL, name: "context-hub" });
      p.log.success("Context Hub enabled.");
    }
  } else {
    p.log.info("Context Hub is already configured.");
  }

  // Additional stash sources loop
  let addMore = true;
  while (addMore) {
    const action = await prompt(() =>
      p.select({
        message: "Add another stash source?",
        options: [
          { value: "openviking", label: "OpenViking server", hint: "remote stash" },
          { value: "github-repo", label: "GitHub repository", hint: "via context-hub provider" },
          { value: "filesystem", label: "Filesystem path", hint: "local directory" },
          { value: "done", label: "Done — no more sources" },
        ],
      }),
    );

    if (action === "done") {
      addMore = false;
      break;
    }

    if (action === "openviking") {
      const url = await prompt(() =>
        p.text({
          message: "Enter the OpenViking server URL:",
          placeholder: "https://your-openviking-server.example.com",
          validate: (v) => {
            if (!v?.trim()) return "URL cannot be empty";
            if (!v.startsWith("http://") && !v.startsWith("https://")) return "URL must start with http:// or https://";
          },
        }),
      );

      const spin = p.spinner();
      spin.start("Checking OpenViking server...");
      const result = await detectOpenViking(url.trim());
      if (result.available) {
        spin.stop("Server is reachable");
      } else {
        spin.stop("Server not reachable — adding anyway (it may be temporarily down)");
      }

      const name = await prompt(() =>
        p.text({
          message: "Give this stash a name (optional):",
          placeholder: "my-openviking",
        }),
      );

      // Use the normalized URL from detection (trailing slashes stripped)
      const entry: StashConfigEntry = { type: "openviking", url: result.url };
      if (name.trim()) entry.name = name.trim();
      if (!stashes.some((s) => s.url === entry.url)) {
        stashes.push(entry);
      } else {
        p.log.warn("This URL is already configured.");
      }
    }

    if (action === "github-repo") {
      const url = await prompt(() =>
        p.text({
          message: "Enter the GitHub repository URL:",
          placeholder: "https://github.com/owner/repo",
          validate: (v) => {
            if (!v?.trim()) return "URL cannot be empty";
          },
        }),
      );

      const name = await prompt(() =>
        p.text({
          message: "Give this stash a name (optional):",
          placeholder: "my-repo",
        }),
      );

      const entry: StashConfigEntry = { type: "context-hub", url: url.trim() };
      if (name.trim()) entry.name = name.trim();
      if (!stashes.some((s) => s.url === entry.url)) {
        stashes.push(entry);
      } else {
        p.log.warn("This URL is already configured.");
      }
    }

    if (action === "filesystem") {
      const fsPath = await prompt(() =>
        p.text({
          message: "Enter the directory path:",
          placeholder: "/path/to/stash",
          validate: (v) => {
            if (!v?.trim()) return "Path cannot be empty";
          },
        }),
      );

      const resolved = fsPath.trim();
      const name = await prompt(() =>
        p.text({
          message: "Give this stash a name (optional):",
          placeholder: "my-stash",
        }),
      );

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

  const selected = await prompt(() =>
    p.multiselect({
      message: "Found agent platform configurations. Add as stash sources?",
      options: newPlatforms.map((pl) => ({
        value: pl.path,
        label: pl.name,
        hint: pl.path,
      })),
      required: false,
    }),
  );

  const entries: StashConfigEntry[] = [];
  for (const selectedPath of selected) {
    const platform = newPlatforms.find((pl) => pl.path === selectedPath);
    if (platform) {
      entries.push({
        type: "filesystem",
        path: platform.path,
        name: platform.name.toLowerCase().replace(/\s+/g, "-"),
      });
    }
  }
  return entries;
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
  const effectiveRegistries = registries ?? DEFAULT_CONFIG.registries ?? [];
  p.note(
    [
      `Stash directory:  ${stashDir}`,
      `Embedding:        ${embedding ? `${embedding.provider ?? "remote"} / ${embedding.model}` : "built-in local"}`,
      `LLM:              ${llm ? `${llm.provider ?? "remote"} / ${llm.model}` : "disabled"}`,
      `Registries:       ${effectiveRegistries.filter((r) => r.enabled !== false).length} enabled`,
      `Stash sources:    ${allStashes.length}`,
    ].join("\n"),
    "Configuration Summary",
  );

  const shouldSave = await prompt(() =>
    p.confirm({
      message: "Save this configuration?",
      initialValue: true,
    }),
  );
  if (!shouldSave) bail();

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
