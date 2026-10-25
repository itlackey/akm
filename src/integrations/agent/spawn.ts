// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Agent CLI spawn wrapper.
 *
 * Single helper that owns:
 *   • Process spawn (Bun's subprocess API).
 *   • Captured vs interactive stdio.
 *   • Hard timeout (per-call override or profile default).
 *   • Structured failure reasons — `timeout`, `aborted`, `spawn_failed`,
 *     `non_zero_exit`.
 *
 * The command comes from the harness (`harness.build`); this module never
 * touches a model. Agents are reachable only via shell-out.
 */
import { ConfigError } from "../../core/errors";
import { akmLocations } from "../../core/paths";
import { collectAllowlistedEnv } from "../../core/spawn-env";
import { runManagedSubprocess, type StreamReadResult, streamCaptureFailure } from "../../core/subprocess";
import { getHarness } from "../harnesses";
import type { AgentDispatchRequest } from "../harnesses/harness";
import { DEFAULT_AGENT_TIMEOUT_MS } from "./config";
import type { AgentProfile, AgentStdioMode } from "./profiles";

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
 * action bucket like `unsupported_type`.
 *
 * Note on `quality_rejected`: the LLM-as-judge quality gate rejected an
 * otherwise well-formed, well-parsed proposal. Previously emitted as
 * `parse_error`, which was false (the output parsed fine) and caused the
 * judge's rejection text to be injected into later reflect prompts as
 * learned "Avoid These Patterns" content, poisoning subsequent candidates. */
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
  | "quality_rejected"
  // Cooperative cancellation via RunAgentOptions.signal (P0.5 seam for the
  // workflow scheduler's budget preemption). Distinct from "timeout" so
  // callers can tell a budget/user abort from a wall-clock expiry.
  | "aborted";

/**
 * Per-call options for {@link runAgent}. All fields are optional: a call with no
 * `dispatch` has nothing to run, and is the program started for a person to use.
 */
export interface RunAgentOptions {
  /** Override `profile.stdio`. Captured = pipe stdout/stderr; interactive = inherit. */
  stdio?: AgentStdioMode;
  /** Override the profile/global timeout (ms). null = no timeout (runs until the process exits). */
  timeoutMs?: number | null;
  /** Extra env vars for the child, over what the profile passes through. */
  env?: Record<string, string>;
  /** Working directory for the child. */
  cwd?: string;
  /**
   * Cooperative cancellation. When the signal aborts, the child process
   * group gets SIGTERM (then SIGKILL after 5 s) and the run resolves with
   * `reason: "aborted"`. Lets a scheduler preempt a running agent at a
   * budget ceiling instead of waiting out the timeout.
   */
  signal?: AbortSignal;
  /** The request the harness builds its command from, prompt included. */
  dispatch?: AgentDispatchRequest;
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
  reason?: AgentFailureReason;
  /** Safe typed discriminator for a caught direct-LLM transport error; absent for agent/SDK and generic failures. */
  llmErrorCode?: Exclude<import("../../llm/usage-telemetry").LlmUsageErrorCode, "unknown_error">;
  /** Human-readable error message paired with `reason`. */
  error?: string;
  /** Token accounting, when the harness reported it (SDK path today). */
  usage?: AgentTokenUsage;
  /** The harness's own session id, when it exposes one (SDK path today). */
  sessionId?: string;
}

/**
 * The child's env, lowest precedence first: the directories this akm resolved, so
 * a child that runs `akm` uses the same installation; what the profile passes
 * through from this process (the allowlist also supplements PATH for scheduler
 * contexts where the inherited PATH is stripped); then the call's `env`.
 */
function buildChildEnv(profile: AgentProfile, options: RunAgentOptions): Record<string, string> {
  return { ...akmLocations(), ...collectAllowlistedEnv(profile.envPassthrough), ...options.env };
}

/**
 * This path's phrasing of the SHARED incomplete-capture verdict
 * ({@link streamCaptureFailure} in `core/subprocess.ts`). The classification
 * lives in the primitive so the agent path and the workflow `exec` path cannot
 * drift apart on what "the capture did not complete" means; only the sentence
 * naming the profile is local.
 */
function streamFailureMessage(
  profileName: string,
  stdout: StreamReadResult,
  stderr: StreamReadResult,
): string | undefined {
  const failures = streamCaptureFailure(stdout, stderr);
  return failures === undefined ? undefined : `agent CLI "${profileName}" output capture failed: ${failures}`;
}

function failed(reason: AgentFailureReason, error: string, rest: Partial<AgentRunResult> = {}): AgentRunResult {
  return { ok: false, exitCode: null, stdout: "", stderr: "", durationMs: 0, reason, error, ...rest };
}

/**
 * Spawn the agent CLI `profile` names, with the command its harness builds from
 * `options.dispatch`, and return a structured result.
 *
 * Failure modes (see {@link AgentFailureReason}):
 *
 *   • `spawn_failed`  — the spawn call threw, or its output could not be captured.
 *   • `timeout`       — exceeded the resolved timeout.
 *   • `aborted`       — the caller's signal fired.
 *   • `non_zero_exit` — child exited with a non-zero code.
 *
 * `ok === true` requires exit code 0.
 */
export async function runAgent(profile: AgentProfile, options: RunAgentOptions = {}): Promise<AgentRunResult> {
  const stdioMode = options.stdio ?? profile.stdio;
  // null = explicitly disabled (no kill timer). undefined = runtime default.
  const timeoutMs: number | null = options.timeoutMs !== undefined ? options.timeoutMs : DEFAULT_AGENT_TIMEOUT_MS;

  const platform = profile.platform ?? profile.name;
  const harness = getHarness(platform);
  if (!harness) {
    throw new ConfigError(
      `Agent platform "${platform}" has no registered command builder.`,
      "INVALID_CONFIG_FILE",
      "Select a canonical agent platform in harnesses.<name>.platform.",
    );
  }
  const built = harness.build(profile, options.dispatch ?? {});

  // Cooperative cancel: refuse to spawn at all when the caller's signal is
  // already aborted (e.g. the run's budget was exhausted before this unit).
  if (options.signal?.aborted) {
    return failed("aborted", `agent CLI "${profile.name}" not started: caller signal already aborted`);
  }

  // Spawn/timeout/abort/capture are owned by the managed-subprocess primitive
  // (src/core/subprocess.ts): process-GROUP spawn (detached in captured mode),
  // the SIGTERM→SIGKILL kill ladder on timeout/abort, bounded output capture,
  // and the optional stdin payload. runAgent keeps its agent-specific surface:
  // the failure taxonomy.
  const start = Date.now();
  const result = await runManagedSubprocess([...built.argv], {
    capture: stdioMode === "captured",
    env: { ...buildChildEnv(profile, options), ...built.env },
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(built.stdin !== undefined ? { stdin: built.stdin } : {}),
    timeoutMs,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const durationMs = Date.now() - start;

  if (result.spawnError) return failed("spawn_failed", result.spawnError.message, { durationMs });

  const { exitCode, stdout, stderr } = result;
  const output = { exitCode, stdout, stderr, durationMs };
  if (result.aborted) {
    return failed("aborted", `agent CLI "${profile.name}" aborted by caller signal`, output);
  }
  if (result.timedOut) {
    return failed("timeout", `agent CLI "${profile.name}" timed out after ${timeoutMs ?? 0}ms`, output);
  }
  const captureFailure = streamFailureMessage(profile.name, result.stdoutRead, result.stderrRead);
  if (captureFailure) return failed("spawn_failed", captureFailure, output);
  if (exitCode !== 0) {
    return failed("non_zero_exit", `agent CLI "${profile.name}" exited with code ${exitCode}`, output);
  }
  return { ok: true, ...output };
}
