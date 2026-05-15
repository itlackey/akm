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
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getCommandBuilder } from "./builders";
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
  /** PID of the spawned process. Present on real Bun subprocesses; may be absent on test fakes. */
  pid?: number;
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
    detached?: boolean;
  },
) => SpawnedSubprocess;

/**
 * Kill the process group of `proc` with `signal`, falling back to
 * `proc.kill(signal)` when `proc.pid` is unavailable (e.g. test fakes).
 *
 * Passing a negative PID to `process.kill` targets the entire process
 * group, so opencode's child processes (the .opencode binary, etc.) are
 * reaped alongside the node wrapper. The fallback keeps test fakes working
 * without modification.
 */
export function killGroup(proc: SpawnedSubprocess, signal: "SIGTERM" | "SIGKILL"): void {
  if (typeof proc.pid === "number") {
    try {
      process.kill(-proc.pid, signal);
      return;
    } catch {
      // Process may have already exited; fall through to direct kill.
    }
  }
  try {
    proc.kill(signal);
  } catch {
    /* ignore */
  }
}

/**
 * Per-call options for {@link runAgent}. All fields are optional. Caller
 * may override the profile's `stdio`, `timeoutMs`, and `parseOutput`.
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
  /**
   * Abstract dispatch parameters. When present, the platform-specific
   * AgentCommandBuilder constructs the argv from these fields (system prompt,
   * model alias, tool policy). When absent, falls back to the legacy
   * positional-prompt behaviour for backwards compatibility.
   */
  dispatch?: import("./builders").AgentDispatchRequest;
  /**
   * Builder registry override — used by tests to inject fake builders without
   * touching the global BUILTIN_BUILDERS map.
   */
  builderRegistry?: Record<string, import("./builders").AgentCommandBuilder>;
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

/**
 * Supplement `existingPath` with well-known user binary directories when
 * running in a scheduler context (cron/launchd) where PATH is stripped.
 *
 * Detection heuristic: if the current PATH does not contain the user's home
 * directory, we are likely in a stripped scheduler env. In an interactive
 * shell the user's home almost always appears (e.g. ~/.bun/bin, ~/.cargo/bin).
 *
 * Only directories that actually exist on disk are prepended, and only if
 * they are not already present, so interactive-shell PATH ordering is never
 * disturbed.
 */
export function supplementPathForSchedulerContext(existingPath: string): string {
  const home = os.homedir();
  // If PATH already contains the home directory, we are in an interactive
  // shell — skip supplementation entirely.
  if (existingPath.split(path.delimiter).some((d) => d.startsWith(home))) {
    return existingPath;
  }
  const candidates = [
    path.join(home, ".bun", "bin"),
    path.join(home, ".cargo", "bin"),
    path.join(home, ".local", "bin"),
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
  ];
  const existing = new Set(existingPath.split(path.delimiter).filter(Boolean));
  const toAdd = candidates.filter((d) => !existing.has(d) && fs.existsSync(d));
  if (toAdd.length === 0) return existingPath;
  return [...toAdd, existingPath].filter(Boolean).join(path.delimiter);
}

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
 *
 * PATH is supplemented with well-known user binary directories when running
 * in a scheduler context (cron/launchd) where the inherited PATH is stripped.
 * See {@link supplementPathForSchedulerContext}.
 */
function buildChildEnv(profile: AgentProfile, options: RunAgentOptions): Record<string, string> {
  const source = options.envSource ?? process.env;
  const env: Record<string, string> = {};
  for (const name of profile.envPassthrough) {
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  // Supplement PATH after passthrough so the scheduler-context fix applies to
  // the value actually coming from the environment source.
  if (env.PATH !== undefined) {
    env.PATH = supplementPathForSchedulerContext(env.PATH);
  }
  if (profile.env) {
    for (const [k, v] of Object.entries(profile.env)) env[k] = v;
  }
  if (options.env) {
    for (const [k, v] of Object.entries(options.env)) env[k] = v;
  }
  return env;
}

async function readStream(
  stream: ReadableStream<Uint8Array> | null | undefined,
  opts?: { timeoutMs?: number },
): Promise<string> {
  if (!stream) return "";
  const readPromise = new Response(stream).text().catch(() => "");
  if (!opts?.timeoutMs) return readPromise;
  // Race the stream read against a timeout so a process that is killed via
  // SIGTERM/SIGKILL but whose pipe endpoints stay open (e.g. background
  // threads still holding the fd) cannot block the caller indefinitely.
  // On timeout we return whatever we received so far (empty string here since
  // `readPromise` is all-or-nothing with `Response.text()`).
  const timeoutPromise = new Promise<string>((resolve) => {
    setTimeout(() => resolve(""), opts.timeoutMs);
  });
  return Promise.race([readPromise, timeoutPromise]);
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
  // null = explicitly disabled (no kill timer). undefined = inherit from profile/default.
  const timeoutMs: number | null =
    options.timeoutMs !== undefined ? options.timeoutMs : (profile.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const parseOutput = options.parseOutput ?? profile.parseOutput;
  const setTimeoutImpl = options.setTimeoutFn ?? setTimeout;
  const clearTimeoutImpl = options.clearTimeoutFn ?? clearTimeout;

  // Build argv via the platform-specific builder when dispatch params are
  // provided; fall back to the legacy positional-prompt form otherwise.
  let builtArgv: readonly string[];
  let builtEnv: Record<string, string> | undefined;
  if (options.dispatch !== undefined) {
    const builder = getCommandBuilder(profile.commandBuilder ?? profile.name, options.builderRegistry);
    const built = builder.build(profile, options.dispatch);
    builtArgv = built.argv;
    builtEnv = built.env;
  } else {
    const legacyArgs: string[] = [...profile.args, ...(options.args ?? [])];
    if (prompt !== undefined) legacyArgs.push(prompt);
    builtArgv = [profile.bin, ...legacyArgs];
  }
  // Extra args (e.g. forwarded CLI positionals) are appended after the builder output.
  const finalArgv: string[] = [...builtArgv, ...(options.dispatch ? (options.args ?? []) : [])];

  const env = { ...buildChildEnv(profile, options), ...(builtEnv ?? {}) };
  const start = Date.now();

  let proc: SpawnedSubprocess;
  try {
    const spawnFn = resolveSpawnFn(options);
    proc = spawnFn(finalArgv, {
      stdin: stdioMode === "captured" ? (options.stdin !== undefined ? "pipe" : "ignore") : "inherit",
      stdout: stdioMode === "captured" ? "pipe" : "inherit",
      stderr: stdioMode === "captured" ? "pipe" : "inherit",
      env,
      ...(options.cwd ? { cwd: options.cwd } : {}),
      // Spawn in its own process group so killGroup(-pid, signal) reaches all
      // descendants (e.g. the .opencode binary that opencode's node wrapper forks).
      // Only applied in captured mode — interactive mode inherits the parent
      // terminal's process group intentionally.
      ...(stdioMode === "captured" ? { detached: true } : {}),
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
  //
  // When timeoutMs is null the kill timer is skipped entirely — the task runs
  // until the process exits naturally. Intended for long-running local-model
  // tasks where wall-clock time is unpredictable.
  let timedOut = false;
  let timer: ReturnType<typeof setTimeoutImpl> | undefined;
  if (timeoutMs !== null) {
    timer = setTimeoutImpl(() => {
      if (proc.exitCode !== null) return;
      timedOut = true;
      killGroup(proc, "SIGTERM");
      // Follow up with SIGKILL after 5 s in case the process ignores SIGTERM.
      setTimeoutImpl(() => {
        if (proc.exitCode !== null) return;
        killGroup(proc, "SIGKILL");
      }, 5000);
    }, timeoutMs);
  }

  // Stream-drain timeout: the overall wall-clock budget plus a 2 s grace
  // period. When a process is killed via SIGTERM/SIGKILL (from our timeout
  // handler or from outside) some runtimes keep the pipe write-end open in
  // background threads, which would cause `Response.text()` to block forever.
  // Capping stream draining ensures the caller never hangs past the wall
  // budget regardless of subprocess pipe behaviour.
  // When there is no kill timer, allow up to 30 s for streams to drain.
  const streamDrainTimeoutMs = timeoutMs !== null ? timeoutMs + 2_000 : 30_000;
  const stdoutPromise =
    stdioMode === "captured"
      ? readStream(proc.stdout ?? null, { timeoutMs: streamDrainTimeoutMs })
      : Promise.resolve("");
  const stderrPromise =
    stdioMode === "captured"
      ? readStream(proc.stderr ?? null, { timeoutMs: streamDrainTimeoutMs })
      : Promise.resolve("");

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
    if (timer !== undefined) clearTimeoutImpl(timer);
    // BUG-H2: drain stream readers before the early return so they don't
    // surface as unhandled rejections after the function resolves.
    // The streams already carry a built-in drain timeout so this allSettled
    // will not block indefinitely.
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
      error: `agent CLI "${profile.name}" timed out after ${timeoutMs ?? 0}ms`,
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
    // Strip <think> blocks and code fences, then try direct parse with
    // embedded-JSON fallback for local LLMs that emit prose around the payload.
    const cleaned = stdout
      .trim()
      .replace(/<think>[\s\S]*?<\/think>/gi, "")
      .trim()
      .replace(/^```(?:json)?\s*\n?/, "")
      .replace(/\n?```\s*$/, "")
      .trim();
    let parsed: unknown;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      // Fallback: extract the first balanced {…} from prose output.
      let found: unknown;
      for (let s = 0; s < cleaned.length; s++) {
        if (cleaned[s] !== "{") continue;
        let depth = 0,
          inStr = false,
          esc = false;
        for (let i = s; i < cleaned.length; i++) {
          const c = cleaned[i];
          if (inStr) {
            if (esc) {
              esc = false;
            } else if (c === "\\") {
              esc = true;
            } else if (c === '"') {
              inStr = false;
            }
            continue;
          }
          if (c === '"') {
            inStr = true;
            continue;
          }
          if (c === "{") depth++;
          if (c === "}") {
            depth--;
            if (depth === 0) {
              try {
                found = JSON.parse(cleaned.slice(s, i + 1));
              } catch {}
              break;
            }
          }
        }
        if (found !== undefined) break;
      }
      if (found === undefined) {
        return {
          ok: false,
          exitCode,
          stdout,
          stderr,
          durationMs,
          reason: "parse_error",
          error: "no JSON object found in agent output",
        };
      }
      parsed = found;
    }
    return { ok: true, exitCode, stdout, stderr, durationMs, parsed };
  }

  return { ok: true, exitCode, stdout, stderr, durationMs };
}
