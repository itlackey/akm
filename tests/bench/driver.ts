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
  /**
   * Injected `Bun.spawn` replacement for unit tests. When supplied it is
   * used for BOTH the agent spawn and the verifier spawn. Real runs leave
   * this `undefined` so each phase uses `Bun.spawn` directly.
   */
  spawn?: SpawnFn;
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

/** Run result envelope (spec §5.2). */
export interface RunResult {
  schemaVersion: 1;
  taskId: string;
  arm: string;
  seed: number;
  model: string;
  outcome: "pass" | "fail" | "budget_exceeded" | "harness_error";
  tokens: { input: number; output: number };
  wallclockMs: number;
  trajectory: TrajectoryRecord;
  events: EventEnvelope[];
  verifierStdout: string;
  verifierExitCode: number;
}

/** Operator-config env names that MUST NOT leak into per-run children. */
const ISOLATED_ENV_NAMES = ["OPENCODE_CONFIG", "AKM_STASH_DIR", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"] as const;

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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akm-bench-run-"));
  const cacheHome = path.join(root, "cache");
  const configHome = path.join(root, "config");
  const opencodeConfig = path.join(root, "opencode-config");
  fs.mkdirSync(cacheHome, { recursive: true });
  fs.mkdirSync(configHome, { recursive: true });
  fs.mkdirSync(opencodeConfig, { recursive: true });
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
    OPENCODE_CONFIG: dirs.opencodeConfig,
    BENCH_OPENCODE_MODEL: model,
  };
  if (dirs.akmStashDir) env.AKM_STASH_DIR = dirs.akmStashDir;
  return env;
}

/** Best-effort token-usage parser for opencode stdout. Returns zeros if absent. */
export function parseTokenUsage(stdout: string): { input: number; output: number } {
  // opencode prints lines like `tokens: input=1234 output=5678` in some
  // configurations. We look for the keys defensively; missing values stay 0.
  const out = { input: 0, output: 0 };
  const inputMatch = stdout.match(/(?:input[_\s-]?tokens?|tokens?[_\s-]?input)[\s:=]+(\d+)/i);
  const outputMatch = stdout.match(/(?:output[_\s-]?tokens?|tokens?[_\s-]?output)[\s:=]+(\d+)/i);
  if (inputMatch) out.input = Number.parseInt(inputMatch[1], 10);
  if (outputMatch) out.output = Number.parseInt(outputMatch[1], 10);
  return out;
}

/**
 * Read the events.jsonl file produced by this run, if any. The path is
 * `<XDG_CACHE_HOME>/akm/events.jsonl` per `src/core/events.ts`.
 */
export function readRunEvents(cacheHome: string): EventEnvelope[] {
  const eventsPath = path.join(cacheHome, "akm", "events.jsonl");
  if (!fs.existsSync(eventsPath)) return [];
  const text = fs.readFileSync(eventsPath, "utf8");
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
  return [
    `Task: ${options.taskId}`,
    `Arm: ${options.arm}`,
    `Workspace: ${options.workspace}`,
    options.arm === "akm"
      ? "An akm stash is configured via AKM_STASH_DIR. Use `akm search` and `akm show` to find relevant assets before acting."
      : "",
  ]
    .filter(Boolean)
    .join("\n");
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
    wallclockMs: 0,
    trajectory: { correctAssetLoaded: null, feedbackRecorded: null },
    events: [],
    verifierStdout: "",
    verifierExitCode: -1,
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

  const dirs = createIsolationDirs(options.stashDir);
  const env = buildIsolatedEnv(dirs, options.model);

  try {
    const agentResult = await runAgent(profile, options.prompt ?? defaultPrompt(options), {
      env,
      cwd: options.workspace,
      timeoutMs: options.budgetWallMs,
      stdio: "captured",
      ...(options.spawn ? { spawn: options.spawn } : {}),
    });

    result.wallclockMs = agentResult.durationMs;
    result.tokens = parseTokenUsage(agentResult.stdout);
    result.events = readRunEvents(dirs.cacheHome);

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
    // if we could parse a number AND it exceeds the cap.
    const totalTokens = result.tokens.input + result.tokens.output;
    if (totalTokens > 0 && totalTokens > options.budgetTokens) {
      result.outcome = "budget_exceeded";
      return result;
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
    // Always tear down the isolation tmpdir. We copy events out before
    // deletion (see readRunEvents above), so this is safe.
    fs.rmSync(dirs.root, { recursive: true, force: true });
  }
}

/** Exposed for the unit test that asserts operator env never leaks. */
export const _ISOLATED_ENV_NAMES = ISOLATED_ENV_NAMES;
