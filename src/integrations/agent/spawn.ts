// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Agent CLI spawn wrapper (v1 spec §12.2).
 *
 * Single helper that owns:
 *   • Process spawn (Bun's subprocess API).
 *   • Captured vs interactive stdio.
 *   • Hard timeout (per-call override or profile default).
 *   • Structured failure reasons — `timeout`, `spawn_failed`,
 *     `non_zero_exit`, `parse_error`.
 *
 * NEVER imports an LLM SDK. Agents are reachable only via shell-out;
 * this is a pre-emptive guarantee against the #222 invariant.
 */
import { parseEmbeddedJsonResponse } from "../../core/parse";
import { collectAllowlistedEnv, supplementPathForSchedulerContext } from "../../core/spawn-env";
import {
  runManagedSubprocess,
  type SpawnedSubprocess,
  type SpawnFn,
  type StreamReadResult,
  streamCaptureFailure,
} from "../../core/subprocess";
import { getCommandBuilder } from "./builders";
import { DEFAULT_AGENT_TIMEOUT_MS } from "./config";
import type { AgentParseMode, AgentProfile, AgentStdioMode } from "./profiles";

/** Stable failure-reason vocabulary. Wider strings are not allowed.
 *
 * Note on `content_policy_reject`: this is NOT an LLM fault — it is a
 * downstream deterministic content-policy guard (e.g. reflect's
 * EXCESSIVE_SHRINKAGE/EXCESSIVE_EXPANSION size rails) rejecting an
 * otherwise well-formed LLM response. The agent worked; our guard blocked
 * the output. Health aggregators count these in a separate
 * `guardRejected` bucket so the LLM-failure-rate numerator is not
 * inflated. See `/tmp/akm-health-investigations/metrics-taxonomy-review.md`
 * §1a / Pattern A.
 *
 * Note on `unsupported_type`: deterministic type-guard rejection. Reflect
 * refuses to operate on non-markdown asset types (script, env, secret, task);
 * the LLM is never even invoked. Previously emitted as `parse_error` and
 * conflated with true LLM failures — see review §1a, "Reflect refused
 * asset type" row (~9% of reflect-failed events). Routed to the
 * `reflect-skipped` action bucket by the improve loop so it does not
 * inflate the failure-rate numerator.
 *
 * Note on `no_change`: deterministic noise-gate suppression (#580). The
 * agent responded fine but the candidate edit is byte-identical to the
 * current asset (empty diff) or differs only cosmetically (whitespace
 * reflow, code-fence language hints, YAML scalar re-folding). Not an LLM
 * fault and not a queue-worthy proposal — routed to the `reflect-skipped`
 * action bucket like `unsupported_type`. */
export type AgentFailureReason =
  | "timeout"
  | "spawn_failed"
  | "non_zero_exit"
  | "parse_error"
  | "cooldown"
  | "llm_rate_limit"
  | "llm_content_filter"
  | "llm_invalid_json"
  | "content_policy_reject"
  | "unsupported_type"
  | "no_change"
  // Cooperative cancellation via RunAgentOptions.signal (P0.5 seam for the
  // workflow scheduler's budget preemption). Distinct from "timeout" so
  // callers can tell a budget/user abort from a wall-clock expiry.
  | "aborted";

/**
 * Per-call options for {@link runAgent}. All fields are optional. Caller
 * may override `stdio`, `timeoutMs`, and `parseOutput`.
 */
export interface RunAgentOptions {
  /** Override `profile.stdio`. Captured = pipe stdout/stderr; interactive = inherit. */
  stdio?: AgentStdioMode;
  /** Override the profile/global timeout (ms). null = no timeout (runs until the process exits). */
  timeoutMs?: number | null;
  /** Override `profile.parseOutput`. */
  parseOutput?: AgentParseMode;
  /** Extra env vars merged on top of the profile-derived env. */
  env?: Record<string, string>;
  /** Working directory for the child. */
  cwd?: string;
  /** Extra args appended after the builder-constructed argv. */
  args?: readonly string[];
  /** Optional stdin payload (only honoured in `captured` mode). */
  stdin?: string;
  /**
   * Cooperative cancellation. When the signal aborts, the child process
   * group gets SIGTERM (then SIGKILL after 5 s) and the run resolves with
   * `reason: "aborted"`. Lets a scheduler preempt a running agent at a
   * budget ceiling instead of waiting out the timeout.
   */
  signal?: AbortSignal;
  /** Process env source. Defaults to `process.env`. Tests inject a fake. */
  envSource?: NodeJS.ProcessEnv;
  /** Spawn function. Defaults to the runtime spawn. Tests inject a fake. */
  spawn?: SpawnFn;
  /**
   * `setTimeout` shim. Defaults to the global. Tests pass a synchronous
   * timer driver so timeout assertions are deterministic.
   */
  setTimeoutFn?: typeof setTimeout;
  /** `clearTimeout` shim. Defaults to the global. */
  clearTimeoutFn?: typeof clearTimeout;
  /**
   * Observability seam (redesign addendum R2, `workflow watch`): invoked at
   * spawn start and spawn exit with ids/status only — pid, profile name,
   * exit code, failure reason. NEVER prompt or output content (07 P1-B
   * rule). Best-effort: a throwing callback is swallowed so observability
   * can never break a dispatch. No events fire when the child was never
   * spawned (pre-spawn abort, synchronous spawn failure).
   */
  onEvent?: (evt: { type: string; data?: Record<string, unknown> }) => void;
  /**
   * Abstract dispatch parameters. When present, the platform-specific
   * AgentCommandBuilder constructs the argv from these fields (system prompt,
   * model alias, tool policy). When absent, the prompt is passed positionally.
   */
  dispatch?: import("./builder-shared").AgentDispatchRequest;
  /**
   * Builder registry override — used by tests to inject fake builders without
   * touching the global BUILTIN_BUILDERS map.
   */
  builderRegistry?: Record<string, import("./builder-shared").AgentCommandBuilder>;
}

/**
 * Best-effort token accounting for one agent run. Harness-neutral shape;
 * fields are only set when the harness actually reported them (0 is a real
 * value, absent means unknown). The CLI spawn path has no usage contract
 * yet, so today this is populated only by the OpenCode SDK runner.
 */
export interface AgentTokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
}

/** Result envelope. `ok=false` always carries a `reason`. */
export interface AgentRunResult {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  /** Parsed JSON when `parseOutput === "json"` and parsing succeeded. */
  parsed?: unknown;
  reason?: AgentFailureReason;
  /** Human-readable error message paired with `reason`. */
  error?: string;
  /** Token accounting, when the harness reported it (SDK path today). */
  usage?: AgentTokenUsage;
  /** The harness's own session id, when it exposes one (SDK path today). */
  sessionId?: string;
}

// `supplementPathForSchedulerContext` moved to `core/spawn-env` when the
// workflow `exec` unit adopted the same allowlist mechanism. Re-exported here
// because it is this module's long-standing published name.
export { supplementPathForSchedulerContext };

/**
 * Build the child env. Starts empty and copies through:
 *   • Every name in `profile.envPassthrough` (via the shared
 *     {@link collectAllowlistedEnv}, which also supplements PATH for
 *     scheduler contexts where the inherited PATH is stripped).
 *   • Every entry in `profile.env`.
 *   • Every entry in `options.env` (highest precedence).
 */
function buildChildEnv(profile: AgentProfile, options: RunAgentOptions): Record<string, string> {
  const env = collectAllowlistedEnv(profile.envPassthrough, options.envSource ?? process.env);
  if (profile.env) {
    for (const [k, v] of Object.entries(profile.env)) env[k] = v;
  }
  if (options.env) {
    for (const [k, v] of Object.entries(options.env)) env[k] = v;
  }
  return env;
}

/**
 * This path's phrasing of the SHARED incomplete-capture verdict
 * ({@link streamCaptureFailure} in `core/subprocess.ts`). The classification
 * lives in the primitive so the agent path and the workflow `exec` path cannot
 * drift apart on what "the capture did not complete" means; only the sentence
 * naming the profile is local. Message text is unchanged from the inlined copy.
 */
function streamFailureMessage(
  profileName: string,
  stdout: StreamReadResult,
  stderr: StreamReadResult,
): string | undefined {
  const failures = streamCaptureFailure(stdout, stderr);
  return failures === undefined ? undefined : `agent CLI "${profileName}" output capture failed: ${failures}`;
}

/**
 * Spawn the agent CLI described by `profile` with `prompt` (forwarded as
 * the last positional arg by default) and return a structured result.
 *
 * The `prompt` argument is appended to `profile.args` (and `options.args`)
 * unless it is `undefined`. Pass `prompt = ""` to forward an explicit
 * empty positional, or pass extra args via `options.args`.
 *
 * Failure modes (see {@link AgentFailureReason}):
 *
 *   • `spawn_failed`  — the spawn call threw synchronously.
 *   • `timeout`       — exceeded the resolved timeout.
 *   • `non_zero_exit` — child exited with a non-zero code.
 *   • `parse_error`   — `parseOutput === "json"` and stdout was not JSON.
 *
 * `ok === true` requires exit code 0 and (if `parseOutput === "json"`)
 * a successful `JSON.parse`.
 */
export async function runAgent(
  profile: AgentProfile,
  prompt: string | undefined,
  options: RunAgentOptions = {},
): Promise<AgentRunResult> {
  const stdioMode = options.stdio ?? profile.stdio;
  // null = explicitly disabled (no kill timer). undefined = runtime default.
  const timeoutMs: number | null = options.timeoutMs !== undefined ? options.timeoutMs : DEFAULT_AGENT_TIMEOUT_MS;
  const parseOutput = options.parseOutput ?? profile.parseOutput;
  const setTimeoutImpl = options.setTimeoutFn ?? setTimeout;
  const clearTimeoutImpl = options.clearTimeoutFn ?? clearTimeout;

  // Observability seam — ids/status only, best-effort (see RunAgentOptions.onEvent).
  const emitSpawnEvent = (type: string, data: Record<string, unknown>): void => {
    if (!options.onEvent) return;
    try {
      options.onEvent({ type, data });
    } catch {
      // Observability must never break the dispatch.
    }
  };

  // Build argv via the platform-specific builder when dispatch params are
  // provided; otherwise use the direct positional-prompt form.
  let builtArgv: readonly string[];
  let builtEnv: Record<string, string> | undefined;
  if (options.dispatch !== undefined) {
    const builder = getCommandBuilder(profile.platform ?? profile.name, options.builderRegistry);
    const built = builder.build(profile, options.dispatch);
    builtArgv = built.argv;
    builtEnv = built.env;
  } else {
    const positionalArgs: string[] = [...profile.args, ...(options.args ?? [])];
    if (prompt !== undefined) positionalArgs.push(prompt);
    builtArgv = [profile.bin, ...positionalArgs];
  }
  // Extra args (e.g. forwarded CLI positionals) are appended after the builder output.
  const finalArgv: string[] = [...builtArgv, ...(options.dispatch ? (options.args ?? []) : [])];

  const env = { ...buildChildEnv(profile, options), ...(builtEnv ?? {}) };
  const start = Date.now();

  // Cooperative cancel: refuse to spawn at all when the caller's signal is
  // already aborted (e.g. the run's budget was exhausted before this unit).
  if (options.signal?.aborted) {
    return {
      ok: false,
      exitCode: null,
      stdout: "",
      stderr: "",
      durationMs: 0,
      reason: "aborted",
      error: `agent CLI "${profile.name}" not started: caller signal already aborted`,
    };
  }

  // Spawn/timeout/abort/capture are owned by the managed-subprocess primitive
  // (src/core/subprocess.ts): process-GROUP spawn (detached in captured mode),
  // the SIGTERM→SIGKILL kill ladder on timeout/abort, bounded output capture,
  // and the optional stdin payload. runAgent keeps its agent-specific surface —
  // the onEvent observability seam, the failure taxonomy, and JSON parsing.
  //
  // `onSpawn` fires spawn_start once the child is live (never for a pre-spawn
  // abort or a synchronous spawn failure), and captures the proc so spawn_exit
  // can carry the same pid.
  let spawnedProc: SpawnedSubprocess | undefined;
  const result = await runManagedSubprocess(finalArgv, {
    capture: stdioMode === "captured",
    env,
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.stdin !== undefined ? { stdin: options.stdin } : {}),
    timeoutMs,
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.spawn ? { spawnFn: options.spawn } : {}),
    setTimeoutFn: setTimeoutImpl,
    clearTimeoutFn: clearTimeoutImpl,
    onSpawn: (proc) => {
      spawnedProc = proc;
      emitSpawnEvent("spawn_start", {
        profile: profile.name,
        ...(typeof proc.pid === "number" ? { pid: proc.pid } : {}),
      });
    },
  });

  const pidField = spawnedProc && typeof spawnedProc.pid === "number" ? { pid: spawnedProc.pid } : {};
  const durationMs = Date.now() - start;

  // Spawn/exit failure. A synchronous spawn throw never reached a live child
  // (no spawn_start fired, so no spawn_exit either); a rejected proc.exited did
  // (spawn_start already fired, so it emits a spawn_exit with status spawn_failed).
  if (result.spawnError) {
    if (spawnedProc) {
      emitSpawnEvent("spawn_exit", { profile: profile.name, ...pidField, exitCode: null, status: "spawn_failed" });
    }
    return {
      ok: false,
      exitCode: null,
      stdout: "",
      stderr: "",
      durationMs,
      reason: "spawn_failed",
      error: result.spawnError.message,
    };
  }

  const { exitCode, timedOut, aborted, stdout, stderr } = result;
  emitSpawnEvent("spawn_exit", {
    profile: profile.name,
    ...pidField,
    exitCode,
    status: aborted ? "aborted" : timedOut ? "timeout" : exitCode !== 0 ? "non_zero_exit" : "ok",
  });

  if (aborted) {
    return {
      ok: false,
      exitCode,
      stdout,
      stderr,
      durationMs,
      reason: "aborted",
      error: `agent CLI "${profile.name}" aborted by caller signal`,
    };
  }

  if (timedOut) {
    return {
      ok: false,
      exitCode,
      stdout,
      stderr,
      durationMs,
      reason: "timeout",
      error: `agent CLI "${profile.name}" timed out after ${timeoutMs ?? 0}ms`,
    };
  }

  const captureFailure = streamFailureMessage(profile.name, result.stdoutRead, result.stderrRead);
  if (captureFailure) {
    return {
      ok: false,
      exitCode,
      stdout,
      stderr,
      durationMs,
      reason: "spawn_failed",
      error: captureFailure,
    };
  }

  if (exitCode !== 0) {
    return {
      ok: false,
      exitCode,
      stdout,
      stderr,
      durationMs,
      reason: "non_zero_exit",
      error: `agent CLI "${profile.name}" exited with code ${exitCode}`,
    };
  }

  if (parseOutput === "json" && stdioMode === "captured") {
    // Strip <think> blocks and code fences, then parse with embedded-JSON
    // fallback for local LLMs that emit prose around the payload. Handles
    // both top-level `{…}` and `[…]` structures.
    const parsed = parseEmbeddedJsonResponse(stdout);
    if (parsed === undefined) {
      return {
        ok: false,
        exitCode,
        stdout,
        stderr,
        durationMs,
        reason: "parse_error",
        error: "no JSON structure found in agent output",
      };
    }
    return { ok: true, exitCode, stdout, stderr, durationMs, parsed };
  }

  return { ok: true, exitCode, stdout, stderr, durationMs };
}
