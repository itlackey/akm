/**
 * akm-bench driver — `runOne(options)` executes a single (task, arm, seed)
 * triple end-to-end and returns a v1 RunResult envelope.
 *
 * See `docs/technical/benchmark.md` §5.2 for the locked schema and §7.1/§7.2
 * for the isolation/budget rules. The shapes here are the v1 contract that
 * #238/#239/#240/#243 will extend without breaking.
 *
 * Design notes:
 *   • The driver invokes opencode through `runAgent` with the built-in
 *     `opencode` profile. No new harness abstraction.
 *   • Per-run isolation: every run gets fresh tmpdirs for `XDG_CACHE_HOME`,
 *     `XDG_CONFIG_HOME`, `OPENCODE_CONFIG`, and (when `stashDir` is provided)
 *     `AKM_STASH_DIR`. The operator's personal opencode/akm config is NEVER
 *     read or written.
 *   • Hard budgets: `budgetWallMs` is enforced via `runAgent`'s timeout. A
 *     timeout produces `outcome: "budget_exceeded"`, which is a distinct
 *     state from `fail` so cost regressions stay visible.
 *   • This issue (#236) does not need a real opencode call to work end-to-end.
 *     The harness shape, isolation, and result envelope must be correct and
 *     unit-testable with an injected fake spawn.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { EventEnvelope } from "../../src/core/events";
import { BUILTIN_AGENT_PROFILE_NAMES, getBuiltinAgentProfile } from "../../src/integrations/agent/profiles";
import { runAgent, type SpawnFn } from "../../src/integrations/agent/spawn";
import { setupBenchEnvironment } from "./environment";
import { BenchConfigError, type LoadedOpencodeProviders } from "./opencode-config";
import { benchMkdtemp } from "./tmp";
import { runVerifier } from "./verifier";

/** Run option envelope (spec §5.2). */
export interface RunOptions {
  track: "utility" | "evolve";
  arm: "noakm" | "akm" | "post-evolve" | "synthetic";
  taskId: string;
  /** Ephemeral tmp dir; the agent's cwd. The driver does NOT create it. */
  workspace: string;
  /** Materialised akm stash dir. Omitted for `noakm` and `synthetic` arms. */
  stashDir?: string;
  /** Model identifier, stamped verbatim into RunResult. e.g. `anthropic/claude-opus-4-7`. */
  model: string;
  /** Single seed; aggregation across seeds is the caller's job. */
  seed: number;
  budgetTokens: number;
  budgetWallMs: number;
  /**
   * Verifier kind for the task. The corpus loader resolves this from
   * `task.yaml`; the driver simply forwards it to `runVerifier`.
   */
  verifier: "script" | "pytest" | "regex";
  /** Directory containing `verify.sh` / `tests/` / `expected_match` config. */
  taskDir: string;
  /** Required when `verifier: "regex"`. */
  expectedMatch?: string;
  /** Prompt forwarded to opencode. Defaults to a stub if omitted. */
  prompt?: string;
  /** Human-readable task title from task.yaml, injected into the prompt. */
  taskTitle?: string;
  /**
   * Pre-resolved akm search keywords from task.yaml `akm_keywords` field.
   * When set, the driver puts a concrete `akm search <keywords>` command on
   * line 1 of the akm-arm prompt. When absent, falls back to the task domain.
   */
  akmKeywords?: string;
  /**
   * Injected `Bun.spawn` replacement for unit tests. When supplied it is
   * used for BOTH the agent spawn and the verifier spawn. Real runs leave
   * this `undefined` so each phase uses `Bun.spawn` directly.
   */
  spawn?: SpawnFn;
  /**
   * Optional collector for run-scoped warnings (e.g. events.jsonl truncated
   * because it exceeded the read cap). The runner threads this in so the
   * top-level report's `warnings[]` aggregates every cap hit.
   */
  warnings?: string[];
  /**
   * Pre-loaded opencode provider config. When supplied, `runOne` materialises
   * the provider entry matching `options.model` into the per-run
   * `OPENCODE_CONFIG` directory before spawning the agent. When omitted, the
   * dir is left empty and opencode falls back to its cloud-provider defaults.
   */
  opencodeProviders?: LoadedOpencodeProviders;
  /**
   * Path to a pre-built index cache home (`<dir>/akm/index.db` exists here).
   * When supplied, `runOne` copies the index into the per-run `XDG_CACHE_HOME`
   * instead of re-running `akm index --full` on every seed. This avoids the
   * ~300–600ms re-index penalty per (task, arm, seed) triple.
   */
  indexCacheHome?: string;
}

/**
 * Trajectory record. For #236 the two fields are filled with `null` whenever
 * `gold_ref` is unknown for the task. Real trajectory parsing lands in #238
 * — extending this type is non-breaking.
 */
export interface TrajectoryRecord {
  correctAssetLoaded: boolean | null;
  feedbackRecorded: boolean | null;
}

/**
 * Distinguishes real zero-token measurements from missing or unsupported
 * token reporting (issue #252). Aggregations MUST skip runs where this is
 * not `"parsed"` rather than treating numeric zero as a measured value.
 *
 *   - `"parsed"`     — token usage was extracted from agent stdout.
 *   - `"missing"`    — agent emits token usage in some configurations but
 *                      we could not parse it on this run.
 *   - `"unsupported"`— the agent profile / harness does not report tokens
 *                      at all (e.g. a synthetic-arm fake).
 */
export type TokenMeasurementStatus = "parsed" | "missing" | "unsupported";

/** Run result envelope (spec §5.2). */
export interface RunResult {
  schemaVersion: 1;
  taskId: string;
  arm: string;
  seed: number;
  model: string;
  outcome: "pass" | "fail" | "budget_exceeded" | "harness_error";
  tokens: { input: number; output: number };
  /**
   * Status of the token-usage measurement on this run (issue #252). Aggregate
   * metrics MUST skip runs whose measurement is not `"parsed"` and report-
   * level surfaces SHOULD warn when any run lacks parsed token usage. The
   * field is optional on the type for backward compatibility — older
   * artefacts (and older test fixtures) without this field are treated as
   * `"parsed"` so historical reports remain analysable. New runs always
   * stamp a value.
   */
  tokenMeasurement?: TokenMeasurementStatus;
  wallclockMs: number;
  trajectory: TrajectoryRecord;
  events: EventEnvelope[];
  verifierStdout: string;
  verifierExitCode: number;
  /**
   * Unique asset refs the agent loaded during this run, extracted post-hoc by
   * scanning `events[]` and `verifierStdout` for `akm show <ref>` invocations.
   * Populated by the runner; the driver always emits an empty array. Field is
   * additive — older RunResult JSON without it remains valid (callers that
   * read older artefacts should default to `[]`). See spec §6.5 (per-asset
   * attribution).
   */
  assetsLoaded: string[];
  /**
   * Failure-mode taxonomy label (spec §6.6). Set by the runner via
   * `classifyFailureMode` for every failed akm-arm RunResult; `null` for
   * passing runs, budget_exceeded, harness_error, and noakm-arm runs.
   * Spliced in additively after `runOne` returns; the driver itself never
   * populates this field.
   */
  failureMode?: import("./metrics").FailureMode | null;
}

/** Operator-config env names that MUST NOT leak into per-run children. */
const ISOLATED_ENV_NAMES = ["OPENCODE_CONFIG", "AKM_STASH_DIR", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"] as const;

/**
 * Operator-env names that MUST be stripped from `envSource` before the bench
 * driver hands it to `runAgent`. These are credentials and config-dir hints
 * that belong to the operator's *interactive* environment and have no
 * business inside a bench-arm child:
 *
 *   • `OPENCODE_API_KEY` / `ANTHROPIC_API_KEY` — real-money credentials. The
 *     opencode profile lists `OPENCODE_API_KEY` in `envPassthrough`, so
 *     without explicit scrubbing the bench would forward the operator's key
 *     into every (task × arm × seed) child. Bench is hermetic by design;
 *     credentials must be supplied through the bench's own config surface,
 *     not inherited.
 *   • `AKM_CONFIG_DIR` — points akm at the operator's stash config. Letting
 *     this leak defeats the per-run isolation tmpdirs `createIsolationDirs`
 *     materialises (XDG_CACHE_HOME / XDG_CONFIG_HOME) and would cause
 *     bench runs to read the operator's writable config.
 *
 * Recurrence guard for #271 (mirrors the #243/#251 fixup pattern of
 * pinning isolation behaviour with regression tests).
 */
const SCRUBBED_OPERATOR_ENV_NAMES = ["OPENCODE_API_KEY", "ANTHROPIC_API_KEY", "AKM_CONFIG_DIR"] as const;

/**
 * Build the `envSource` passed to `runAgent`. Returns a copy of `source`
 * (default: `process.env`) with `SCRUBBED_OPERATOR_ENV_NAMES` removed so
 * profile-level passthrough (`profile.envPassthrough`) cannot drag operator
 * credentials/config-dir hints into the bench-arm child.
 *
 * The returned object is a shallow copy — callers may mutate it without
 * touching the real `process.env`.
 */
export function buildSanitizedEnvSource(source?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const src = source ?? process.env;
  const out: NodeJS.ProcessEnv = { ...src };
  for (const name of SCRUBBED_OPERATOR_ENV_NAMES) {
    delete out[name];
  }
  return out;
}

/**
 * Materialise per-run isolation directories. Returns the env overrides that
 * the caller will pass to `runAgent` so the child sees ONLY these tmpdirs.
 */
export interface IsolationDirs {
  root: string;
  cacheHome: string;
  configHome: string;
  opencodeConfig: string;
  akmStashDir?: string;
}

export function createIsolationDirs(stashDir?: string): IsolationDirs {
  const root = benchMkdtemp("akm-bench-run-");
  const cacheHome = path.join(root, "cache");
  const configHome = path.join(root, "config");
  const opencodeConfig = path.join(root, "opencode-config");
  fs.mkdirSync(cacheHome, { recursive: true });
  fs.mkdirSync(configHome, { recursive: true });
  fs.mkdirSync(opencodeConfig, { recursive: true });

  // Symlink the real opencode config dir into XDG_CONFIG_HOME so opencode
  // can find its installed npm provider packages (node_modules). Without
  // this, overriding XDG_CONFIG_HOME produces an empty opencode config dir
  // and provider plugins (e.g. @ai-sdk/openai-compatible) fail to load.
  // OPENCODE_CONFIG still points to our materialised file, which opencode
  // reads in preference to XDG_CONFIG_HOME/opencode/opencode.json.
  const realOpencodeConfigDir = path.join(os.homedir(), ".config", "opencode");
  const isolatedOpencodeConfigDir = path.join(configHome, "opencode");
  if (fs.existsSync(realOpencodeConfigDir)) {
    fs.symlinkSync(realOpencodeConfigDir, isolatedOpencodeConfigDir);
  } else {
    fs.mkdirSync(isolatedOpencodeConfigDir, { recursive: true });
  }

  return {
    root,
    cacheHome,
    configHome,
    opencodeConfig,
    akmStashDir: stashDir,
  };
}

/** Build the env passed to `runAgent`. The XDG/AKM/OPENCODE keys are pinned. */
export function buildIsolatedEnv(dirs: IsolationDirs, model: string): Record<string, string> {
  const env: Record<string, string> = {
    XDG_CACHE_HOME: dirs.cacheHome,
    XDG_CONFIG_HOME: dirs.configHome,
    OPENCODE_CONFIG: path.join(dirs.opencodeConfig, "opencode.json"),
    BENCH_OPENCODE_MODEL: model,
  };
  if (dirs.akmStashDir) env.AKM_STASH_DIR = dirs.akmStashDir;
  return env;
}

/**
 * Strip `AKM_STASH_DIR` from a child env object. Used by the synthetic-arm
 * spawn path (#261) so the operator's real `AKM_STASH_DIR` cannot leak in
 * via the parent process even when the harness has copied a wider env via
 * `{ ...process.env, ...env }`. This is the recurrence guard for the #243
 * fixup pattern — a synthetic-arm child must NEVER inherit a stash.
 *
 * Mutates `env` in place and returns it for ergonomic chaining.
 */
export function stripAkmStashDir(env: Record<string, string | undefined>): Record<string, string | undefined> {
  delete env.AKM_STASH_DIR;
  return env;
}

/**
 * Best-effort token-usage parser for opencode stdout. Returns numeric token
 * counts AND a measurement status so callers can distinguish a real zero
 * (`"parsed"`, both fields legitimately 0) from an unparseable / absent
 * report (`"missing"`, both fields default to 0 but downstream aggregation
 * MUST skip the run rather than treat that 0 as measured).
 *
 * The harness never emits `"unsupported"` from this parser — that label is
 * stamped on results from arms that don't run a token-reporting agent
 * (e.g. the synthetic arm), and is set by the caller, not here.
 */
export function parseTokenUsage(stdout: string): {
  input: number;
  output: number;
  measurement: TokenMeasurementStatus;
} {
  // opencode prints lines like `tokens: input=1234 output=5678` in some
  // configurations. We look for the keys defensively; absent values mean we
  // could not measure (`measurement: "missing"`).
  const inputMatch = stdout.match(/(?:input[_\s-]?tokens?|tokens?[_\s-]?input)[\s:=]+(\d+)/i);
  const outputMatch = stdout.match(/(?:output[_\s-]?tokens?|tokens?[_\s-]?output)[\s:=]+(\d+)/i);
  if (!inputMatch && !outputMatch) {
    return { input: 0, output: 0, measurement: "missing" };
  }
  return {
    input: inputMatch ? Number.parseInt(inputMatch[1], 10) : 0,
    output: outputMatch ? Number.parseInt(outputMatch[1], 10) : 0,
    measurement: "parsed",
  };
}

/**
 * Maximum bytes read from events.jsonl per run. A runaway agent producing
 * GBs of structured-log output would otherwise OOM the bench. Trajectory
 * parsing operates on the prefix; a warning is appended when the cap is
 * hit so the report surfaces the truncation.
 */
export const EVENTS_READ_CAP_BYTES = 16 * 1024 * 1024;

/**
 * Read the events.jsonl file produced by this run, if any. The path is
 * `<XDG_CACHE_HOME>/akm/events.jsonl` per `src/core/events.ts`.
 *
 * Caps the number of bytes read at `EVENTS_READ_CAP_BYTES` (16 MiB). When the
 * file is larger, the prefix is parsed and a warning is appended to
 * `opts.warnings` (when supplied). The trailing partial line after a
 * truncation is dropped, since `JSON.parse` would reject it anyway.
 */
export function readRunEvents(cacheHome: string, opts?: { warnings?: string[] }): EventEnvelope[] {
  const eventsPath = path.join(cacheHome, "akm", "events.jsonl");
  if (!fs.existsSync(eventsPath)) return [];

  // Read up to the cap. We open the file rather than `readFileSync` so we
  // don't allocate an arbitrarily large buffer just to throw most of it away.
  let totalSize = 0;
  try {
    totalSize = fs.statSync(eventsPath).size;
  } catch {
    return [];
  }
  const cap = EVENTS_READ_CAP_BYTES;
  const truncated = totalSize > cap;
  let text: string;
  if (truncated) {
    const buf = Buffer.alloc(cap);
    const fd = fs.openSync(eventsPath, "r");
    try {
      fs.readSync(fd, buf, 0, cap, 0);
    } finally {
      fs.closeSync(fd);
    }
    text = buf.toString("utf8");
    // Drop the partial trailing line so we don't try to parse half a record.
    const lastNl = text.lastIndexOf("\n");
    if (lastNl !== -1) text = text.slice(0, lastNl);
    if (opts?.warnings) {
      opts.warnings.push(
        `events.jsonl truncated: ${totalSize} bytes exceeds ${cap}-byte cap; trajectory computed from the prefix.`,
      );
    }
  } else {
    text = fs.readFileSync(eventsPath, "utf8");
  }

  const out: EventEnvelope[] = [];
  let id = 0;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as Omit<EventEnvelope, "id"> & { id?: number };
      out.push({ ...parsed, id: parsed.id ?? id });
      id += 1;
    } catch {
      // Skip malformed lines — events stream is best-effort upstream.
    }
  }
  return out;
}

/** Default prompt forwarded to opencode when caller omits one. */
function defaultPrompt(options: RunOptions): string {
  // For non-akm arms: keep the minimal format so the model is forced to read
  // the workspace README.md to discover task specifics. Injecting the title
  // here causes the model to answer from the prompt alone and skip the README,
  // which breaks tasks where specific parameter values (names, IDs) only appear
  // in the workspace files.
  if (options.arm !== "akm") {
    return [`Task: ${options.taskId}`, `Arm: ${options.arm}`, `Workspace: ${options.workspace}`].join("\n");
  }

  const title = options.taskTitle ? `\n${options.taskTitle}` : "";
  const taskLine = `Task: ${options.taskId}${title}`;

  // Derive search keywords: prefer explicit field, fall back to task domain.
  const keywords = options.akmKeywords ?? options.taskId.split("/")[0].replace(/-/g, " ");

  // Force the model to use the bash tool to run akm CLI commands before
  // writing any output. Each step is an explicit bash invocation so the
  // model cannot skip to writing the answer without executing the commands.
  return [
    `You have access to a knowledge stash via the akm CLI tool.`,
    ``,
    `Step 1 — open a terminal and execute this bash command:`,
    `  bash: akm search ${keywords}`,
    ``,
    `Step 2 — from the search results, execute:`,
    `  bash: akm show <ref>   (e.g. akm show skill:${keywords.split(" ")[0]})`,
    ``,
    `Step 3 — read README.md in the workspace to understand the specific task requirements:`,
    `  bash: cat ${options.workspace}/README.md`,
    ``,
    `Step 4 — using the skill content from step 2 and the task requirements from step 3,`,
    `write the answer to ${options.workspace}/commands.txt`,
    ``,
    `Step 5 — execute:`,
    `  bash: akm feedback <ref> --positive   (or --negative)`,
    ``,
    `DO NOT write commands.txt before running steps 1 and 2.`,
    ``,
    taskLine,
    `Workspace: ${options.workspace}`,
  ].join("\n");
}

/**
 * Run a single (task, arm, seed) and return the v1 RunResult envelope.
 *
 * The function never throws on infrastructure failures — every error path
 * is captured into the returned RunResult with a stable outcome value.
 */
export async function runOne(options: RunOptions): Promise<RunResult> {
  // Stamp a baseline result; we mutate fields below as the run progresses.
  const result: RunResult = {
    schemaVersion: 1,
    taskId: options.taskId,
    arm: options.arm,
    seed: options.seed,
    model: options.model,
    outcome: "harness_error",
    tokens: { input: 0, output: 0 },
    tokenMeasurement: "missing",
    wallclockMs: 0,
    trajectory: { correctAssetLoaded: null, feedbackRecorded: null },
    events: [],
    verifierStdout: "",
    verifierExitCode: -1,
    assetsLoaded: [],
  };

  // Look up the built-in opencode profile defensively. The lookup is a pure
  // map read today, but wrapping it preserves the doc-comment guarantee that
  // runOne never throws on infrastructure failures even if the registry
  // shape changes. A missing/throwing profile becomes harness_error.
  let profile: ReturnType<typeof getBuiltinAgentProfile>;
  try {
    profile = getBuiltinAgentProfile("opencode");
  } catch (err) {
    result.verifierStdout = `harness: getBuiltinAgentProfile("opencode") threw: ${err instanceof Error ? err.message : String(err)}`;
    return result;
  }
  if (!profile) {
    result.verifierStdout = `harness: built-in agent profile "opencode" missing; available: ${BUILTIN_AGENT_PROFILE_NAMES.join(", ")}`;
    return result;
  }

  // Set up the complete bench environment: isolation dirs, opencode.json
  // (with BENCH_OPENCODE_INVARIANTS), akm config.json, and FTS5 index.
  // `dryRun: true` when a test-injected spawn is present — the fake stash
  // doesn't exist on disk so the akm config and index writes are skipped.
  let benchEnv: ReturnType<typeof setupBenchEnvironment>;
  try {
    benchEnv = setupBenchEnvironment({
      model: options.model,
      arm: options.arm,
      stashDir: options.stashDir,
      indexCacheHome: options.indexCacheHome,
      providers: options.opencodeProviders,
      dryRun: !!options.spawn,
      warnings: options.warnings,
    });
  } catch (err) {
    result.verifierStdout = `harness: environment setup failed: ${err instanceof Error ? err.message : String(err)}`;
    return result;
  }

  const { dirs, env } = benchEnv;

  try {
    const agentResult = await runAgent(profile, options.prompt ?? defaultPrompt(options), {
      env,
      // #271: scrub operator credentials + config-dir hints from the env
      // source BEFORE profile.envPassthrough copies them into the child.
      // Without this, OPENCODE_API_KEY (in opencode's passthrough list) and
      // AKM_CONFIG_DIR (read by akm at startup) would leak the operator's
      // interactive environment into every bench child.
      envSource: buildSanitizedEnvSource(),
      cwd: options.workspace,
      timeoutMs: options.budgetWallMs,
      stdio: "captured",
      ...(options.spawn ? { spawn: options.spawn } : {}),
    });

    result.wallclockMs = agentResult.durationMs;
    const parsed = parseTokenUsage(agentResult.stdout);
    result.tokens = { input: parsed.input, output: parsed.output };
    result.tokenMeasurement = parsed.measurement;
    result.events = readRunEvents(dirs.cacheHome, { warnings: options.warnings });

    if (!agentResult.ok) {
      if (agentResult.reason === "timeout") {
        result.outcome = "budget_exceeded";
        return result;
      }
      // spawn_failed / non_zero_exit / parse_error all mean the harness
      // itself broke; the verifier never saw the workspace.
      if (agentResult.reason === "spawn_failed" || agentResult.reason === "parse_error") {
        result.outcome = "harness_error";
        return result;
      }
      // non_zero_exit from the agent: intentionally falls through to the
      // verifier path. Per spec §5.3 ("deterministic verifiers, never LLM"),
      // the agent is the system under test, not the judge — its exit code
      // does not gate verification. The verifier always runs against
      // whatever workspace state the agent left behind, even on a crash.
    }

    // Token-budget enforcement is best-effort: only mark `budget_exceeded`
    // if measurement was actually parsed (issue #252) AND the total exceeds
    // the cap. A `"missing"` / `"unsupported"` measurement MUST NOT silently
    // mask a budget overrun as a pass — it leaves the verifier to decide.
    if (result.tokenMeasurement === "parsed") {
      const totalTokens = result.tokens.input + result.tokens.output;
      if (totalTokens > options.budgetTokens) {
        result.outcome = "budget_exceeded";
        return result;
      }
    }

    const verifierResult = await runVerifier(options.taskDir, options.workspace, options.verifier, {
      agentStdout: agentResult.stdout,
      expectedMatch: options.expectedMatch,
      ...(options.spawn ? { spawn: options.spawn } : {}),
    });

    result.verifierStdout = verifierResult.stdout;
    result.verifierExitCode = verifierResult.exitCode;
    if (verifierResult.exitCode === 127) {
      // Missing runtime (e.g. pytest not on PATH) — not the agent's fault.
      result.outcome = "harness_error";
    } else {
      result.outcome = verifierResult.exitCode === 0 ? "pass" : "fail";
    }
    return result;
  } finally {
    // Always tear down the isolation tmpdir. Events are read out before
    // deletion (see readRunEvents above), so this is safe.
    benchEnv.teardown();
  }
}

/** Exposed for the unit test that asserts operator env never leaks. */
export const _ISOLATED_ENV_NAMES = ISOLATED_ENV_NAMES;

/**
 * Exposed for the #271 regression test that asserts operator credentials +
 * `AKM_CONFIG_DIR` never reach a bench-arm child via profile.envPassthrough.
 */
export const _SCRUBBED_OPERATOR_ENV_NAMES = SCRUBBED_OPERATOR_ENV_NAMES;
