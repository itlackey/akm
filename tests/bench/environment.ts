/**
 * environment.ts — unified bench environment setup.
 *
 * `setupBenchEnvironment` is the single function that owns all per-run
 * isolation: isolation dirs, opencode.json, akm config, FTS5 index. Both
 * `runOne` (driver.ts) and the doctor's live-run check call this function,
 * guaranteeing they produce identical environments.
 *
 * Key design decisions:
 * - `BENCH_OPENCODE_INVARIANTS` (plugin:[], permission block) are always
 *   written — they are bench isolation invariants, not conditional on the
 *   provider path. No silent stub fallbacks.
 * - `dryRun: true` skips the akm config and index writes. Unit tests set
 *   this so the setup path is exercised without spawning a real agent.
 * - `validateFixtureCorpus` is called at bench startup to catch missing
 *   fixtures before any work items start, not per-task mid-run.
 */

import fs from "node:fs";
import path from "node:path";

import { buildIsolatedEnv, buildSanitizedEnvSource, createIsolationDirs, type IsolationDirs } from "./driver";
import { BenchConfigError, type LoadedOpencodeProviders, selectProviderForModel } from "./opencode-config";
import { benchMkdtemp } from "./tmp";

// ── Bench isolation invariants ───────────────────────────────────────────────

/**
 * Top-level keys written unconditionally into every bench-generated
 * opencode.json. These are isolation invariants — never conditional on
 * provider resolution or model type.
 *
 * - `plugin: []` — prevents operator plugins (akm-opencode, etc.) from
 *   running lifecycle hooks that override AKM_STASH_DIR, warm indexes
 *   against the wrong stash, or prompt akm setup wizards.
 * - `permission` — opencode in non-interactive (`opencode run`) mode
 *   silently skips tool calls without explicit permission grants.
 */
export const BENCH_OPENCODE_INVARIANTS = {
  plugin: [] as const,
  permission: {
    bash: "allow",
    edit: "allow",
    write: "allow",
    read: "allow",
    webfetch: "allow",
  },
} as const;

// ── Built-in cloud prefixes ──────────────────────────────────────────────────

/**
 * opencode provider prefixes that resolve via its built-in cloud-provider
 * registry. Models with one of these prefixes do not need a custom provider
 * entry in the bench providers JSON. Models with any other prefix require
 * `opencodeProviders` — the harness refuses to run without it to prevent
 * silent cloud-model fallback and unexpected API charges.
 */
export const BUILTIN_CLOUD_PREFIXES = new Set([
  "anthropic",
  "openai",
  "openrouter",
  "opencode",
  "google",
  "amazon",
  "azure",
  "vertex",
  "bedrock",
  "mistral",
  "groq",
  "together",
  "fireworks",
]);

// ── writeOpencodeJson ────────────────────────────────────────────────────────

export interface WriteOpencodeJsonResult {
  /** Provider key that was resolved and written (undefined for stub/cloud). */
  providerKey?: string;
  /** Non-fatal warnings (e.g. model not in providers — fell back to stub). */
  warnings: string[];
}

/**
 * Write an `opencode.json` into `opencodeConfigDir`.
 *
 * Always includes `BENCH_OPENCODE_INVARIANTS` (plugin:[], permission block).
 * When `providers` is supplied and the model prefix resolves, the `provider`
 * block is added. When the prefix is not found in the providers map (built-in
 * cloud model), the file is written without a provider block and a warning is
 * returned — this is not an error because built-in cloud models resolve via
 * opencode's own registry.
 *
 * Returns a `WriteOpencodeJsonResult` — never throws for expected cases.
 * Throws for unexpected FS errors.
 */
export function writeOpencodeJson(
  opencodeConfigDir: string,
  model: string,
  providers?: LoadedOpencodeProviders,
): WriteOpencodeJsonResult {
  const warnings: string[] = [];
  let providerKey: string | undefined;
  let providerBlock: Record<string, unknown> | undefined;

  if (providers) {
    try {
      const selected = selectProviderForModel(providers, model);
      providerKey = selected.providerKey;
      providerBlock = { [selected.providerKey]: selected.entry };
    } catch (err) {
      if (err instanceof BenchConfigError) {
        // Model not in the providers map — treat as a built-in cloud model.
        warnings.push(
          `model "${model}" not found in providers config; writing stub (expected for built-in cloud models)`,
        );
      } else {
        throw err;
      }
    }
  }

  const config: Record<string, unknown> = {
    $schema: "https://opencode.ai/config.json",
    model,
    ...BENCH_OPENCODE_INVARIANTS,
    ...(providerBlock ? { provider: providerBlock } : {}),
  };

  fs.writeFileSync(path.join(opencodeConfigDir, "opencode.json"), JSON.stringify(config, null, 2), { mode: 0o600 });

  return { providerKey, warnings };
}

// ── setupBenchEnvironment ────────────────────────────────────────────────────

export interface BenchEnvParams {
  model: string;
  arm: "noakm" | "akm" | "post-evolve" | "synthetic";
  stashDir?: string;
  /** Pre-built FTS5 index cache from `loadFixtureStash().indexCacheHome`. */
  indexCacheHome?: string;
  providers?: LoadedOpencodeProviders;
  /**
   * When true, skip the akm config write and index copy/build. Used by unit
   * tests that inject a fake spawn — the fake stash doesn't exist on disk.
   */
  dryRun?: boolean;
  /** Collector for non-fatal warnings. */
  warnings?: string[];
}

export interface BenchEnvironment {
  dirs: IsolationDirs;
  env: Record<string, string>;
  /** Teardown: remove the isolation dirs. Call in a finally block. */
  teardown(): void;
}

/**
 * Set up a complete bench run environment.
 *
 * 1. Creates isolation dirs (XDG_CACHE_HOME, XDG_CONFIG_HOME, OPENCODE_CONFIG).
 * 2. Writes opencode.json with BENCH_OPENCODE_INVARIANTS + optional provider.
 * 3. Writes $XDG_CONFIG_HOME/akm/config.json so the akm CLI and any plugin
 *    find the correct stash via `akm config get stashDir`.
 * 4. Copies the pre-built FTS5 index into XDG_CACHE_HOME, or re-indexes as
 *    fallback if no pre-built cache is available.
 *
 * Throws `BenchConfigError` for model prefix / provider mismatches.
 */
export function setupBenchEnvironment(params: BenchEnvParams): BenchEnvironment {
  const { model, arm, stashDir: rawStashDir, indexCacheHome, providers, dryRun = false, warnings = [] } = params;

  // Synthetic arm must never carry a stash.
  const stashDir = arm === "synthetic" ? undefined : rawStashDir;

  // Safety: refuse to run local-provider models without a providers config.
  const modelParts = model.split("/");
  if (modelParts.length >= 2 && !BUILTIN_CLOUD_PREFIXES.has(modelParts[0]) && !providers) {
    throw new BenchConfigError(
      `model "${model}" uses custom provider prefix "${modelParts[0]}" — supply opencodeProviders to avoid silent fallback to a cloud model`,
      false,
    );
  }

  const dirs = createIsolationDirs(stashDir);
  const env = buildIsolatedEnv(dirs, model);

  // Synthetic arm must not carry AKM_STASH_DIR even if createIsolationDirs
  // somehow set it (recurrence guard for the #243 fixup pattern).
  if (arm === "synthetic") {
    delete env.AKM_STASH_DIR;
  }

  // Write opencode.json with invariants + optional provider block.
  const result = writeOpencodeJson(dirs.opencodeConfig, model, providers);
  for (const w of result.warnings) warnings.push(w);

  // Wire akm config and index only when a real stash is on disk.
  const stashOnDisk = stashDir ? fs.existsSync(stashDir) : false;
  if (stashDir && stashOnDisk && !dryRun) {
    // akm config: so `akm config get stashDir` returns the fixture path
    // and the akm-opencode plugin (if somehow re-enabled) injects the right
    // AKM_STASH_DIR into the bash-tool env via its shell.env hook.
    const akmConfigDir = path.join(dirs.configHome, "akm");
    fs.mkdirSync(akmConfigDir, { recursive: true });
    fs.writeFileSync(path.join(akmConfigDir, "config.json"), JSON.stringify({ stashDir }), { mode: 0o600 });

    // FTS5 index: fast-path copy from pre-built cache; slow-path re-index.
    const destAkmDir = path.join(dirs.cacheHome, "akm");
    fs.mkdirSync(destAkmDir, { recursive: true });

    if (indexCacheHome) {
      const srcAkmDir = path.join(indexCacheHome, "akm");
      try {
        for (const entry of fs.readdirSync(srcAkmDir)) {
          fs.copyFileSync(path.join(srcAkmDir, entry), path.join(destAkmDir, entry));
        }
      } catch (err) {
        warnings.push(`index copy failed, falling back to re-index: ${(err as Error).message}`);
        _runAkmIndex(stashDir, env);
      }
    } else {
      _runAkmIndex(stashDir, env);
    }
  }

  return {
    dirs,
    env,
    teardown() {
      try {
        fs.rmSync(dirs.root, { recursive: true, force: true });
      } catch {
        /* swallow */
      }
    },
  };
}

function _runAkmIndex(stashDir: string, env: Record<string, string>): void {
  const cliEntry = path.resolve(__dirname, "..", "..", "src", "cli.ts");
  Bun.spawnSync({
    cmd: ["bun", "run", cliEntry, "index", "--full"],
    cwd: stashDir,
    env: { ...buildSanitizedEnvSource(), ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
}

// ── validateFixtureCorpus ────────────────────────────────────────────────────

const FIXTURES_ROOT = path.resolve(__dirname, "..", "fixtures", "stashes");

/**
 * Validate that all task stash references name fixtures that exist on disk
 * (i.e. have a MANIFEST.json). Returns the set of missing fixture names.
 *
 * Call at bench startup before creating any work items. A non-empty `missing`
 * set means those tasks will produce `harness_error` at run time — better to
 * surface that now with named failures than to discover it per-seed.
 */
export function validateFixtureCorpus(tasks: ReadonlyArray<{ id: string; stash: string }>): {
  valid: Set<string>;
  missing: Map<string, string[]>;
} {
  const byFixture = new Map<string, string[]>();
  for (const t of tasks) {
    if (!byFixture.has(t.stash)) byFixture.set(t.stash, []);
    byFixture.get(t.stash)?.push(t.id);
  }

  const valid = new Set<string>();
  const missing = new Map<string, string[]>();

  for (const [fixture, taskIds] of byFixture) {
    const manifestPath = path.join(FIXTURES_ROOT, fixture, "MANIFEST.json");
    if (fs.existsSync(manifestPath)) {
      valid.add(fixture);
    } else {
      missing.set(fixture, taskIds);
    }
  }

  return { valid, missing };
}

export type { IsolationDirs } from "./driver";
// Re-export from driver for consumers that previously imported from there.
export { buildIsolatedEnv, buildSanitizedEnvSource, createIsolationDirs } from "./driver";
export { benchMkdtemp };
