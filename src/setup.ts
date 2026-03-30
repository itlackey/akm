/**
 * Interactive configuration wizard for akm.
 *
 * Walks users through service detection, embedding/LLM setup,
 * registry selection, stash sources, and agent platform discovery.
 * Collects all choices and writes config once at the end.
 */

import path from "node:path";
import * as p from "@clack/prompts";
import { isHttpUrl } from "./common";
import type {
  AkmConfig,
  EmbeddingConnectionConfig,
  LlmConnectionConfig,
  RegistryConfigEntry,
  StashConfigEntry,
} from "./config";
import { DEFAULT_CONFIG, getConfigPath, loadConfig, saveConfig } from "./config";
import { closeDatabase, isVecAvailable, openDatabase } from "./db";
import { detectAgentPlatforms, detectOllama, detectOpenViking } from "./detect";
import { checkEmbeddingAvailability, DEFAULT_LOCAL_MODEL, isTransformersAvailable } from "./embedder";
import { akmIndex } from "./indexer";
import { akmInit } from "./init";
import { getDefaultStashDir } from "./paths";
import { clearSemanticStatus, deriveSemanticProviderFingerprint, writeSemanticStatus } from "./semantic-status";

// ── Constants ───────────────────────────────────────────────────────────────

/** Recommended GitHub repositories shown during setup. */
const RECOMMENDED_GITHUB_REPOS: Array<{ url: string; name: string; hint: string }> = [
  {
    url: "https://github.com/andrewyng/context-hub",
    name: "context-hub",
    hint: "community knowledge",
  },
];

// Approximate first-download sizes used in the setup note.
// LOCAL_MODEL_APPROX_SIZE_MB tracks the default local model (DEFAULT_LOCAL_MODEL).
const LOCAL_MODEL_APPROX_SIZE_MB = 130;
// SQLITE_VEC_APPROX_SIZE_MB reflects the optional sqlite-vec install footprint.
const SQLITE_VEC_APPROX_SIZE_MB = 5;

// ── Helpers ─────────────────────────────────────────────────────────────────

function bail(): never {
  p.cancel("Setup cancelled. No changes were saved.");
  process.exit(0);
}

/**
 * Check if a prompt result was cancelled (Escape). If so, ask the user
 * whether they really want to quit. Returns true if the user chose to
 * stay (i.e. the caller should re-prompt), or calls bail() to exit.
 *
 * @internal Exported for testing only.
 */
export async function onCancel(value: unknown): Promise<boolean> {
  if (!p.isCancel(value)) return false;

  const confirmExit = await p.confirm({
    message: "Exit the wizard? No changes will be saved.",
    initialValue: false,
  });

  // Only exit when the user explicitly confirms "Yes".
  // Pressing Escape on the confirmation (isCancel) or choosing "No"
  // both mean "stay in the wizard".
  if (confirmExit === true) {
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

/**
 * Like `prompt`, but pressing Escape returns `null` instead of re-prompting.
 * Use inside sub-actions so the user can back out to the parent menu.
 */
async function promptOrBack<T>(fn: () => Promise<T | symbol>): Promise<T | null> {
  const result = await fn();
  if (p.isCancel(result)) return null;
  return result as T;
}

/**
 * Quick connectivity check. Returns true if we can reach a public
 * endpoint within 3 seconds, false otherwise. Used to skip network-
 * dependent setup steps gracefully when offline.
 *
 * @internal Exported for testing only.
 */
export async function isOnline(): Promise<boolean> {
  try {
    await fetch("https://dns.google", { signal: AbortSignal.timeout(3000) });
    return true;
  } catch {
    return false;
  }
}

function isRemoteEmbeddingConfig(embedding?: EmbeddingConnectionConfig): boolean {
  return isHttpUrl(embedding?.endpoint);
}

/**
 * @internal Exported for testing only.
 */
export function describeSemanticSearchAssets(embedding?: EmbeddingConnectionConfig): string[] {
  if (isRemoteEmbeddingConfig(embedding)) {
    return [
      `• Embedding endpoint: ${embedding?.provider ?? "custom"} / ${embedding?.model} (no local model download)`,
      `• sqlite-vec acceleration: optional native extension (~${SQLITE_VEC_APPROX_SIZE_MB} MB when installed separately)`,
    ];
  }

  return [
    `• Local embedding model: ${embedding?.localModel ?? DEFAULT_LOCAL_MODEL} (~${LOCAL_MODEL_APPROX_SIZE_MB} MB download on first use)`,
    `• sqlite-vec acceleration: optional native extension (~${SQLITE_VEC_APPROX_SIZE_MB} MB when installed separately)`,
  ];
}

interface SemanticSearchChoice {
  mode: "off" | "auto";
  prepareAssets: boolean;
}

export async function stepSemanticSearch(
  current: AkmConfig,
  embedding?: EmbeddingConnectionConfig,
): Promise<SemanticSearchChoice> {
  const enabled = await prompt(() =>
    p.confirm({
      message: "Enable semantic search?",
      initialValue: current.semanticSearchMode !== "off",
    }),
  );

  if (!enabled) {
    return { mode: "off", prepareAssets: false };
  }

  p.note(describeSemanticSearchAssets(embedding).join("\n"), "Semantic Search Assets");

  const prepareAssets = await prompt(() =>
    p.confirm({
      message: isRemoteEmbeddingConfig(embedding)
        ? "Check the embedding endpoint and verify semantic search now?"
        : "Download and verify semantic-search assets now?",
      initialValue: true,
    }),
  );

  return { mode: "auto", prepareAssets };
}

async function prepareSemanticSearchAssets(
  config: AkmConfig,
): Promise<{ ok: true } | { ok: false; message: string; reason: string }> {
  const remote = isRemoteEmbeddingConfig(config.embedding);

  // For local embeddings, ensure the required package is installed first.
  if (!remote) {
    if (!(await isTransformersAvailable())) {
      const spin = p.spinner();
      spin.start("Installing @huggingface/transformers...");
      try {
        const pkgRoot = path.resolve(import.meta.dir, "..");
        const proc = Bun.spawn(["bun", "add", "@huggingface/transformers"], {
          cwd: pkgRoot,
          stdout: "pipe",
          stderr: "pipe",
        });
        await proc.exited;
        if (proc.exitCode !== 0) {
          const stderr = await new Response(proc.stderr).text();
          throw new Error(stderr || `exit code ${proc.exitCode}`);
        }
        spin.stop("@huggingface/transformers installed.");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        spin.stop("Could not install @huggingface/transformers.");
        p.log.warn(
          `Automatic install failed: ${msg}\n` +
            "Install it manually with: bun add @huggingface/transformers\n" +
            "Then re-run `akm setup` or `akm index --full --verbose`.",
        );
        return { ok: false, reason: "missing-package", message: `Automatic install failed: ${msg}` };
      }
    }
  }

  const spin = p.spinner();
  spin.start(
    remote
      ? "Checking remote embedding endpoint..."
      : `Downloading local embedding model (${config.embedding?.localModel ?? DEFAULT_LOCAL_MODEL})...`,
  );

  const result = await checkEmbeddingAvailability(config.embedding);
  if (!result.available) {
    spin.stop("Semantic-search assets could not be prepared.");
    if (result.reason === "remote-unreachable") {
      p.log.warn(
        "The remote embedding endpoint is not reachable. Check your endpoint and credentials, then retry `akm index --full --verbose`.",
      );
      return { ok: false, reason: "remote-network", message: "The remote embedding endpoint is not reachable." };
    } else if (result.reason === "missing-package") {
      p.log.warn(
        "@huggingface/transformers is not installed. Install it with: bun add @huggingface/transformers\n" +
          "Then re-run `akm setup` or `akm index --full --verbose`.",
      );
      return { ok: false, reason: "missing-package", message: "@huggingface/transformers is not installed." };
    } else {
      p.log.warn(
        `The local embedding model could not be downloaded: ${result.message}\n` +
          "Retry `akm index --full --verbose` after confirming local model downloads are permitted.",
      );
      return { ok: false, reason: "local-model-download", message: result.message };
    }
  }

  spin.stop(remote ? "Remote embedding endpoint is ready." : "Local embedding model downloaded and ready.");

  let db: ReturnType<typeof openDatabase> | undefined;
  try {
    db = openDatabase();
    if (isVecAvailable(db)) {
      p.log.info("sqlite-vec is available for fast vector search.");
    } else {
      p.log.info(
        "sqlite-vec is not available. Semantic search will use the JS fallback until the optional extension is installed.",
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    p.log.warn(
      `Could not open the local database or check for sqlite-vec. Semantic search will use the JS fallback. (${message})\n` +
        "Check file permissions and available disk space in the cache directory, or run `akm index --full --verbose` to diagnose.",
    );
  } finally {
    if (db) closeDatabase(db);
  }

  return { ok: true };
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
    // Ask for dimension — different models produce different sizes.
    // Common dimensions: nomic-embed-text=768, mxbai-embed-large=1024,
    // all-minilm/bge-small=384. Default based on selected model.
    const knownDims: Record<string, number> = {
      nomic: 768,
      mxbai: 1024,
      minilm: 384,
      bge: 384,
    };
    const guessedDim = Object.entries(knownDims).find(([k]) => embChoice.includes(k))?.[1] ?? 384;
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

/**
 * @internal Exported for testing only.
 */
export async function stepStashSources(current: AkmConfig): Promise<StashConfigEntry[]> {
  const stashes: StashConfigEntry[] = [...(current.stashes ?? [])];

  if (stashes.length > 0) {
    p.log.info(`You have ${stashes.length} existing stash source(s).`);
  }

  // ── Recommended GitHub repos ───────────────────────────────────────────
  const existingUrls = new Set(stashes.map((s) => s.url));

  const repoOptions = RECOMMENDED_GITHUB_REPOS.map((r) => ({
    value: r.url,
    label: r.name,
    hint: existingUrls.has(r.url) ? `${r.hint} (already added)` : r.hint,
  }));

  const selectedRepos = await prompt(() =>
    p.multiselect({
      message: "Recommended GitHub repositories — toggle to add or remove:",
      options: repoOptions,
      initialValues: repoOptions.filter((o) => existingUrls.has(o.value)).map((o) => o.value),
      required: false,
    }),
  );

  // Add newly selected repos
  for (const url of selectedRepos) {
    if (!existingUrls.has(url)) {
      const rec = RECOMMENDED_GITHUB_REPOS.find((r) => r.url === url);
      stashes.push({ type: "github", url, name: rec?.name });
      existingUrls.add(url);
    }
  }

  // Remove deselected repos that were previously configured
  for (const rec of RECOMMENDED_GITHUB_REPOS) {
    if (existingUrls.has(rec.url) && !selectedRepos.includes(rec.url)) {
      const idx = stashes.findIndex((s) => s.url === rec.url);
      if (idx !== -1) {
        stashes.splice(idx, 1);
        existingUrls.delete(rec.url);
        p.log.info(`Removed ${rec.name}.`);
      }
    }
  }

  // ── Additional stash sources loop ──────────────────────────────────────
  let addMore = true;
  while (addMore) {
    const action = await prompt(() =>
      p.select({
        message: "Add another stash source?",
        options: [
          { value: "openviking", label: "OpenViking server", hint: "remote stash" },
          { value: "github-repo", label: "GitHub repository", hint: "custom URL" },
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
      const url = await promptOrBack(() =>
        p.text({
          message: "Enter the OpenViking server URL:",
          placeholder: "https://your-openviking-server.example.com",
          validate: (v) => {
            if (!v?.trim()) return "URL cannot be empty";
            if (!v.startsWith("http://") && !v.startsWith("https://")) return "URL must start with http:// or https://";
          },
        }),
      );
      if (url === null) continue;

      const spin = p.spinner();
      spin.start("Checking OpenViking server...");
      const result = await detectOpenViking(url.trim());
      if (result.available) {
        spin.stop("Server is reachable");
      } else {
        spin.stop("Server not reachable — adding anyway (it may be temporarily down)");
      }

      const name = await promptOrBack(() =>
        p.text({
          message: "Give this stash a name (optional):",
          placeholder: "my-openviking",
        }),
      );
      if (name === null) continue;

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
      const url = await promptOrBack(() =>
        p.text({
          message: "Enter the GitHub repository URL:",
          placeholder: "https://github.com/owner/repo",
          validate: (v) => {
            if (!v?.trim()) return "URL cannot be empty";
          },
        }),
      );
      if (url === null) continue;

      const name = await promptOrBack(() =>
        p.text({
          message: "Give this stash a name (optional):",
          placeholder: "my-repo",
        }),
      );
      if (name === null) continue;

      const entry: StashConfigEntry = { type: "github", url: url.trim() };
      if (name.trim()) entry.name = name.trim();
      if (!stashes.some((s) => s.url === entry.url)) {
        stashes.push(entry);
      } else {
        p.log.warn("This URL is already configured.");
      }
    }

    if (action === "filesystem") {
      const fsPath = await promptOrBack(() =>
        p.text({
          message: "Enter the directory path:",
          placeholder: "/path/to/stash",
          validate: (v) => {
            if (!v?.trim()) return "Path cannot be empty";
          },
        }),
      );
      if (fsPath === null) continue;

      const resolved = fsPath.trim();
      const name = await promptOrBack(() =>
        p.text({
          message: "Give this stash a name (optional):",
          placeholder: "my-stash",
        }),
      );
      if (name === null) continue;

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

  // Quick connectivity check — skip network-dependent steps when offline
  const online = await isOnline();
  if (!online) {
    p.log.warn(
      "No network connectivity detected. Skipping Ollama detection and remote embedding checks.\n" +
        "Local-only setup will continue. Re-run `akm setup` when online for full configuration.",
    );
  }

  // Step 2: Ollama / Embedding / LLM
  p.log.step("Step 2: Embedding & LLM");
  const { embedding, llm } = online ? await stepOllama(current) : { embedding: current.embedding, llm: current.llm };

  // Step 3: Semantic search assets
  p.log.step("Step 3: Semantic Search");
  const semanticSearchMode = await stepSemanticSearch(current, embedding);

  // Step 4: Registries
  p.log.step("Step 4: Registries");
  const registries = await stepRegistries(current);

  // Step 5: Stash sources
  p.log.step("Step 5: Stash Sources");
  const stashes = await stepStashSources(current);

  // Step 6: Agent platform detection
  p.log.step("Step 6: Agent Platform Detection");
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
    semanticSearchMode: semanticSearchMode.mode,
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
      `Semantic search:  ${semanticSearchMode.mode}`,
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

  if (semanticSearchMode.mode === "off") {
    clearSemanticStatus();
  }

  if (semanticSearchMode.mode === "auto") {
    if (semanticSearchMode.prepareAssets) {
      const ready = await prepareSemanticSearchAssets(newConfig);
      if (!ready.ok) {
        writeSemanticStatus({
          status: "blocked",
          reason: ready.reason as never,
          message: ready.message,
          providerFingerprint: deriveSemanticProviderFingerprint(newConfig.embedding),
          lastCheckedAt: new Date().toISOString(),
        });
        p.log.warn(
          "Semantic search remains set to auto, but is currently blocked. Re-run `akm index --full --verbose` once the issue is resolved.",
        );
      } else {
        writeSemanticStatus({
          status: "pending",
          message: "Semantic prerequisites verified. Building the index to finish activation.",
          providerFingerprint: deriveSemanticProviderFingerprint(newConfig.embedding),
          lastCheckedAt: new Date().toISOString(),
        });
      }
    } else {
      writeSemanticStatus({
        status: "pending",
        message: "Semantic search is enabled, but asset preparation was skipped.",
        providerFingerprint: deriveSemanticProviderFingerprint(newConfig.embedding),
        lastCheckedAt: new Date().toISOString(),
      });
      p.log.info(
        "Semantic search is set to auto, but asset preparation was skipped. Run `akm index --full --verbose` later to verify it.",
      );
    }
  }

  // Build search index
  p.log.info("Building search index...");
  const spin = p.spinner();
  spin.start("Building search index...");
  try {
    const indexResult = await akmIndex({ stashDir });
    spin.stop(`Indexed ${indexResult.totalEntries} assets.`);
    if (newConfig.semanticSearchMode === "auto") {
      if (indexResult.verification.ok) {
        p.log.success(indexResult.verification.message);
      } else {
        p.log.warn(indexResult.verification.message);
        if (indexResult.verification.guidance) {
          p.log.info(indexResult.verification.guidance);
        }
      }
    }
  } catch (err) {
    spin.stop("Indexing failed — you can run `akm index` manually later.");
    p.log.warn(String(err));
    if (newConfig.semanticSearchMode === "auto") {
      writeSemanticStatus({
        status: "blocked",
        reason: "index-failed",
        message: String(err),
        providerFingerprint: deriveSemanticProviderFingerprint(newConfig.embedding),
        lastCheckedAt: new Date().toISOString(),
      });
    }
  }

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

  p.outro(`Configuration saved to ${configPath}`);
}
