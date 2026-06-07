// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Interactive configuration wizard for akm.
 *
 * Walks users through service detection, embedding/LLM setup,
 * registry selection, stash sources, and agent platform discovery.
 * Collects all choices and writes config once at the end.
 */

import { promises as dnsPromises } from "node:dns";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as p from "@clack/prompts";
import { detectServerDefault, isCiEnvironment, registerDefaultTasks } from "../commands/default-tasks";
import { akmInit, type InitResponse } from "../commands/init";
import { akmTasksAdd, akmTasksList, akmTasksSetEnabled, akmTasksSync } from "../commands/tasks";
import { isHttpUrl } from "../core/common";
import type {
  AkmConfig,
  EmbeddingConnectionConfig,
  LlmConnectionConfig,
  OutputConfig,
  RegistryConfigEntry,
  SourceConfigEntry,
} from "../core/config";
import {
  DEFAULT_CONFIG,
  getDefaultLlmConfig,
  getEffectiveRegistries,
  loadUserConfig,
  saveConfig,
} from "../core/config";
import { backupExistingConfig } from "../core/config-io";
import { ConfigError, UsageError } from "../core/errors";
import { assertSafeStashDir, getConfigPath, getDefaultStashDir, isTransientStashPath } from "../core/paths";
import { warn } from "../core/warn";
import { closeDatabase, isVecAvailable, openDatabase } from "../indexer/db";
import { akmIndex } from "../indexer/indexer";
import {
  clearSemanticStatus,
  deriveSemanticProviderFingerprint,
  writeSemanticStatus,
} from "../indexer/semantic-status";
import { type AgentDetectionResult, detectAgentCliProfiles, pickDefaultAgentProfile } from "../integrations/agent";
import { probeLlmCapabilities } from "../llm/client";
import { checkEmbeddingAvailability, DEFAULT_LOCAL_MODEL, isTransformersAvailable } from "../llm/embedder";
import { saveGitStash } from "../sources/providers/git";
import { backendNameForPlatform } from "../tasks/backends";
import { type EmbeddedTask, listEmbeddedTasks } from "../tasks/embedded";
import { parseSchedule } from "../tasks/schedule";
import {
  type DetectedEnvironment,
  detectAgentPlatforms,
  detectEnvironment,
  detectLMStudio,
  detectOllama,
  type LMStudioDetectionResult,
  renderDetectionSummary,
} from "./detect";
import { detectHarnessConfigs, type HarnessLLMConfig } from "./harness-config-import";
import { loadSetupStashes } from "./registry-stash-loader";
import { createSetupContext, runSetupSteps, type SetupStep } from "./steps";

// ── Setup sandbox guard ─────────────────────────────────────────────────────

/**
 * Refuse to persist an explicit `--dir /tmp/...` stashDir to the user's
 * config. The OS may reap the directory at any time, and the next run will
 * see a `stashDir` that points at a deleted path (falling back to ~/akm
 * silently). Mirrors the `assertInitSandbox` check in commands/init.ts, but
 * fires under all runtimes (not just `bun test`) because `akm setup --dir
 * /tmp/X` is a documented isolation pattern that has been observed to
 * silently clobber the host config — see
 * `docs/technical/incidents/2026-05-23-setup-clobbers-user-config.md`.
 *
 * Escape hatch: set `AKM_FORCE_SETUP_TMP_STASH=1` to override. When the
 * escape hatch is on, `applyStashIsolationToEnv` below also pre-sets
 * `AKM_STASH_DIR` so that the `getConfigDir` / `getCacheDir` isolation
 * rules fire and config + cache writes route into `$stashDir/.akm/`
 * instead of the user's host `~/.config/akm`.
 */
function assertSetupSandbox(stashDir: string, dirExplicitlyProvided: boolean): void {
  if (!dirExplicitlyProvided) return;
  if (process.env.AKM_FORCE_SETUP_TMP_STASH === "1") return;
  if (!isTransientStashPath(stashDir)) return;
  throw new ConfigError(
    `refusing to run \`akm setup --dir ${stashDir}\`: the path is in a transient/sandbox directory family the OS may reap. ` +
      "Persisting it as the user's stashDir would leave the next run pointing at a deleted path (silently falling back to ~/akm). " +
      "Use a persistent directory, OR set AKM_FORCE_SETUP_TMP_STASH=1 if you intentionally want a sandbox setup " +
      "(setup will also auto-isolate config + cache writes into $stashDir/.akm/ so the host config is preserved).",
    "SETUP_TMP_STASH_REFUSED",
  );
}

/**
 * Propagate the explicit `--dir <stashDir>` choice to the env so that the
 * `getConfigDir` / `getCacheDir` isolation rules in `src/core/paths.ts`
 * actually fire for the duration of this setup run. Without this, a CLI
 * caller who passes `--dir /tmp/X` but doesn't pre-export `AKM_STASH_DIR`
 * would still write config to the host `~/.config/akm/config.json`. We
 * only set the env var when:
 *   - `--dir` was explicitly provided (we have an operator-stated stash), AND
 *   - `AKM_STASH_DIR` is not already set (caller's explicit env wins).
 * The set is process-wide; for the CLI that's the right scope (the process
 * is about to do all its work against this stash). For tests, each test
 * already isolates env via beforeEach/afterEach so there is no leak.
 */
function applyStashIsolationToEnv(stashDir: string, dirExplicitlyProvided: boolean): void {
  if (!dirExplicitlyProvided) return;
  if (process.env.AKM_STASH_DIR?.trim()) return;
  process.env.AKM_STASH_DIR = stashDir;
}

// ── Interfaces ──────────────────────────────────────────────────────────────

export interface SetupSummary {
  configPath: string;
  stashDir: string;
  stashCreated: boolean;
  written: boolean;
  fields: string[];
  ripgrep?: InitResponse["ripgrep"];
}

// ── 0.8.0 config-shape helpers ──────────────────────────────────────────────

/**
 * Snapshot used by the setup wizard's internal logic — the legacy mental
 * model of a single top-level `llm` + `agent` block. Translated to the new
 * `profiles.*` + `defaults.*` shape when written via {@link applyLegacyLlm}
 * and {@link applyLegacyAgent}.
 */
interface LegacyAgentBlockShape {
  default?: string;
  timeoutMs?: number;
  profiles?: Record<
    string,
    { sdkMode?: boolean; model?: string; endpoint?: string; apiKey?: string; bin?: string; args?: string[] }
  >;
}

/** Read the currently-configured LLM connection from a loaded config. */
function getCurrentLlm(config: AkmConfig): LlmConnectionConfig | undefined {
  return getDefaultLlmConfig(config);
}

/** Read a synthesised legacy-shape agent block from the new-shape AkmConfig. */
function getCurrentAgentBlock(config: AkmConfig): LegacyAgentBlockShape | undefined {
  if (!config.profiles?.agent && !config.defaults?.agent) return undefined;
  const block: LegacyAgentBlockShape = {};
  if (config.defaults?.agent) block.default = config.defaults.agent;
  if (config.profiles?.agent) {
    const profiles: NonNullable<LegacyAgentBlockShape["profiles"]> = {};
    for (const [name, raw] of Object.entries(config.profiles.agent)) {
      profiles[name] = {
        ...(raw.platform === "opencode-sdk" ? { sdkMode: true } : {}),
        ...(raw.model ? { model: raw.model } : {}),
        ...(raw.bin ? { bin: raw.bin } : {}),
        ...(raw.args ? { args: raw.args } : {}),
      };
    }
    block.profiles = profiles;
  }
  return block;
}

/** Apply an LLM connection patch onto the new-shape config. */
function applyLegacyLlm(config: AkmConfig, llm: LlmConnectionConfig | undefined): Partial<AkmConfig> {
  if (!llm) {
    // Clear the default LLM profile.
    const name = config.defaults?.llm ?? "default";
    const remaining = { ...(config.profiles?.llm ?? {}) };
    delete remaining[name];
    return {
      profiles: { ...(config.profiles ?? {}), llm: remaining },
      defaults: { ...(config.defaults ?? {}), llm: undefined },
    };
  }
  const name = config.defaults?.llm ?? "default";
  return {
    profiles: {
      ...(config.profiles ?? {}),
      llm: { ...(config.profiles?.llm ?? {}), [name]: llm },
    },
    defaults: { ...(config.defaults ?? {}), llm: name },
  };
}

/** Apply a legacy-shape agent block onto the new-shape config. */
function applyLegacyAgent(config: AkmConfig, agent: LegacyAgentBlockShape | undefined): Partial<AkmConfig> {
  if (!agent) {
    return {
      profiles: { ...(config.profiles ?? {}), agent: undefined },
      defaults: { ...(config.defaults ?? {}), agent: undefined },
    };
  }
  const v2Profiles: NonNullable<AkmConfig["profiles"]>["agent"] = { ...(config.profiles?.agent ?? {}) };
  for (const [name, profile] of Object.entries(agent.profiles ?? {})) {
    const platform: "opencode" | "claude" | "opencode-sdk" = profile.sdkMode
      ? "opencode-sdk"
      : name.toLowerCase().includes("claude")
        ? "claude"
        : "opencode";
    v2Profiles[name] = {
      platform,
      ...(profile.bin ? { bin: profile.bin } : {}),
      ...(profile.args ? { args: profile.args } : {}),
      ...(profile.model ? { model: profile.model } : {}),
    };
  }
  return {
    profiles: { ...(config.profiles ?? {}), agent: v2Profiles },
    defaults: { ...(config.defaults ?? {}), agent: agent.default },
  };
}

// ── Constants ───────────────────────────────────────────────────────────────

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

function configuredSourceKey(source: SourceConfigEntry): string {
  return `${source.type}:${source.path ?? source.url ?? source.name ?? "unknown"}`;
}

type ConfiguredSourceOption = {
  value: string;
  label: string;
  hint: string;
};

function describeConfiguredSource(source: SourceConfigEntry): ConfiguredSourceOption {
  const target = source.path ?? source.url ?? "(unknown target)";
  const typeLabel = source.type === "git" ? "Git" : source.type === "filesystem" ? "Filesystem" : source.type;
  return {
    value: configuredSourceKey(source),
    label: source.name ?? target,
    hint: `${typeLabel}: ${target}`,
  };
}

function renderConfiguredSourceList(sources: SourceConfigEntry[]): string {
  return sources
    .map((source) => {
      const described = describeConfiguredSource(source);
      return `- ${described.label} (${described.hint})`;
    })
    .join("\n");
}

function renderInstalledSourceList(installed: NonNullable<AkmConfig["installed"]>): string {
  return installed.map((entry) => `- ${entry.id} (${entry.source})`).join("\n");
}

function cloneLlmConfig(llm?: LlmConnectionConfig): LlmConnectionConfig | undefined {
  if (!llm) return undefined;
  return {
    ...llm,
    ...(llm.capabilities ? { capabilities: { ...llm.capabilities } } : {}),
    ...(llm.extraParams ? { extraParams: { ...llm.extraParams } } : {}),
  };
}

async function stepAdditionalSources(currentSources: SourceConfigEntry[]): Promise<SourceConfigEntry[]> {
  const sources = [...currentSources];

  let addMore = true;
  while (addMore) {
    const action = await prompt(() =>
      p.select({
        message: "Add another stash source?",
        options: [
          { value: "done", label: "Done — no more sources" },
          { value: "github-repo", label: "GitHub repository", hint: "custom URL" },
          { value: "filesystem", label: "Filesystem path", hint: "local directory" },
        ],
        initialValue: "done",
      }),
    );

    if (action === "done") {
      addMore = false;
      break;
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

      const entry: SourceConfigEntry = { type: "git", url: url.trim() };
      if (name.trim()) entry.name = name.trim();
      if (!sources.some((s) => s.url === entry.url)) {
        sources.push(entry);
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

      const entry: SourceConfigEntry = { type: "filesystem", path: resolved };
      if (name.trim()) entry.name = name.trim();
      if (!sources.some((s) => s.path === entry.path)) {
        sources.push(entry);
      } else {
        p.log.warn("This path is already configured.");
      }
    }
  }

  return sources;
}

/**
 * Quick connectivity check. Returns true if we can resolve a hostname
 * the user has already implicitly trusted within 3 seconds, false
 * otherwise. Used to skip network-dependent setup steps gracefully
 * when offline.
 *
 * We use a DNS lookup against `github.com` rather than an HTTP request
 * because (1) it doesn't actually send a request to anyone we aren't
 * already talking to (the user got akm from GitHub and `akm upgrade`
 * polls api.github.com), and (2) DNS is the right layer for "do we have
 * working network" without making the user opt into yet another remote.
 * The previous implementation pinged https://dns.google which
 * contradicted the spirit of "no remote endpoints akm doesn't own."
 *
 * @internal Exported for testing only.
 */
export async function isOnline(): Promise<boolean> {
  try {
    await Promise.race([
      dnsPromises.lookup("github.com"),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("dns lookup timed out")), 3000).unref()),
    ]);
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
    if (!isTransformersAvailable()) {
      const spin = p.spinner();
      spin.start("Installing @huggingface/transformers...");
      try {
        const pkgRoot = path.resolve(import.meta.dir, "../..");
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
  let probeDir: string | undefined;
  try {
    probeDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-setup-vec-probe-"));
    db = openDatabase(
      path.join(probeDir, "probe.db"),
      config.embedding?.dimension ? { embeddingDim: config.embedding.dimension } : undefined,
    );
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
    if (probeDir) {
      try {
        fs.rmSync(probeDir, { recursive: true, force: true });
      } catch {
        /* ignore cleanup failure */
      }
    }
  }

  return { ok: true };
}

// ── Steps ───────────────────────────────────────────────────────────────────

async function stepStashDir(
  current: AkmConfig,
  options?: { nonInteractive?: boolean; preferredDir?: string },
): Promise<string> {
  const defaultDir = options?.preferredDir ?? current.stashDir ?? getDefaultStashDir();

  if (options?.nonInteractive) {
    return defaultDir;
  }

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
        try {
          assertSafeStashDir(v.trim());
        } catch (err) {
          if (err instanceof Error) return err.message;
          return "Refused: unsafe stash directory";
        }
      },
    }),
  );

  return customPath.trim();
}

interface OllamaChoices {
  embedding?: EmbeddingConnectionConfig;
  /** Detected Ollama endpoint, surfaced to the LLM step so it can offer Ollama as a preset. */
  ollamaEndpoint?: string;
  /** Detected Ollama chat-capable model names. */
  ollamaChatModels?: string[];
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
  const currentLlm = getCurrentLlm(current);
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

  if (choice === "keep") return cloneLlmConfig(currentLlm);
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
    const llmConfig: LlmConnectionConfig = {
      endpoint: harness.baseUrl ?? "",
      model: harness.model ?? "",
      temperature: 0.3,
      maxTokens: 1024,
    };
    if (harness.provider) llmConfig.provider = harness.provider as LlmConnectionConfig["provider"];
    if (harness.baseUrl) llmConfig.endpoint = harness.baseUrl;
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

export async function stepRegistries(current: AkmConfig): Promise<RegistryConfigEntry[] | undefined> {
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
export async function stepAddSources(
  current: AkmConfig,
  options?: { promptForAdditional?: boolean },
): Promise<SourceConfigEntry[]> {
  const existingSources: SourceConfigEntry[] = [...(current.sources ?? [])];
  const sources: SourceConfigEntry[] = [];

  if (existingSources.length > 0) {
    p.note(renderConfiguredSourceList(existingSources), "Configured stash sources");
    const options = existingSources.map(describeConfiguredSource);
    const selected = await prompt(() =>
      p.multiselect({
        message: "Configured stash sources — uncheck any you want to disable:",
        options,
        initialValues: options.map((option) => option.value),
        required: false,
      }),
    );

    for (const source of existingSources) {
      if (selected.includes(configuredSourceKey(source))) {
        sources.push(source);
      }
    }
  }

  if ((current.installed?.length ?? 0) > 0) {
    p.note(renderInstalledSourceList(current.installed ?? []), "Installed managed stashes (preserved)");
  }

  // ── Registry-driven stash recommendations ─────────────────────────────
  // Fetch available stashes from the official registry (cached, stale-ok).
  // Falls back to the bundled list when the registry is unreachable.
  const registryUrl =
    getEffectiveRegistries(current)[0]?.url ??
    "https://raw.githubusercontent.com/itlackey/akm-registry/main/index.json";

  const availableStashes = await loadSetupStashes(registryUrl);

  if (availableStashes.length > 0) {
    const existingUrls = new Set(sources.map((s) => s.url));

    const stashOptions = availableStashes.map((s) => ({
      value: s.url,
      label: s.name,
      hint: existingUrls.has(s.url) ? `${s.description} (already added)` : s.description || s.source,
    }));

    // Pre-check: already-installed stashes OR default-selected on fresh install
    const initialValues =
      sources.length > 0
        ? stashOptions.filter((o) => existingUrls.has(o.value)).map((o) => o.value)
        : availableStashes.filter((s) => s.defaultSelected).map((s) => s.url);

    const selectedUrls = await prompt(() =>
      p.multiselect({
        message:
          availableStashes[0]?.source === "registry"
            ? "Available stashes from the AKM registry — toggle to add or remove:"
            : "Recommended stash sources — toggle to add or remove:",
        options: stashOptions,
        initialValues,
        required: false,
      }),
    );

    // Add newly selected stashes
    for (const url of selectedUrls) {
      if (!existingUrls.has(url)) {
        const entry = availableStashes.find((s) => s.url === url);
        sources.push({ type: "git", url, name: entry?.name });
        existingUrls.add(url);
      }
    }

    // Remove deselected stashes that were previously configured
    for (const entry of availableStashes) {
      if (existingUrls.has(entry.url) && !selectedUrls.includes(entry.url)) {
        const idx = sources.findIndex((s) => s.url === entry.url);
        if (idx !== -1) {
          sources.splice(idx, 1);
          existingUrls.delete(entry.url);
          p.log.info(`Removed ${entry.name}.`);
        }
      }
    }
  }

  if (options?.promptForAdditional === false) {
    return sources;
  }

  return stepAdditionalSources(sources);
}

async function stepAgentPlatforms(current: AkmConfig): Promise<SourceConfigEntry[]> {
  const platforms = detectAgentPlatforms();

  if (platforms.length === 0) {
    p.log.info("No agent platform configurations detected.");
    return [];
  }

  const existingPaths = new Set((current.sources ?? []).map((s) => s.path));

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

  const entries: SourceConfigEntry[] = [];
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

  const currentLlmSmall = getCurrentLlm(current);
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
    return { llm: cloneLlmConfig(currentLlmSmall), skipped: false, ollamaEndpoint };
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
        message: "API key (optional — press Enter to skip):",
        placeholder: "",
      }),
    );
    llm = {
      provider: "custom",
      endpoint: endpoint.trim(),
      model: model.trim(),
      temperature: 0.3,
      maxTokens: 1024,
      ...(apiKeyInput?.trim() ? { apiKey: apiKeyInput.trim() } : {}),
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
): Promise<LegacyAgentBlockShape | undefined> {
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
  const currentAgentBlock = getCurrentAgentBlock(current);
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
      : currentAgentBlock.profiles?.default?.model
        ? `SDK: ${currentAgentBlock.profiles.default.model}`
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
      const profileName = smallModel.llm.provider ?? "default";
      // Pre-populate from existing agent profile for this provider, if any.
      const existingAgentModel = currentAgentBlock?.profiles?.[profileName]?.model ?? smallModel.llm.model ?? undefined;
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
        profiles: {
          ...(currentAgentBlock?.profiles ?? {}),
          [profileName]: {
            ...(currentAgentBlock?.profiles?.[profileName] ?? {}),
            sdkMode: true,
            model: agentModel.trim(),
            endpoint: smallModel.llm.endpoint,
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
  const currentCustomAgentProfile = currentAgentBlock?.profiles?.custom;
  const currentNewEndpoint = currentCustomAgentProfile?.endpoint ?? undefined;
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
      message: "API key (optional — press Enter to skip):",
      placeholder: "",
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

  const customProfile = {
    sdkMode: true,
    endpoint: newEndpoint.trim(),
    model: newModel.trim(),
    ...(newApiKeyInput?.trim() ? { apiKey: newApiKeyInput.trim() } : {}),
  };

  return {
    ...(currentAgentBlock ?? {}),
    profiles: {
      ...(currentAgentBlock?.profiles ?? {}),
      custom: customProfile,
    },
    default: "custom",
  };
}

/**
 * Print a feature capability summary after both connection steps are complete.
 */
function printCapabilitySummary(smallModelSkipped: boolean, agentConfigured: boolean): void {
  const lines: string[] = ["Setup complete. Here's what's enabled:", ""];
  lines.push("  ✓ akm search, akm curate, akm show — always available");

  if (!smallModelSkipped) {
    lines.push("  ✓ akm index, akm distill, akm remember — small model configured");
  } else {
    lines.push("  ✗ akm index, akm distill, akm remember — run `akm setup` to enable");
  }

  if (agentConfigured) {
    lines.push("  ✓ akm propose, akm improve, akm tasks — agent configured");
  } else {
    lines.push("  ✗ akm propose, akm improve, akm tasks — run `akm setup` to enable");
  }

  p.note(lines.join("\n"), "Feature Summary");
}

// ── Agent CLI detection step (v1 spec §12.3) ────────────────────────────────

/**
 * Result of the agent CLI detection step. The wizard surfaces this to the
 * caller so the consolidated config write at the end of setup can persist
 * the new `agent` block.
 *
 * @internal Exported for testing only.
 */
export interface AgentSetupResult {
  /** Updated agent config block, or `undefined` if the user has nothing installed and no existing block. */
  agent?: LegacyAgentBlockShape;
  /** Per-profile detection results, available to the UI for display. */
  detections: AgentDetectionResult[];
}

export async function stepAgentSelection(
  current: AkmConfig,
  detections: AgentDetectionResult[],
): Promise<LegacyAgentBlockShape | undefined> {
  const currentAgentBlock = getCurrentAgentBlock(current);
  const available = detections.filter((d) => d.available);
  if (available.length === 0) {
    return currentAgentBlock;
  }

  const initialValue = pickDefaultAgentProfile(detections, currentAgentBlock?.default) ?? available[0]?.name;
  const selectedDefault = await prompt(() =>
    p.select({
      message: "Which detected agent CLI should be the default?",
      options: [
        ...available.map((d) => ({
          value: d.name,
          label: d.name,
          hint: d.resolvedPath ?? d.bin,
        })),
        { value: "disabled", label: "Disabled", hint: "do not configure a default agent CLI" },
      ],
      initialValue,
    }),
  );

  if (selectedDefault === "disabled") {
    if (!currentAgentBlock?.profiles && !currentAgentBlock?.timeoutMs) {
      return undefined;
    }
    return {
      ...(currentAgentBlock ?? {}),
      default: undefined,
    };
  }

  return {
    ...(currentAgentBlock ?? {}),
    default: selectedDefault,
  };
}

export async function stepOutputConfig(current: AkmConfig): Promise<OutputConfig> {
  const defaultOutput = current.output ?? DEFAULT_CONFIG.output ?? { format: "json", detail: "brief" };
  const format = await prompt(() =>
    p.select({
      message: "Default output format?",
      options: [
        { value: "json", label: "json", hint: "structured default" },
        { value: "text", label: "text", hint: "human-readable CLI output" },
        { value: "yaml", label: "yaml", hint: "structured text" },
      ],
      initialValue: defaultOutput.format ?? "json",
    }),
  );
  const detail = await prompt(() =>
    p.select({
      message: "Default output detail level?",
      options: [
        { value: "brief", label: "brief", hint: "compact summaries" },
        { value: "normal", label: "normal", hint: "balanced detail" },
        { value: "full", label: "full", hint: "max available detail" },
      ],
      initialValue: defaultOutput.detail ?? "brief",
    }),
  );

  return { format: format as OutputConfig["format"], detail: detail as OutputConfig["detail"] };
}

/**
 * Detect installed agent CLIs and produce an updated `agent` config block
 * with a sensible `default` (the first detected profile that the user has
 * not already overridden).
 *
 * Pure-ish: file system / PATH probes are routed through `detectFn` so
 * tests can drive the branches without touching the real PATH.
 *
 * @internal Exported for testing only.
 */
export function stepAgentCliDetection(
  current: AkmConfig,
  detectFn: (config?: AkmConfig) => AgentDetectionResult[] = detectAgentCliProfiles,
): AgentSetupResult {
  const detections = detectFn(current);
  const currentAgentBlock = getCurrentAgentBlock(current);
  const defaultName = pickDefaultAgentProfile(detections, currentAgentBlock?.default);

  // No installed agents found and no existing config → leave block absent.
  if (!defaultName && !currentAgentBlock) {
    return { detections };
  }

  const agent: LegacyAgentBlockShape = {
    ...(currentAgentBlock ?? {}),
    ...(defaultName ? { default: defaultName } : {}),
  };
  return { agent, detections };
}

// ── Main Wizard ─────────────────────────────────────────────────────────────

/**
 * Normalise a task id the same way `akm tasks` does (strip a trailing `.yml`
 * / `.md` suffix, trim) so the wizard can match embedded template ids against
 * the ids reported by `akmTasksList()`.
 */
function normaliseTaskIdForMatch(raw: string): string {
  return raw.trim().replace(/\.(yml|md)$/, "");
}

/**
 * Interactive-only setup step: enable/disable embedded core tasks.
 *
 * Presents a multi-select of the bundled core task templates pre-checked
 * against the user's currently-enabled tasks. On confirm:
 *   - newly-checked & absent  → copy template (with edited schedule) into the
 *     primary stash via `akmTasksAdd`, then `akmTasksSync`, then `akm sync`
 *     (a no-op for non-git stashes).
 *   - newly-checked & present-but-disabled → `akmTasksSetEnabled(id, true)`.
 *   - previously-enabled & now unchecked    → `akmTasksSetEnabled(id, false)`
 *     (keeps the stash file, removes the scheduler entry).
 *   - unchanged → no action.
 *
 * Exported for testing. Not registered as `nonInteractive`, so `akm init` /
 * `--yes` never reach it.
 *
 * The task primitives + git-sync helper are injected via `deps` (defaulting
 * to the real implementations) so tests can supply fakes without
 * `mock.module`-ing the shared `commands/tasks` / `sources/providers/git`
 * modules — which would leak into unrelated test files (Bun's `mock.module`
 * is process-global and not reverted by `mock.restore()`).
 */
/**
 * Setup sub-step (issue #552): idempotently register the default improve task
 * set. Asks a single "Is this a server install?" question (defaulting per
 * platform) to decide whether the nightly sweep is enabled, then delegates to
 * {@link registerDefaultTasks}, which is CI-aware and never duplicates an
 * existing task. Skipped entirely under CI (the registration helper short-
 * circuits, and we never even prompt).
 *
 * Exported for testing.
 */
export async function stepDefaultImproveTasks(
  register: typeof registerDefaultTasks = registerDefaultTasks,
): Promise<void> {
  // CI: register nothing and don't prompt.
  if (isCiEnvironment()) {
    p.log.info("CI detected — skipping default improve task registration.");
    return;
  }

  const platformDefault = detectServerDefault();
  const serverInstall = await prompt(() =>
    p.confirm({
      message: "Is this a server install? (enables the nightly quality sweep at 2am)",
      initialValue: platformDefault,
    }),
  );

  const result = await register({ serverInstall: serverInstall === true });
  if (result.skipped) return;
  const total = result.created.length + result.existing.length;
  p.log.success(
    `Default improve tasks registered (${result.created.length} new, ${result.existing.length} already present, ${total} total).`,
  );
}

export interface ScheduledTasksDeps {
  list: typeof akmTasksList;
  add: typeof akmTasksAdd;
  setEnabled: typeof akmTasksSetEnabled;
  sync: typeof akmTasksSync;
  gitSync: typeof saveGitStash;
}

const DEFAULT_SCHEDULED_TASKS_DEPS: ScheduledTasksDeps = {
  list: akmTasksList,
  add: akmTasksAdd,
  setEnabled: akmTasksSetEnabled,
  sync: akmTasksSync,
  gitSync: saveGitStash,
};

export async function stepScheduledTasks(deps: ScheduledTasksDeps = DEFAULT_SCHEDULED_TASKS_DEPS): Promise<void> {
  const embedded = listEmbeddedTasks();
  if (embedded.length === 0) return;

  // Snapshot current state so we can diff against the user's selection.
  let installed: Awaited<ReturnType<typeof akmTasksList>>["tasks"] = [];
  try {
    installed = (await deps.list()).tasks;
  } catch {
    // A missing/empty tasks dir is fine — treat as nothing installed.
    installed = [];
  }
  const byId = new Map<string, (typeof installed)[number]>();
  for (const t of installed) byId.set(normaliseTaskIdForMatch(t.id), t);

  // Pre-check tasks that are installed AND enabled.
  const preChecked = embedded.filter((e) => byId.get(e.id)?.enabled === true).map((e) => e.id);

  const stateLabel = (e: EmbeddedTask): string => {
    const cur = byId.get(e.id);
    if (!cur) return "not installed";
    return cur.enabled ? "enabled" : "disabled";
  };

  const selected = await prompt(() =>
    p.multiselect({
      message: "Enable scheduled core tasks? (space to toggle, enter to confirm)",
      required: false,
      initialValues: preChecked,
      options: embedded.map((e) => ({
        value: e.id,
        label: e.label,
        hint: `${e.description} — ${e.schedule} [${stateLabel(e)}]`,
      })),
    }),
  );

  const selectedSet = new Set(selected as string[]);

  // Resolve per-task schedule edits for newly-checked, not-yet-installed tasks.
  const scheduleFor = new Map<string, string>();
  for (const e of embedded) {
    const cur = byId.get(e.id);
    if (selectedSet.has(e.id) && !cur) {
      const edited = await prompt(() =>
        p.text({
          message: `Schedule for ${e.label}?`,
          initialValue: e.schedule,
          validate(value) {
            const candidate = (value ?? "").trim() || e.schedule;
            try {
              parseSchedule(candidate, backendNameForPlatform());
            } catch (err) {
              return err instanceof Error ? err.message : "Invalid schedule.";
            }
            return undefined;
          },
        }),
      );
      const sched = ((edited as string) ?? "").trim() || e.schedule;
      scheduleFor.set(e.id, sched);
    }
  }

  let syncNeeded = false;
  for (const e of embedded) {
    const cur = byId.get(e.id);
    const checked = selectedSet.has(e.id);
    if (checked && !cur) {
      // New task: copy template into the primary stash + install scheduler entry.
      const schedule = scheduleFor.get(e.id) ?? e.schedule;
      await deps.add({
        id: e.id,
        schedule,
        command: e.command,
        description: e.description,
      });
      syncNeeded = true;
    } else if (checked && cur && !cur.enabled) {
      // Present but disabled → re-enable.
      await deps.setEnabled(e.id, true);
    } else if (!checked && cur?.enabled) {
      // Previously enabled, now unchecked → disable (keep the stash file).
      await deps.setEnabled(e.id, false);
    }
    // No state change → no action.
  }

  if (syncNeeded) {
    // Reconcile scheduler entries with on-disk YAML, then commit the new file
    // to git (a no-op for non-git stashes).
    await deps.sync();
    try {
      deps.gitSync(undefined, "akm setup: enable scheduled tasks");
    } catch {
      // Non-fatal — the task is installed regardless of git sync outcome.
    }
  }
}

/**
 * Build the canonical list of `SetupStep`s for the interactive wizard.
 * Exposed (and exported) so tests and `akm init` can compose subsets.
 *
 * Each step wraps the existing `step*` functions, accumulating its result
 * into the shared `SetupContext`. The `nonInteractive` flag controls
 * inclusion in `akm init` (a non-interactive preset of `akm setup`).
 */
export function buildSetupSteps(options: {
  online: boolean;
  semanticSearchOutcome: { mode: "off" | "auto"; prepareAssets: boolean };
  preferredStashDir?: string;
  detection?: DetectedEnvironment;
}): {
  steps: SetupStep[];
  /** Latest semantic-search choice; populated by the semantic-search step. */
  outcome: { semantic: { mode: "off" | "auto"; prepareAssets: boolean } };
} {
  const outcome = { semantic: options.semanticSearchOutcome };
  // Local cache of Ollama-detected fields surfaced from the embedding step
  // to the LLM step. Mutable by design — `stepLlm` needs them.
  let ollamaEndpoint: string | undefined;
  let ollamaChatModels: string[] | undefined;
  let lmStudioResult: LMStudioDetectionResult | undefined;
  // Harness configs detected once and shared with the LLM step. Reuse the
  // aggregate detection's harness configs when available so we detect once.
  const harnessConfigs = options.detection?.harnessConfigs ?? detectHarnessConfigs();

  const steps: SetupStep[] = [
    {
      id: "stash-dir",
      label: "Stash Directory",
      nonInteractive: true,
      async run(ctx) {
        const stashDir = await stepStashDir(ctx.config, {
          nonInteractive: ctx.nonInteractive,
          preferredDir: options.preferredStashDir,
        });
        ctx.apply({ stashDir });
      },
    },
    {
      id: "embedding",
      label: "Embedding",
      async run(ctx) {
        if (!options.online) {
          ctx.apply({ embedding: ctx.config.embedding });
          return;
        }
        const [result, lmStudio] = await Promise.all([stepOllama(ctx.config), detectLMStudio()]);
        ollamaEndpoint = result.ollamaEndpoint;
        ollamaChatModels = result.ollamaChatModels;
        lmStudioResult = lmStudio;
        ctx.apply({ embedding: result.embedding });
      },
    },
    {
      id: "llm",
      label: "LLM Provider",
      async run(ctx) {
        if (!options.online) {
          return;
        }
        const llm = await stepLlm(ctx.config, ollamaEndpoint, ollamaChatModels, lmStudioResult, harnessConfigs);
        ctx.apply(applyLegacyLlm(ctx.config, llm));
      },
    },
    {
      id: "semantic-search",
      label: "Semantic Search",
      async run(ctx) {
        const semantic = await stepSemanticSearch(ctx.config, ctx.config.embedding);
        outcome.semantic = semantic;
        ctx.apply({ semanticSearchMode: semantic.mode });
      },
    },
    {
      id: "registries",
      label: "Registries",
      async run(ctx) {
        const registries = await stepRegistries(ctx.config);
        ctx.apply({ registries });
      },
    },
    {
      id: "stash-sources",
      label: "Stash Sources",
      async run(ctx) {
        const stashes = await stepAddSources(ctx.config, { promptForAdditional: false });
        const platforms = await stepAgentPlatforms({ ...ctx.config, sources: stashes });
        const merged = [...stashes];
        for (const ps of platforms) {
          if (!merged.some((s) => s.path === ps.path)) merged.push(ps);
        }
        const withAdditional = await stepAdditionalSources(merged);
        ctx.apply({ sources: withAdditional.length > 0 ? withAdditional : undefined });
      },
    },
    {
      id: "agent-cli",
      label: "Agent CLI",
      async run(ctx) {
        const result = stepAgentCliDetection(ctx.config);
        const detected = result.detections.filter((d) => d.available);
        if (detected.length > 0) {
          p.log.info(
            `Detected agent CLIs: ${detected.map((d) => d.name).join(", ")}.` +
              (result.agent?.default ? ` Default profile: ${result.agent.default}.` : ""),
          );
        } else {
          p.log.info(
            "No agent CLIs detected on PATH. Agent commands will be disabled until one is installed and `akm setup` is re-run.",
          );
        }
        // Inject the detected agent block into a synthetic AkmConfig so
        // stepAgentSelection can read it via getCurrentAgentBlock().
        const synthConfig = { ...ctx.config, ...applyLegacyAgent(ctx.config, result.agent) };
        const agent = await stepAgentSelection(synthConfig, result.detections);
        ctx.apply(applyLegacyAgent(ctx.config, agent));
      },
    },
    {
      id: "output",
      label: "Output Defaults",
      async run(ctx) {
        const output = await stepOutputConfig(ctx.config);
        ctx.apply({ output });
      },
    },
    {
      id: "scheduled-tasks",
      label: "Scheduled Tasks",
      // Interactive-only: `akm init` / `--yes` skip this step so headless
      // runs never enable a scheduled task (see issue #512).
      async run() {
        await stepDefaultImproveTasks();
        await stepScheduledTasks();
      },
    },
  ];

  return { steps, outcome };
}

export async function runSetupWizard(opts?: { dir?: string; noInit?: boolean }): Promise<void> {
  p.intro("akm setup");

  const current = loadUserConfig();
  const configPath = getConfigPath();

  // Resolve stash directory early so akmInit can run before any prompts
  const resolvedStashDir = opts?.dir ? path.resolve(opts.dir) : (current.stashDir ?? getDefaultStashDir());

  // Refuse explicit --dir /tmp/... before doing any work — protects the host
  // config from being clobbered with a stashDir that the OS may reap.
  assertSetupSandbox(resolvedStashDir, opts?.dir != null);
  applyStashIsolationToEnv(resolvedStashDir, opts?.dir != null);

  // Bootstrap directory structure before any prompts so the stash exists
  // even if the wizard is interrupted after this point.
  if (!opts?.noInit) {
    await akmInit({ dir: resolvedStashDir });
  }

  // Quick connectivity check — skip network-dependent steps when offline
  const online = await isOnline();
  if (!online) {
    p.log.warn(
      "No network connectivity detected. Skipping Ollama detection and remote embedding checks.\n" +
        "Local-only setup will continue. Re-run `akm setup` when online for full configuration.",
    );
  }

  // Aggregate environment detection — run once before any prompt and surface
  // a summary so the user sees what was auto-detected. NAMES only, never
  // API key values.
  const detection = await detectEnvironment({ existingStashDir: current.stashDir });
  p.note(renderDetectionSummary(detection), "Detected environment");

  // Interactive entry point for `--reset-recommended`: offer to apply the
  // opinionated, detection-derived defaults and skip the step-by-step wizard.
  const useRecommended = await prompt(() =>
    p.confirm({
      message: "Apply recommended defaults from the detected environment (merged into your existing config)?",
      initialValue: false,
    }),
  );
  if (useRecommended) {
    const result = await runResetRecommended({ dir: opts?.dir, noInit: opts?.noInit });
    p.outro(`Recommended configuration saved to ${result.configPath}`);
    return;
  }

  const ctx = createSetupContext(current, { nonInteractive: false });
  const { steps, outcome } = buildSetupSteps({
    online,
    semanticSearchOutcome: { mode: current.semanticSearchMode, prepareAssets: false },
    preferredStashDir: resolvedStashDir,
    detection,
  });

  // Wrap each step with a `p.log.step()` header so the wizard UI is
  // unchanged. The canonical `runSetupSteps()` runner is used directly by
  // `akm init` (non-interactive) and by tests.
  const labeledSteps: SetupStep[] = steps.map((step) => ({
    ...step,
    async run(stepCtx) {
      p.log.step(step.label);
      await step.run(stepCtx);
    },
  }));
  await runSetupSteps(labeledSteps, ctx);

  // ── Two-step connection configuration ──────────────────────────────────────
  // Step 1/2: Small model connection (for enrichment features)
  const smallModelResult = await stepSmallModelConnection(ctx.config);
  if (!smallModelResult.skipped) {
    ctx.apply(applyLegacyLlm(ctx.config, smallModelResult.llm));
  }

  // Step 2/2: Agent connection (for agentic features)
  const agentConfig = await stepAgentConnection(ctx.config, smallModelResult);
  ctx.apply(applyLegacyAgent(ctx.config, agentConfig));

  const newConfig: AkmConfig = {
    ...ctx.config,
    // Preserve fields the steps don't manage explicitly.
    installed: current.installed,
  };
  const semanticSearchMode = outcome.semantic;
  const stashDir = newConfig.stashDir ?? current.stashDir ?? getDefaultStashDir();
  const embedding = newConfig.embedding;
  const llm = getDefaultLlmConfig(newConfig);
  const registries = newConfig.registries;
  const allStashes = newConfig.sources ?? [];

  // Feature capability summary
  const agentConfigured = Boolean(agentConfig);
  printCapabilitySummary(smallModelResult.skipped, agentConfigured);

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
      `Agent default:    ${newConfig.defaults?.agent ?? "disabled"}`,
      `Output:           ${newConfig.output?.format ?? "json"} / ${newConfig.output?.detail ?? "brief"}`,
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
  const cfgPath1 = getConfigPath();
  backupAndAnnounce(cfgPath1);
  saveConfig(newConfig);

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

// ── Non-interactive / scripting entry points ─────────────────────────────────

/**
 * Back up an existing config file and print the real, timestamped backup
 * location (not a generic display string). On a fresh install where there is
 * nothing to back up, print a "nothing to back up" notice instead.
 */
function backupAndAnnounce(configPath: string): void {
  const result = backupExistingConfig(configPath);
  if (result) {
    p.log.info(`Config backed up to ${result.timestamped}`);
  } else {
    p.log.info("No existing config to back up.");
  }
}

/**
 * Run setup in non-interactive mode, applying all defaults.
 * Safe to call from CI or scripts. Idempotent — re-running produces the same result.
 */
export async function runSetupWithDefaults(opts: {
  dir?: string;
  noInit?: boolean;
  probe?: boolean;
}): Promise<SetupSummary> {
  const current = loadUserConfig();
  const stashDir = opts.dir ? path.resolve(opts.dir) : (current.stashDir ?? getDefaultStashDir());

  assertSetupSandbox(stashDir, opts.dir != null);
  applyStashIsolationToEnv(stashDir, opts.dir != null);

  // Bootstrap directory structure first
  let initResult: InitResponse | undefined;
  if (!opts.noInit) {
    initResult = await akmInit({ dir: stashDir });
  }

  // Run steps in non-interactive mode (applies defaults, skips prompts)
  const ctx = createSetupContext(current, { nonInteractive: true });
  const { steps } = buildSetupSteps({
    online: false,
    semanticSearchOutcome: { mode: current.semanticSearchMode, prepareAssets: false },
    preferredStashDir: stashDir,
  });
  await runSetupSteps(steps, ctx);

  // Ensure stashDir is set
  if (!ctx.config.stashDir) ctx.apply({ stashDir });

  // Aggregate environment detection — apply detected values directly.
  const env = await detectEnvironment({ existingStashDir: ctx.config.stashDir });

  // Apply a detected LLM (live local server) when the config has none yet.
  if (!getDefaultLlmConfig(ctx.config)) {
    const liveLocal = env.localServers.find((s) => s.available && s.defaultModel);
    if (liveLocal?.defaultModel) {
      const llm: LlmConnectionConfig = {
        provider: "local",
        endpoint: `${liveLocal.baseUrl.replace(/\/$/, "")}/v1`,
        model: liveLocal.defaultModel,
      };
      // A required field being unresolvable must fail loudly rather than write
      // a broken config (--yes acceptance criterion).
      if (!llm.endpoint?.trim() || !llm.model?.trim()) {
        throw new UsageError(
          "Detected a local LLM server but could not resolve a required field (endpoint/model). Re-run `akm setup` interactively.",
          "MISSING_REQUIRED_ARGUMENT",
        );
      }
      ctx.apply(applyLegacyLlm(ctx.config, llm));
    }
  }

  // Auto-detect agent CLI if not already configured
  if (!ctx.config.defaults?.agent) {
    let defaultProfile: string | undefined;
    if (env.harness !== "none") {
      defaultProfile = env.harness;
    } else {
      const detected = detectAgentCliProfiles(undefined);
      defaultProfile = pickDefaultAgentProfile(detected, undefined);
    }
    if (defaultProfile) {
      ctx.apply(applyLegacyAgent(ctx.config, { default: defaultProfile }));
    }
  }

  const cfgPath2 = getConfigPath();
  backupAndAnnounce(cfgPath2);
  saveConfig(ctx.config);

  return {
    configPath: getConfigPath(),
    stashDir,
    stashCreated: initResult?.created ?? false,
    written: true,
    fields: Object.keys(ctx.config).filter((k) => ctx.config[k as keyof AkmConfig] !== undefined),
    ripgrep: initResult?.ripgrep,
  };
}

/**
 * Recursively merge `incoming` into `base`: plain objects merge key-by-key,
 * while arrays and scalars replace wholesale. A partial input therefore only
 * updates the keys it carries and never drops sibling subkeys (e.g. a file
 * containing `{ output: { format: "text" } }` leaves `output.detail` intact).
 *
 * `base` is treated as immutable — a fresh object graph is returned.
 */
function deepMergeConfig<T>(base: T, incoming: unknown): T {
  if (!isPlainObject(incoming)) return incoming as T;
  const baseObj = isPlainObject(base) ? (base as Record<string, unknown>) : {};
  const out: Record<string, unknown> = { ...baseObj };
  for (const [key, value] of Object.entries(incoming)) {
    if (value === undefined) continue;
    if (isPlainObject(value) && isPlainObject(baseObj[key])) {
      out[key] = deepMergeConfig(baseObj[key], value);
    } else {
      out[key] = value;
    }
  }
  return out as T;
}

/** True for non-null, non-array plain objects. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Run ONLY environment detection and return the typed result. Performs no
 * config writes and shows no prompts. Backs `akm setup --detect-only`.
 *
 * SAFETY: The returned object carries env var NAMES only — never any API key
 * value.
 */
export async function runDetectOnly(): Promise<DetectedEnvironment> {
  const current = loadUserConfig();
  return detectEnvironment({ existingStashDir: current.stashDir });
}

/**
 * Derive opinionated defaults from a detection result.
 *
 * - Best harness → agent default (when a profile maps to it).
 * - Fastest live local model, else the first detected cloud key's provider.
 * - `nomic-embed-text` embeddings when a local LLM is live.
 * - improve task `0 2 * * *`, index task `0 4 * * *`.
 *
 * Returns a partial `AkmConfig`-shaped object plus a legacy `llm` block, ready
 * to merge. Never includes an API key value.
 */
export function deriveRecommendedConfig(env: DetectedEnvironment): {
  llm?: LlmConnectionConfig;
  embedding?: EmbeddingConnectionConfig;
  agentDefault?: string;
  taskSchedules?: { improve?: string; index?: string };
} {
  const result: ReturnType<typeof deriveRecommendedConfig> = {};

  // Best harness → agent default.
  if (env.harness === "opencode-sdk") result.agentDefault = "opencode-sdk";
  else if (env.harness === "opencode") result.agentDefault = "opencode";
  else if (env.harness === "claude") result.agentDefault = "claude";

  // LLM: prefer a live local server, else a detected cloud provider key.
  const liveLocal = env.localServers.find((s) => s.available && s.defaultModel);
  if (liveLocal?.defaultModel) {
    result.llm = {
      provider: "local",
      endpoint: `${liveLocal.baseUrl.replace(/\/$/, "")}/v1`,
      model: liveLocal.defaultModel,
    };
    // Local LLM live → use a local embedding model.
    result.embedding = { provider: "ollama", model: "nomic-embed-text", endpoint: `${liveLocal.baseUrl}/v1` };
  } else {
    // Map a detected cloud API-key provider to an llm endpoint. NAMES only —
    // the value lives in the env var the user already set; we never read it.
    const cloud = env.providers.find((pr) => pr.kind === "apiKey");
    if (cloud) {
      const endpoint = cloudEndpointForProvider(cloud.provider);
      const model = cloudDefaultModelForProvider(cloud.provider);
      if (endpoint && model) {
        result.llm = { provider: cloud.provider, endpoint, model };
      }
    }
  }

  result.taskSchedules = { improve: "0 2 * * *", index: "0 4 * * *" };

  return result;
}

function cloudEndpointForProvider(provider: string): string | undefined {
  switch (provider) {
    case "anthropic":
      return "https://api.anthropic.com/v1";
    case "openai":
      return "https://api.openai.com/v1";
    case "gemini":
      return "https://generativelanguage.googleapis.com/v1beta/openai";
    case "groq":
      return "https://api.groq.com/openai/v1";
    default:
      return undefined;
  }
}

function cloudDefaultModelForProvider(provider: string): string | undefined {
  switch (provider) {
    case "anthropic":
      return "claude-sonnet-4-5";
    case "openai":
      return "gpt-4o-mini";
    case "gemini":
      return "gemini-1.5-flash";
    case "groq":
      return "llama-3.3-70b-versatile";
    default:
      return undefined;
  }
}

/**
 * `akm setup --reset-recommended`: merge opinionated, detection-derived
 * defaults into the existing config WITHOUT removing pre-existing custom keys.
 * Uses the same merge path as {@link runSetupFromConfig} so custom keys survive
 * (follows #511 semantics).
 */
export async function runResetRecommended(opts: {
  dir?: string;
  noInit?: boolean;
  probe?: boolean;
}): Promise<SetupSummary> {
  const current = loadUserConfig();
  const env = await detectEnvironment({ existingStashDir: current.stashDir });
  const recommended = deriveRecommendedConfig(env);

  const incoming: Partial<AkmConfig> & { llm?: LlmConnectionConfig; agent?: LegacyAgentBlockShape } = {};
  if (recommended.llm) incoming.llm = recommended.llm;
  if (recommended.embedding) incoming.embedding = recommended.embedding;
  if (recommended.agentDefault) incoming.agent = { default: recommended.agentDefault };
  if (recommended.taskSchedules) {
    (incoming as Record<string, unknown>).setup = { taskSchedules: recommended.taskSchedules };
  }

  return runSetupFromConfig({
    configJson: JSON.stringify(incoming),
    dir: opts.dir,
    noInit: opts.noInit,
    probe: opts.probe,
  });
}

/**
 * Apply a JSON config blob non-interactively, merging it with the current config.
 * Validates required sub-fields and strips unknown/restricted keys.
 */
export async function runSetupFromConfig(opts: {
  configJson: string;
  dir?: string;
  noInit?: boolean;
  probe?: boolean;
  /**
   * When true (`--yes --file`), fill any keys still missing after the deep
   * merge with non-interactive defaults — without overwriting values the file
   * or existing config already supplied.
   */
  applyDefaults?: boolean;
}): Promise<SetupSummary> {
  // Phase 1: Parse JSON
  type IncomingShape = Partial<AkmConfig> & {
    llm?: LlmConnectionConfig;
    agent?: LegacyAgentBlockShape;
  };
  let incoming: IncomingShape;
  try {
    incoming = JSON.parse(opts.configJson);
  } catch (e) {
    throw new Error(`Invalid JSON in --config: ${(e as Error).message}`);
  }

  // Phase 2: Validate — only allow safe top-level keys
  const ALLOWED_KEYS = new Set([
    "stashDir",
    "llm",
    "embedding",
    "agent",
    "semanticSearchMode",
    "output",
    "profiles",
    "defaults",
    "setup",
  ]);
  for (const key of Object.keys(incoming)) {
    if (!ALLOWED_KEYS.has(key)) {
      warn(`[akm setup] Ignoring unknown or restricted config key: "${key}"`);
      delete (incoming as Record<string, unknown>)[key];
    }
  }

  // Validate required sub-fields
  if (incoming.llm) {
    if (!incoming.llm.endpoint?.trim()) throw new Error("llm.endpoint is required when llm is provided");
    if (!incoming.llm.model?.trim()) throw new Error("llm.model is required when llm is provided");
  }
  if (incoming.embedding) {
    if (!incoming.embedding.endpoint?.trim())
      throw new Error("embedding.endpoint is required when embedding is provided");
    if (!incoming.embedding.model?.trim()) throw new Error("embedding.model is required when embedding is provided");
  }

  // Phase 3: Merge with existing config
  const current = loadUserConfig();
  const stashDir = opts.dir
    ? path.resolve(opts.dir)
    : incoming.stashDir
      ? path.resolve(incoming.stashDir)
      : (current.stashDir ?? getDefaultStashDir());

  const stashDirExplicit = opts.dir != null || incoming.stashDir != null;
  assertSetupSandbox(stashDir, stashDirExplicit);
  applyStashIsolationToEnv(stashDir, stashDirExplicit);

  let merged: AkmConfig = { ...current, stashDir };
  // Deep-merge non-llm/agent keys: nested objects merge key-by-key so a
  // partial `--file` only updates the keys it carries and never drops sibling
  // subkeys (e.g. output.detail survives an output.format-only file). Arrays
  // and scalars replace wholesale.
  for (const key of Object.keys(incoming)) {
    if (key === "llm" || key === "agent") continue;
    const incomingVal = (incoming as Record<string, unknown>)[key];
    const mergedRec = merged as unknown as Record<string, unknown>;
    mergedRec[key] = deepMergeConfig(mergedRec[key], incomingVal);
  }
  // Translate legacy llm/agent inputs into the new shape.
  if (incoming.llm) {
    merged = { ...merged, ...applyLegacyLlm(merged, incoming.llm) };
  }
  if (incoming.agent) {
    merged = { ...merged, ...applyLegacyAgent(merged, incoming.agent) };
  }

  // With `--yes`, fill keys still missing after the merge with non-interactive
  // defaults. Steps start from `merged` and their nonInteractive path only
  // populates absent values, so nothing the file or existing config supplied
  // is overwritten.
  if (opts.applyDefaults) {
    const ctx = createSetupContext(merged, { nonInteractive: true });
    const { steps } = buildSetupSteps({
      online: false,
      semanticSearchOutcome: { mode: merged.semanticSearchMode, prepareAssets: false },
      preferredStashDir: stashDir,
    });
    await runSetupSteps(steps, ctx);
    if (!ctx.config.stashDir) ctx.apply({ stashDir });
    if (!ctx.config.defaults?.agent) {
      const detected = detectAgentCliProfiles(undefined);
      const defaultProfile = pickDefaultAgentProfile(detected, undefined);
      if (defaultProfile) {
        ctx.apply(applyLegacyAgent(ctx.config, { default: defaultProfile }));
      }
    }
    merged = ctx.config;
  }

  // Bootstrap directory structure
  let initResult: InitResponse | undefined;
  if (!opts.noInit) {
    initResult = await akmInit({ dir: stashDir });
  }

  // Optional probe
  const mergedLlm = getDefaultLlmConfig(merged);
  if (opts.probe && mergedLlm) {
    try {
      const caps = await probeLlmCapabilities(mergedLlm);
      if (caps.reachable) {
        merged = {
          ...merged,
          ...applyLegacyLlm(merged, {
            ...mergedLlm,
            capabilities: { structuredOutput: caps.structuredOutput ?? false },
          }),
        };
      }
    } catch {
      // Non-fatal: probe failure is informational only
    }
  }

  const cfgPath3 = getConfigPath();
  backupAndAnnounce(cfgPath3);
  saveConfig(merged);

  return {
    configPath: getConfigPath(),
    stashDir,
    stashCreated: initResult?.created ?? false,
    written: true,
    fields: Object.keys(incoming).filter((k) => (incoming as Record<string, unknown>)[k] !== undefined),
    ripgrep: initResult?.ripgrep,
  };
}

// ── Setup --from <file> bootstrap helper ────────────────────────────────────

/**
 * Resolve a `--from <file>` argument to a JSON-encoded config payload suitable
 * for `runSetupFromConfig({ configJson })`. Used by the CLI to bootstrap from
 * a JSON or YAML file on disk; extracted as a standalone function so its
 * filesystem and parser behaviour can be unit-tested directly.
 *
 * - Expands a leading `~` to the current user's home directory.
 * - Resolves the path against `cwd ?? process.cwd()` for relative inputs.
 * - Detects YAML vs JSON via the file extension (`.yml`/`.yaml` → YAML;
 *   anything else, including `.json`, parses as JSON).
 * - Throws `ConfigError("INVALID_CONFIG_FILE")` when the file does not exist,
 *   cannot be read, cannot be parsed, or contains a non-object top level.
 *
 * Returns `{ configJson, resolvedPath, format }` so callers can log which
 * file was actually loaded and which parser was used.
 */
export async function loadSetupConfigFromFile(
  filePath: string,
  opts?: { cwd?: string; homeDir?: string },
): Promise<{ configJson: string; resolvedPath: string; format: "json" | "yaml" }> {
  const cwd = opts?.cwd ?? process.cwd();
  const homeDir = opts?.homeDir ?? os.homedir();
  const expanded = filePath.startsWith("~") ? path.join(homeDir, filePath.slice(1)) : filePath;
  const resolvedPath = path.resolve(cwd, expanded);

  if (!fs.existsSync(resolvedPath)) {
    throw new ConfigError(`Config file not found: ${resolvedPath}`, "INVALID_CONFIG_FILE");
  }
  let raw: string;
  try {
    raw = fs.readFileSync(resolvedPath, "utf8");
  } catch (err) {
    throw new ConfigError(
      `Failed to read config file ${resolvedPath}: ${err instanceof Error ? err.message : String(err)}`,
      "INVALID_CONFIG_FILE",
    );
  }
  const ext = path.extname(resolvedPath).toLowerCase();
  const format: "json" | "yaml" = ext === ".yml" || ext === ".yaml" ? "yaml" : "json";
  let parsed: unknown;
  try {
    if (format === "yaml") {
      const { parse: yamlParse } = await import("yaml");
      parsed = yamlParse(raw);
    } else {
      parsed = JSON.parse(raw);
    }
  } catch (err) {
    throw new ConfigError(
      `Failed to parse ${format.toUpperCase()} config file ${resolvedPath}: ${err instanceof Error ? err.message : String(err)}`,
      "INVALID_CONFIG_FILE",
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ConfigError(
      `Config file ${resolvedPath} must contain a top-level object, got ${Array.isArray(parsed) ? "array" : typeof parsed}.`,
      "INVALID_CONFIG_FILE",
    );
  }
  return { configJson: JSON.stringify(parsed), resolvedPath, format };
}
