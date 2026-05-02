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
import { DEFAULT_AGENT_TIMEOUT_MS } from "./config";
import type { AgentParseMode, AgentProfile, AgentStdioMode } from "./profiles";

/** Stable failure-reason vocabulary. Wider strings are not allowed. */
export type AgentFailureReason = "timeout" | "spawn_failed" | "non_zero_exit" | "parse_error";

/** Minimum subprocess surface we need. Bun.spawn returns this shape. */
export interface SpawnedSubprocess {
  exitCode: number | null;
  exited: Promise<number>;
  stdout?: ReadableStream<Uint8Array> | null;
  stderr?: ReadableStream<Uint8Array> | null;
  stdin?: WritableStream<Uint8Array> | null;
  kill(signal?: number | string): void;
}

/**
 * Function signature compatible with `Bun.spawn`. Tests inject a fake
 * implementation so the spawn wrapper can be exercised deterministically
 * without poking at real binaries.
 */
export type SpawnFn = (
  cmd: string[],
  options: {
    stdin?: "inherit" | "pipe" | "ignore";
    stdout?: "inherit" | "pipe" | "ignore";
    stderr?: "inherit" | "pipe" | "ignore";
    env?: Record<string, string>;
    cwd?: string;
  },
) => SpawnedSubprocess;

/**
 * Per-call options for {@link runAgent}. All fields are optional. Caller
 * may override the profile's `stdio`, `timeoutMs`, and `parseOutput`.
 */
export interface RunAgentOptions {
  /** Override `profile.stdio`. Captured = pipe stdout/stderr; interactive = inherit. */
  stdio?: AgentStdioMode;
  /** Override the profile/global timeout (ms). */
  timeoutMs?: number;
  /** Override `profile.parseOutput`. */
  parseOutput?: AgentParseMode;
  /** Extra env vars merged on top of the profile-derived env. */
  env?: Record<string, string>;
  /** Working directory for the child. */
  cwd?: string;
  /** Extra args appended after `profile.args`. */
  args?: readonly string[];
  /** Optional stdin payload (only honoured in `captured` mode). */
  stdin?: string;
  /** Process env source. Defaults to `process.env`. Tests inject a fake. */
  envSource?: NodeJS.ProcessEnv;
  /** Spawn function. Defaults to `Bun.spawn`. Tests inject a fake. */
  spawn?: SpawnFn;
  /**
   * `setTimeout` shim. Defaults to the global. Tests pass a synchronous
   * timer driver so timeout assertions are deterministic.
   */
  setTimeoutFn?: typeof setTimeout;
  /** `clearTimeout` shim. Defaults to the global. */
  clearTimeoutFn?: typeof clearTimeout;
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
}

const DEFAULT_TIMEOUT_MS = DEFAULT_AGENT_TIMEOUT_MS;

function resolveSpawnFn(options: RunAgentOptions): SpawnFn {
  if (options.spawn) return options.spawn;
  // Pull from globalThis so tests that swap it out at module level are honoured.
  const bun = (globalThis as { Bun?: { spawn: SpawnFn } }).Bun;
  if (!bun?.spawn) {
    throw new Error("Bun.spawn is unavailable; pass options.spawn for non-Bun environments.");
  }
  return bun.spawn.bind(bun);
}

/**
 * Build the child env. Starts empty and copies through:
 *   • Every name in `profile.envPassthrough`.
 *   • Every entry in `profile.env`.
 *   • Every entry in `options.env` (highest precedence).
 */
function buildChildEnv(profile: AgentProfile, options: RunAgentOptions): Record<string, string> {
  const source = options.envSource ?? process.env;
  const env: Record<string, string> = {};
  for (const name of profile.envPassthrough) {
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  if (profile.env) {
    for (const [k, v] of Object.entries(profile.env)) env[k] = v;
  }
  if (options.env) {
    for (const [k, v] of Object.entries(options.env)) env[k] = v;
  }
  return env;
}

async function readStream(stream: ReadableStream<Uint8Array> | null | undefined): Promise<string> {
  if (!stream) return "";
  try {
    return await new Response(stream).text();
  } catch {
    return "";
  }
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
 *   • `spawn_failed`  — `Bun.spawn` threw synchronously.
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
  const timeoutMs = options.timeoutMs ?? profile.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const parseOutput = options.parseOutput ?? profile.parseOutput;
  const setTimeoutImpl = options.setTimeoutFn ?? setTimeout;
  const clearTimeoutImpl = options.clearTimeoutFn ?? clearTimeout;

  const args: string[] = [...profile.args, ...(options.args ?? [])];
  if (prompt !== undefined) args.push(prompt);

  const env = buildChildEnv(profile, options);
  const start = Date.now();

  let proc: SpawnedSubprocess;
  try {
    const spawnFn = resolveSpawnFn(options);
    proc = spawnFn([profile.bin, ...args], {
      stdin: stdioMode === "captured" ? "pipe" : "inherit",
      stdout: stdioMode === "captured" ? "pipe" : "inherit",
      stderr: stdioMode === "captured" ? "pipe" : "inherit",
      env,
      ...(options.cwd ? { cwd: options.cwd } : {}),
    });
  } catch (err) {
    const durationMs = Date.now() - start;
    return {
      ok: false,
      exitCode: null,
      stdout: "",
      stderr: "",
      durationMs,
      reason: "spawn_failed",
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // Hard timeout. We prefer SIGTERM, then SIGKILL if SIGTERM is ignored,
  // but Bun.spawn only exposes a single .kill() — one signal is enough
  // for the structured-failure contract.
  //
  // BUG-M3: only flag `timedOut` when the child has not already exited. A
  // timer firing in the same microtask as `proc.exited` resolving could
  // otherwise label a clean exit as a timeout.
  let timedOut = false;
  const timer = setTimeoutImpl(() => {
    if (proc.exitCode !== null) return;
    timedOut = true;
    try {
      proc.kill("SIGTERM");
    } catch {
      /* ignore */
    }
    // Follow up with SIGKILL after 5 s in case the process ignores SIGTERM.
    setTimeoutImpl(() => {
      if (proc.exitCode !== null) return;
      try {
        proc.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }, 5000);
  }, timeoutMs);

  const stdoutPromise = stdioMode === "captured" ? readStream(proc.stdout ?? null) : Promise.resolve("");
  const stderrPromise = stdioMode === "captured" ? readStream(proc.stderr ?? null) : Promise.resolve("");

  // Optional stdin payload (captured mode only).
  //
  // BUG-H1: race the stdin write/close against `proc.exited` and the
  // timeout timer. If the child never drains stdin, an unraced
  // `await writer.write()` would block forever and prevent `runAgent`
  // from ever returning.
  if (options.stdin !== undefined && stdioMode === "captured" && proc.stdin) {
    const stdinPayload = options.stdin;
    const stdinStream = proc.stdin;
    const stdinDone = (async () => {
      try {
        const writer = stdinStream.getWriter();
        const bytes = new TextEncoder().encode(stdinPayload);
        await writer.write(bytes);
        await writer.close();
      } catch {
        // Best-effort: ignore stdin write failures, the child will get EOF.
      }
    })();
    // Resolve as soon as either the write completes or the child exits.
    // We don't await the result — only that one of the two has settled —
    // so a stuck writer cannot keep us pinned past the timeout.
    await Promise.race([stdinDone, proc.exited.catch(() => undefined)]);
  }

  let exitCode: number | null = null;
  try {
    exitCode = await proc.exited;
  } catch (err) {
    clearTimeoutImpl(timer);
    // BUG-H2: drain stream readers before the early return so they don't
    // surface as unhandled rejections after the function resolves.
    await Promise.allSettled([stdoutPromise, stderrPromise]);
    const durationMs = Date.now() - start;
    return {
      ok: false,
      exitCode: null,
      stdout: "",
      stderr: "",
      durationMs,
      reason: "spawn_failed",
      error: err instanceof Error ? err.message : String(err),
    };
  }
  clearTimeoutImpl(timer);

  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
  const durationMs = Date.now() - start;

  if (timedOut) {
    return {
      ok: false,
      exitCode,
      stdout,
      stderr,
      durationMs,
      reason: "timeout",
      error: `agent CLI "${profile.name}" timed out after ${timeoutMs}ms`,
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
    try {
      const parsed = JSON.parse(stdout);
      return { ok: true, exitCode, stdout, stderr, durationMs, parsed };
    } catch (err) {
      return {
        ok: false,
        exitCode,
        stdout,
        stderr,
        durationMs,
        reason: "parse_error",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  return { ok: true, exitCode, stdout, stderr, durationMs };
}
