/**
 * akm-bench run-config loader.
 *
 * A bench run config (`tests/bench/configs/*.json`) is a single-file
 * description of a utility/evolve invocation: providers, default model,
 * tasks, arms, seeds, budgets, parallel, baseline. Loading a config
 * resolves the providers file (from explicit `providers` / `providersRef`
 * fields, the `BENCH_OPENCODE_CONFIG` env var, or
 * `${XDG_CONFIG_HOME:-~/.config}/akm/bench-providers.json`), looks up the
 * effective default model, and resolves the task selector + baseline file
 * paths.
 *
 * Self-contained — does not import from `src/` so the bench framework
 * stays liftable to a standalone repo.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { listTasks, loadTask, type TaskMetadata, type TaskSlice } from "./corpus";
import {
  BenchConfigError,
  type BenchOpencodeProvidersFile,
  type LoadedOpencodeProviders,
  loadOpencodeProviders,
} from "./opencode-config";
import type { Arm } from "./runner";
import { benchMkdtemp } from "./tmp";

/** Wire-format of a bench run config file. */
export interface BenchRunConfigFile {
  $schema?: string;
  schemaVersion: 1;
  name?: string;
  description?: string;
  providers?: Record<string, unknown>;
  providersRef?: string;
  defaultModel?: string;
  tasks?: string | string[];
  arms?: Arm[];
  seeds?: number;
  budgetTokens?: number;
  budgetWallMs?: number;
  parallel?: number;
  forceParallel?: boolean;
  baseline?: string;
}

/**
 * Resolved config ready to drive `runUtility`. The loader has already done
 * provider discovery, task selection, baseline loading, and env-var lookups
 * so the caller wires fields directly to `RunUtilityOptions`.
 */
export interface ResolvedBenchRunConfig {
  /** Absolute path of the loaded config file (for error messages). */
  source: string;
  /** Display name (config `name` field, or basename without extension). */
  name: string;
  /** Resolved providers, ready to forward into `runUtility`. */
  providers: LoadedOpencodeProviders;
  /**
   * The model id stamped into every RunResult and the report. Resolved
   * precedence: `BENCH_OPENCODE_MODEL` env > config `defaultModel` >
   * providers file `defaultModel`.
   */
  model: string;
  /** Selected tasks, after `listTasks()` filtering. */
  tasks: TaskMetadata[];
  /** Arms array exactly as the runner expects it. */
  arms: Arm[];
  seedsPerArm?: number;
  budgetTokens?: number;
  budgetWallMs?: number;
  parallel?: number;
  forceParallel?: boolean;
  /** When supplied: `{ taskId: passRate }` map for delta rendering. */
  baselineByTaskId?: Record<string, number>;
  /**
   * Slice label stamped on the report when the task selector was a slice
   * literal (`"all"|"train"|"eval"`). Otherwise `"all"`.
   */
  slice: "all" | TaskSlice;
}

/** Override values applied on top of the resolved config (CLI overrides). */
export interface BenchRunConfigOverrides {
  /** Comma-separated subset of task ids the user passed via `--tasks <list>`. */
  tasksList?: string[];
  seedsPerArm?: number;
  parallel?: number;
}

/**
 * Resolve a path string supporting `~` expansion and `${VAR}` env-var
 * expansion. Relative paths are resolved against `baseDir`.
 */
export function resolvePathString(value: string, baseDir: string): string {
  let s = value;
  // Expand ${VAR} and $VAR forms — matches the conventional shell forms.
  s = s.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, name) => process.env[name] ?? "");
  s = s.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_m, name) => process.env[name] ?? "");
  // Tilde expansion. `~` alone or `~/...`; we don't support `~user/`.
  if (s === "~") s = os.homedir();
  else if (s.startsWith("~/")) s = path.join(os.homedir(), s.slice(2));
  if (path.isAbsolute(s)) return s;
  return path.resolve(baseDir, s);
}

/** Default per-operator providers location: `${XDG_CONFIG_HOME:-~/.config}/akm/bench-providers.json`. */
export function defaultUserProvidersPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const root = xdg && xdg.length > 0 ? xdg : path.join(os.homedir(), ".config");
  return path.join(root, "akm", "bench-providers.json");
}

/**
 * Resolve the providers file using the §A discovery chain and load it.
 *
 *   1. `BENCH_OPENCODE_CONFIG` env var (absolute path).
 *   2. `providers` inline in the config (materialised to a synthetic
 *      `LoadedOpencodeProviders` without touching disk).
 *   3. `providersRef` in the config (with tilde / env-var expansion).
 *   4. `${XDG_CONFIG_HOME:-~/.config}/akm/bench-providers.json`.
 *   5. Throw — the caller is expected to map this to exit code 2.
 *
 * Returns `{ providers, source }` where `source` is the absolute path the
 * providers came from (or `"<inline>"` for the inline case).
 */
export function resolveProviders(config: BenchRunConfigFile, configDir: string): LoadedOpencodeProviders {
  // 1. BENCH_OPENCODE_CONFIG env var wins.
  const envPath = process.env.BENCH_OPENCODE_CONFIG;
  if (envPath && envPath.length > 0) {
    return loadOpencodeProviders(path.isAbsolute(envPath) ? envPath : path.resolve(envPath));
  }

  // 2. Inline providers in the config.
  if (config.providers !== undefined) {
    if (config.providersRef !== undefined) {
      throw new BenchConfigError("bench run config: only one of `providers` or `providersRef` may be set", true);
    }
    return materialiseInlineProviders(config);
  }

  // 3. Explicit providersRef.
  if (config.providersRef !== undefined) {
    const resolved = resolvePathString(config.providersRef, configDir);
    return loadOpencodeProviders(resolved);
  }

  // 4. Per-operator default location.
  const userPath = defaultUserProvidersPath();
  if (fs.existsSync(userPath)) {
    return loadOpencodeProviders(userPath);
  }

  // 5. Repo-local fallbacks — the same locations the legacy
  //    `discoverOpencodeProviders` checks. The gitignored `.local.json`
  //    overlay wins over the committed fixture so an operator's local
  //    overrides survive a `git pull` without needing a config edit.
  const repoLocalPath = path.resolve(__dirname, "..", "fixtures", "bench", "opencode-providers.local.json");
  if (fs.existsSync(repoLocalPath)) {
    return loadOpencodeProviders(repoLocalPath);
  }
  const repoFixturePath = path.resolve(__dirname, "..", "fixtures", "bench", "opencode-providers.json");
  if (fs.existsSync(repoFixturePath)) {
    return loadOpencodeProviders(repoFixturePath);
  }

  // 6. No providers found.
  throw new BenchConfigError(
    `bench run config: no opencode providers found. Set \`providers\` or \`providersRef\` in the config, set BENCH_OPENCODE_CONFIG, or create ${userPath}.`,
    true,
  );
}

/**
 * Build a `LoadedOpencodeProviders` from an inline `providers` map without
 * round-tripping through disk. We still validate via `loadOpencodeProviders`
 * by writing to a tmp file? No — that would risk leaving secrets on disk.
 * Instead, do a minimal in-memory validation that matches what the on-disk
 * loader checks (forbidden top-level keys are not applicable here, since
 * the inline providers already live inside a `providers` object; but the
 * credential heuristic still applies).
 */
function materialiseInlineProviders(config: BenchRunConfigFile): LoadedOpencodeProviders {
  if (config.providers === null || typeof config.providers !== "object" || Array.isArray(config.providers)) {
    throw new BenchConfigError("bench run config: `providers` must be an object", false);
  }
  // Reuse `loadOpencodeProviders` indirectly by stamping a synthetic
  // BenchOpencodeProvidersFile — without touching disk we still want the
  // credential scan applied. The simplest path is: write a tmp file mode
  // 0o600 and load it, then unlink. That keeps the credential-scan logic
  // co-located in opencode-config.ts.
  const file: BenchOpencodeProvidersFile = {
    schemaVersion: 1,
    providers: config.providers,
    ...(config.defaultModel !== undefined ? { defaultModel: config.defaultModel } : {}),
  };
  // Per #276: bench tmp dirs MUST live under `${AKM_CACHE_DIR}/bench/`,
  // never the OS-default tmp root. `benchMkdtemp` is the drop-in.
  const tmpDir = benchMkdtemp("akm-bench-inline-");
  const tmpPath = path.join(tmpDir, "providers.json");
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(file), { mode: 0o600 });
    const loaded = loadOpencodeProviders(tmpPath);
    return { ...loaded, source: "<inline>" };
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
}

/** Load + validate a baseline JSON file: `{ taskId: passRate (0..1) }`. */
export function loadBaseline(absPath: string): Record<string, number> {
  let raw: string;
  try {
    raw = fs.readFileSync(absPath, "utf8");
  } catch (err) {
    throw new BenchConfigError(
      `bench run config: cannot read baseline file "${absPath}": ${err instanceof Error ? err.message : String(err)}`,
      true,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new BenchConfigError(
      `bench run config: baseline file "${absPath}" is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      false,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new BenchConfigError(
      `bench run config: baseline file "${absPath}" must be a JSON object of taskId → passRate`,
      false,
    );
  }
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
      throw new BenchConfigError(
        `bench run config: baseline entry ${JSON.stringify(key)} in "${absPath}" must be a number in [0, 1]; got ${JSON.stringify(value)}`,
        false,
      );
    }
    out[key] = value;
  }
  return out;
}

/**
 * Resolve the `tasks` selector to a concrete `TaskMetadata[]` plus a slice
 * label for the report's `corpus.slice` field.
 */
export function resolveTasks(selector: string | string[] | undefined): {
  tasks: TaskMetadata[];
  slice: "all" | TaskSlice;
} {
  // Default = "all" when the field is omitted entirely.
  if (selector === undefined) {
    return { tasks: listTasks(), slice: "all" };
  }
  if (typeof selector === "string") {
    if (selector === "all" || selector === "train" || selector === "eval") {
      const sliceFilter = selector === "all" ? undefined : (selector as TaskSlice);
      const tasks = listTasks(sliceFilter ? { slice: sliceFilter } : {});
      return { tasks, slice: selector };
    }
    // Single task id ("domain/name") — try direct lookup first.
    if (selector.includes("/")) {
      try {
        return { tasks: [loadTask(selector)], slice: "all" };
      } catch {
        // Fall through to "no match" error below.
      }
      throw new BenchConfigError(`bench run config: tasks: no task matched "${selector}"`, true);
    }
    // Domain prefix (no slash).
    const all = listTasks();
    const matches = all.filter((t) => t.domain === selector);
    if (matches.length === 0) {
      throw new BenchConfigError(
        `bench run config: tasks: no task matched domain "${selector}". Available domains: ${[...new Set(all.map((t) => t.domain))].sort().join(", ") || "(none)"}`,
        true,
      );
    }
    return { tasks: matches, slice: "all" };
  }
  // Array of task ids.
  if (selector.length === 0) {
    throw new BenchConfigError("bench run config: tasks: array must be non-empty", true);
  }
  const out: TaskMetadata[] = [];
  for (const id of selector) {
    try {
      out.push(loadTask(id));
    } catch {
      throw new BenchConfigError(`bench run config: tasks: no task matched "${id}"`, true);
    }
  }
  return { tasks: out, slice: "all" };
}

/**
 * Validate the parsed config against the v1 schema (in-code, no JSON
 * Schema runtime — keeps the bench self-contained). Throws BenchConfigError
 * on the first violation.
 */
function validateConfig(parsed: unknown, source: string): BenchRunConfigFile {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new BenchConfigError(`bench run config: root of ${source} must be a JSON object`, false);
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.schemaVersion !== 1) {
    throw new BenchConfigError(
      `bench run config: ${source}: unsupported schemaVersion ${JSON.stringify(obj.schemaVersion)}; expected 1`,
      false,
    );
  }
  const allowed = new Set([
    "$schema",
    "schemaVersion",
    "name",
    "description",
    "providers",
    "providersRef",
    "defaultModel",
    "tasks",
    "arms",
    "seeds",
    "budgetTokens",
    "budgetWallMs",
    "parallel",
    "forceParallel",
    "baseline",
  ]);
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      throw new BenchConfigError(`bench run config: ${source}: unknown field "${key}"`, false);
    }
  }
  if (obj.providers !== undefined && obj.providersRef !== undefined) {
    throw new BenchConfigError(
      `bench run config: ${source}: only one of "providers" or "providersRef" may be set`,
      true,
    );
  }
  if (obj.tasks !== undefined) {
    if (typeof obj.tasks !== "string" && !Array.isArray(obj.tasks)) {
      throw new BenchConfigError(`bench run config: ${source}: "tasks" must be a string or array of strings`, false);
    }
    if (Array.isArray(obj.tasks)) {
      for (const t of obj.tasks) {
        if (typeof t !== "string") {
          throw new BenchConfigError(`bench run config: ${source}: every entry in "tasks" must be a string`, false);
        }
      }
    }
  }
  if (obj.arms !== undefined) {
    if (!Array.isArray(obj.arms) || obj.arms.length === 0) {
      throw new BenchConfigError(`bench run config: ${source}: "arms" must be a non-empty array`, false);
    }
    for (const a of obj.arms) {
      if (a !== "noakm" && a !== "akm" && a !== "synthetic") {
        throw new BenchConfigError(
          `bench run config: ${source}: invalid arm ${JSON.stringify(a)}; expected one of "noakm", "akm", "synthetic"`,
          false,
        );
      }
    }
  }
  for (const numField of ["seeds", "budgetTokens", "budgetWallMs", "parallel"] as const) {
    const val = obj[numField];
    if (val !== undefined) {
      if (typeof val !== "number" || !Number.isInteger(val) || val < 1) {
        throw new BenchConfigError(`bench run config: ${source}: "${numField}" must be a positive integer`, false);
      }
    }
  }
  return obj as unknown as BenchRunConfigFile;
}

/**
 * Load and resolve a bench run config from disk.
 *
 * @param configPath  Absolute or relative path to the config JSON file.
 * @param overrides   CLI-derived overrides applied on top of the config.
 */
export function loadBenchRunConfig(
  configPath: string,
  overrides: BenchRunConfigOverrides = {},
): ResolvedBenchRunConfig {
  const absPath = path.isAbsolute(configPath) ? configPath : path.resolve(configPath);
  if (!fs.existsSync(absPath)) {
    throw new BenchConfigError(`bench run config: file not found: ${absPath}`, true);
  }
  let raw: string;
  try {
    raw = fs.readFileSync(absPath, "utf8");
  } catch (err) {
    throw new BenchConfigError(
      `bench run config: cannot read ${absPath}: ${err instanceof Error ? err.message : String(err)}`,
      true,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new BenchConfigError(
      `bench run config: ${absPath}: invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
      false,
    );
  }
  const config = validateConfig(parsed, absPath);
  const configDir = path.dirname(absPath);

  const providers = resolveProviders(config, configDir);

  const envModel = process.env.BENCH_OPENCODE_MODEL;
  const model =
    (envModel && envModel.length > 0 ? envModel : undefined) ?? config.defaultModel ?? providers.defaultModel;
  if (!model) {
    throw new BenchConfigError(
      `bench run config: ${absPath}: no model specified. Set "defaultModel" in the config, set "defaultModel" in the providers file, or set BENCH_OPENCODE_MODEL.`,
      true,
    );
  }

  // Resolve tasks (with optional CLI list override).
  let resolved = resolveTasks(config.tasks);
  if (overrides.tasksList && overrides.tasksList.length > 0) {
    const set = new Set(overrides.tasksList);
    const filtered = resolved.tasks.filter((t) => set.has(t.id));
    const missing = overrides.tasksList.filter((id) => !resolved.tasks.some((t) => t.id === id));
    if (missing.length > 0) {
      throw new BenchConfigError(
        `bench run config: --tasks override: no task in the config matched ${JSON.stringify(missing.join(", "))}`,
        true,
      );
    }
    resolved = { tasks: filtered, slice: resolved.slice };
  }
  if (resolved.tasks.length === 0) {
    throw new BenchConfigError(`bench run config: ${absPath}: task selector matched zero tasks`, true);
  }

  let baselineByTaskId: Record<string, number> | undefined;
  if (config.baseline) {
    const baselinePath = resolvePathString(config.baseline, configDir);
    baselineByTaskId = loadBaseline(baselinePath);
  }

  const arms: Arm[] = config.arms ?? ["noakm", "akm"];
  const seedsPerArm = overrides.seedsPerArm ?? config.seeds;
  const parallel = overrides.parallel ?? config.parallel;

  const name = config.name ?? path.basename(absPath, path.extname(absPath));

  return {
    source: absPath,
    name,
    providers,
    model,
    tasks: resolved.tasks,
    arms,
    ...(seedsPerArm !== undefined ? { seedsPerArm } : {}),
    ...(config.budgetTokens !== undefined ? { budgetTokens: config.budgetTokens } : {}),
    ...(config.budgetWallMs !== undefined ? { budgetWallMs: config.budgetWallMs } : {}),
    ...(parallel !== undefined ? { parallel } : {}),
    ...(config.forceParallel ? { forceParallel: true } : {}),
    ...(baselineByTaskId ? { baselineByTaskId } : {}),
    slice: resolved.slice,
  };
}
