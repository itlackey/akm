// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * In-process CLI test harness.
 *
 * Replaces per-test `spawnSync("bun", ["src/cli.ts", ...])` subprocess spawning
 * with a direct, in-process invocation of the `akm` citty command. Spawning a
 * fresh Bun process per assertion is the single biggest source of slowness in
 * the integration suite (each spawn pays full module-graph load + runtime
 * startup ~150-180ms); driving the command in-process removes that cost.
 *
 * How it works:
 *  - `src/cli.ts` exports its top-level citty command as `main` and only runs
 *    its startup side effects (argv mutation, output-mode init, index cleanup,
 *    banner, `runMain`) when it is the direct entry point (`import.meta.main`).
 *    Importing it here therefore has no side effects.
 *  - `runCliCapture` replicates the small startup contract the command relies
 *    on — argv normalization (`normalizeShowArgv`) and output-mode init
 *    (`initOutputMode`) — then drives the command via citty's `runCommand`,
 *    mirroring `runMain`'s builtin `--help` / `--version` handling (which
 *    `runCommand` alone does not provide). For `--help` / `--version` the
 *    resolved string is appended directly to the capture buffer rather than
 *    routed through `console.log`, because that branch does an `await` (on the
 *    command meta / usage render) and, under `bun test`, a `console.log`
 *    issued right after that await is not reliably intercepted by a reassigned
 *    `console.log`. Appending to the buffer sidesteps the interception
 *    entirely and is exactly the text the real CLI would print.
 *  - Output capture: the CLI emits ALL command output through `console.log` /
 *    `console.error` (src/cli/shared.ts `output()` / `emitJsonError()`,
 *    src/output/text.ts, src/core/warn.ts) and a few direct
 *    `process.stdout.write` / `process.stderr.write` calls (e.g. `config path`,
 *    `hints`). There is no `Bun.write(Bun.stdout)` on any user-facing output
 *    path. We capture by replacing BOTH the stream `.write` methods AND the
 *    `console.*` methods with INLINE arrow closures that append to local
 *    buffers. The closures must be inline — empirically, under `bun test`, a
 *    write function produced by a shared factory (an outer arrow returning an
 *    inner arrow) is NOT honored by Bun's stdout fast path, so the CLI's
 *    `process.stdout.write` calls escape to the real terminal and the buffer
 *    stays empty. Direct inline closures are honored. All patched globals are
 *    restored in `finally`, even on throw.
 *  - `process.exit` is intercepted and converted into the returned exit `code`.
 *    The CLI's `emitJsonError` (src/cli/shared.ts) calls `console.error(...)`
 *    then `process.exit(code)`; the exit shim throws a sentinel that citty's
 *    `runCommand` may swallow in its own try/catch — that's fine, because the
 *    code is read from a closure variable set by the shim, not from the throw
 *    propagating. A real error that escapes without going through
 *    `emitJsonError` is mapped to an exit code the same way `emitJsonError`
 *    would (UsageError → 2, ConfigError → 78, others → 1).
 *
 * State note: back-to-back in-process runs in a SINGLE test would otherwise
 * share `cachedConfig` (a module-level singleton in `src/core/config/config.ts`) and
 * the output-mode singleton. `runCliCapture` calls `resetConfigCache()` and
 * `resetOutputMode()` before each run so every invocation re-reads config from
 * the (sandboxed) environment, exactly as a fresh subprocess would. The
 * per-test preload (`tests/_preload.ts`) handles cross-test isolation; this
 * handles within-test back-to-back isolation.
 */

import { renderUsage, runCommand } from "citty";
import { main } from "../../src/cli";
import { emitJsonError } from "../../src/cli/shared";
import { normalizeShowArgv } from "../../src/commands/read/show";
import { loadConfig, resetConfigCache } from "../../src/core/config/config";
import { AkmError } from "../../src/core/errors";
import { clearLogFile, resetQuiet, resetVerbose } from "../../src/core/warn";
import { resetGraphBoostCache } from "../../src/indexer/graph/graph-boost";
import { resetLocalEmbedder } from "../../src/llm/embedder";
import { clearEmbeddingCache } from "../../src/llm/embedders/cache";
import { initOutputMode, resetOutputMode } from "../../src/output/context";

/**
 * Reset every module-level process singleton the CLI caches, so an in-process
 * run re-reads its state from the (sandboxed) environment — matching
 * fresh-subprocess semantics. This is a SUPERSET of the historical
 * config+output-mode reset: it additionally clears the graph-boost cache, the
 * local embedder, the embedding cache, and the warn-module quiet/verbose/log-file
 * state. Every call is to a verified-exported, no-argument, idempotent reset, so
 * invoking them here (and possibly again in `tests/_preload.ts`) is safe and makes
 * isolation order-independent.
 */
export function resetAllProcessState(): void {
  resetConfigCache();
  resetOutputMode();
  resetGraphBoostCache();
  resetLocalEmbedder();
  clearEmbeddingCache();
  resetQuiet();
  resetVerbose();
  clearLogFile();
}

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

const EXIT_GENERAL = 1;
const EXIT_USAGE = 2;
const EXIT_INTERNAL = 70;
const EXIT_CONFIG = 78;

/** Mirror of `classifyExitCode` in src/cli/shared.ts for errors that escape. */
function classifyExitCode(error: unknown): number {
  if (!(error instanceof AkmError)) return EXIT_INTERNAL;
  switch (error.kind) {
    case "usage":
      return EXIT_USAGE;
    case "config":
      return EXIT_CONFIG;
    case "not-found":
      return EXIT_GENERAL;
  }
}

/** Sentinel thrown by the temporary `process.exit` shim to unwind the stack. */
class ExitSignal extends Error {
  constructor(public readonly exitCode: number) {
    super(`__akm_test_exit__:${exitCode}`);
  }
}

const toText = (chunk: unknown): string => (typeof chunk === "string" ? chunk : String(chunk));
const joinParts = (parts: unknown[]): string => parts.map((p) => (typeof p === "string" ? p : String(p))).join(" ");

/**
 * Run the `akm` CLI in-process and capture its stdout, stderr, and exit code.
 *
 * @param args CLI argument vector WITHOUT the leading `["bun", "cli.ts"]`
 *   (e.g. `["search", "test", "--source", "invalid"]`).
 */
export async function runCliCapture(args: string[]): Promise<CliResult> {
  // Reset module-level singletons so this run re-reads the (sandboxed) env,
  // matching fresh-subprocess semantics even for back-to-back calls in one test.
  resetAllProcessState();

  // Resolve everything that requires an `await` BEFORE patching the output
  // sinks, so the patched console.log isn't relied on across an await boundary
  // (see module docstring). For the normal command path nothing is awaited
  // before runCommand, so this only matters for --help / --version.
  const argv = normalizeShowArgv(["bun", "cli.ts", ...args]);
  const rawArgs = argv.slice(2);
  const cmd = main as Parameters<typeof runCommand>[0];

  const isHelp = rawArgs.includes("--help") || rawArgs.includes("-h");
  const isVersion = rawArgs.length === 1 && (rawArgs[0] === "--version" || rawArgs[0] === "-v");

  let preRendered: string | undefined;
  if (isHelp) {
    preRendered = `${await renderUsage(cmd, cmd)}\n`;
  } else if (isVersion) {
    const meta = typeof cmd.meta === "function" ? await cmd.meta() : await cmd.meta;
    preRendered = `${meta?.version ?? ""}\n`;
  }

  let stdout = "";
  let stderr = "";

  const realStdoutWrite = process.stdout.write.bind(process.stdout);
  const realStderrWrite = process.stderr.write.bind(process.stderr);
  const realLog = console.log;
  const realError = console.error;
  const realWarn = console.warn;
  const realInfo = console.info;
  const realDebug = console.debug;
  const realExit = process.exit;
  const realArgv = process.argv;
  const realExitCode = process.exitCode;

  // Several commands (and helpers like `parseAllFlagValues` in
  // src/cli/shared.ts) read `process.argv` DIRECTLY rather than the citty-parsed
  // args — e.g. `akm health` reads `--windows` / `--detail` / `--window-compare`
  // straight from argv. The real entry point sets
  // `process.argv = normalizeShowArgv(process.argv)` before running, so mirror
  // that here: point argv at the synthetic invocation for the duration of the
  // run. Restored in `finally`.
  process.argv = argv;

  // Inline arrow closures (NOT a shared factory) — see the module docstring:
  // under bun test, factory-produced sinks do not reliably intercept the CLI's
  // writes, whereas these inline closures do.
  process.stdout.write = ((chunk: unknown, ...rest: unknown[]): boolean => {
    stdout += toText(chunk);
    const cb = rest.find((r) => typeof r === "function") as (() => void) | undefined;
    if (cb) cb();
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown, ...rest: unknown[]): boolean => {
    stderr += toText(chunk);
    const cb = rest.find((r) => typeof r === "function") as (() => void) | undefined;
    if (cb) cb();
    return true;
  }) as typeof process.stderr.write;
  console.log = ((...parts: unknown[]): void => {
    stdout += `${joinParts(parts)}\n`;
  }) as typeof console.log;
  console.info = ((...parts: unknown[]): void => {
    stdout += `${joinParts(parts)}\n`;
  }) as typeof console.info;
  console.debug = ((...parts: unknown[]): void => {
    stdout += `${joinParts(parts)}\n`;
  }) as typeof console.debug;
  console.error = ((...parts: unknown[]): void => {
    stderr += `${joinParts(parts)}\n`;
  }) as typeof console.error;
  console.warn = ((...parts: unknown[]): void => {
    stderr += `${joinParts(parts)}\n`;
  }) as typeof console.warn;

  let code = 0;
  (process as unknown as { exit: (c?: number) => never }).exit = ((c?: number) => {
    code = c ?? 0;
    throw new ExitSignal(code);
  }) as never;

  try {
    if (preRendered !== undefined) {
      // Builtin --help / --version: emit the pre-rendered text directly.
      stdout += preRendered;
    } else {
      // Replicate the startup contract from src/cli.ts (the guarded entry
      // block): citty + our command handlers read process.argv directly, and
      // `output()` requires `initOutputMode()` to have run first.
      //
      // In the real entry point `initOutputMode` runs in its OWN top-level
      // try/catch that routes failures through `emitJsonError` (JSON envelope +
      // process.exit), separate from the command's runWithJsonErrors. So a bad
      // `--format` / `--detail` yields the JSON envelope and the mapped exit
      // code — NOT citty's plain-text error. Mirror that split here so e.g.
      // `health --detail verbose` produces the same JSON the spawn version
      // asserted on, rather than the bare exception message.
      try {
        initOutputMode(argv, loadConfig().output ?? {});
      } catch (initError) {
        emitJsonError(initError); // JSON envelope to stderr, then process.exit → ExitSignal
      }
      await runCommand(cmd, { rawArgs });
    }
  } catch (error) {
    if (error instanceof ExitSignal) {
      code = error.exitCode;
    } else {
      // An error escaped the command without going through emitJsonError; map it
      // to an exit code the same way main()/emitJsonError would.
      code = classifyExitCode(error);
      stderr += `${error instanceof Error ? error.message : String(error)}\n`;
    }
  } finally {
    // If the command set process.exitCode without calling process.exit() (deferred
    // exit pattern used to allow stdout flush before terminating), pick it up here
    // so the captured code reflects the intended exit status. Only act when the
    // exitCode was changed by the command (differs from the saved value before the
    // run), to avoid picking up stale values from prior parallel tests.
    const pendingExitCode = typeof process.exitCode === "number" ? process.exitCode : undefined;
    if (code === 0 && pendingExitCode != null && pendingExitCode !== 0 && pendingExitCode !== realExitCode) {
      code = pendingExitCode;
    }
    // Restore the process-wide exit code. NOTE: under `bun test`, once
    // `process.exitCode` has been set to a non-zero number (the deferred-exit
    // pattern in e.g. `lint --fail-on-flagged`), assigning `undefined` does NOT
    // clear it — the runner still exits non-zero at the end. Only assigning a
    // numeric `0` resets it. So when the captured baseline was `undefined`
    // (the normal case: nothing had set an exit code before this run), restore
    // to `0` rather than `undefined`. This is what makes the sequential
    // (`TEST_PARALLEL=1`) run exit 0 even though a captured command set a
    // deferred non-zero exit code mid-test.
    process.exitCode = realExitCode ?? 0;
    process.stdout.write = realStdoutWrite;
    process.stderr.write = realStderrWrite;
    console.log = realLog;
    console.error = realError;
    console.warn = realWarn;
    console.info = realInfo;
    console.debug = realDebug;
    (process as unknown as { exit: typeof realExit }).exit = realExit;
    process.argv = realArgv;
  }

  return { code, stdout, stderr };
}
