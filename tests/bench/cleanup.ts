/**
 * Shared cleanup registry for the bench harness (#267).
 *
 * The bench creates many tmp directories — per (task, arm, seed) workspace,
 * per-task fixture stash, per-fixture evolveStash + preStash. Each of these
 * is wrapped in a try/finally so happy-path runs leave nothing behind. But
 * an external SIGINT/SIGTERM (operator hits Ctrl-C, CI cancels the job)
 * bypasses `finally` blocks entirely on Bun, leaving orphan tmp dirs under
 * `os.tmpdir()` that nothing reaps.
 *
 * `registerCleanup(fn)` captures the cleanup intent on a process-wide
 * registry and returns a deregister function. The first `registerCleanup`
 * call also installs ONE pair of SIGINT/SIGTERM handlers — subsequent calls
 * never re-install. On signal we walk every registered fn (swallowing
 * errors), remove our own listeners (so a second Ctrl-C force-exits), and
 * `process.exit(130)`.
 *
 * The handler is idempotent: re-entrant signals while cleanup is in flight
 * are dropped. Per-tmp `try/finally` callers should:
 *   1. Register the cleanup at the top of `try`.
 *   2. Deregister it in `finally` *before* running cleanup themselves so the
 *      handler doesn't double-fire.
 */

export type CleanupFn = () => void | Promise<void>;

interface Registry {
  fns: Set<CleanupFn>;
  installed: boolean;
  running: boolean;
  handlerSigint?: () => void;
  handlerSigterm?: () => void;
}

const registry: Registry = {
  fns: new Set(),
  installed: false,
  running: false,
};

/**
 * Register a cleanup function. Returns a deregister thunk that removes the
 * function from the registry. Calling deregister after the function has
 * already run is a no-op.
 */
export function registerCleanup(fn: CleanupFn): () => void {
  registry.fns.add(fn);
  installSignalHandlers();
  return () => {
    registry.fns.delete(fn);
  };
}

function installSignalHandlers(): void {
  if (registry.installed) return;
  registry.installed = true;

  const handler = (): void => {
    // Re-entrant signals are dropped — a second Ctrl-C will hit our
    // already-removed listeners and the runtime's default handler will
    // force-exit. That is the documented escape hatch.
    if (registry.running) return;
    registry.running = true;
    // Snapshot then drop registrations. We invoke synchronously where
    // possible; async fns get fired-and-forget but we still await them so
    // the exit doesn't beat the rmdir on slow filesystems.
    const fns = [...registry.fns];
    registry.fns.clear();
    void runAllAndExit(fns);
  };

  registry.handlerSigint = handler;
  registry.handlerSigterm = handler;
  process.on("SIGINT", handler);
  process.on("SIGTERM", handler);
}

async function runAllAndExit(fns: CleanupFn[]): Promise<void> {
  for (const fn of fns) {
    try {
      await fn();
    } catch {
      // Best-effort: cleanup must never throw out of the signal path.
    }
  }
  // Remove our listeners so a second Ctrl-C force-exits via the default.
  if (registry.handlerSigint) process.off("SIGINT", registry.handlerSigint);
  if (registry.handlerSigterm) process.off("SIGTERM", registry.handlerSigterm);
  registry.installed = false;
  registry.handlerSigint = undefined;
  registry.handlerSigterm = undefined;
  // 128 + SIGINT(2) — POSIX convention for signal-induced exits.
  process.exit(130);
}

// ── Test-only seam ──────────────────────────────────────────────────────────

/**
 * Test-only: drive the cleanup path as if a signal arrived, *without*
 * calling `process.exit`. Returns a promise that resolves once every
 * registered fn has settled. Used by the unit test to assert ordering
 * without killing the test process.
 *
 * Resets the registry to an uninstalled state on completion so subsequent
 * tests can re-install handlers cleanly.
 */
export async function _drainForTest(): Promise<void> {
  const fns = [...registry.fns];
  registry.fns.clear();
  registry.running = true;
  for (const fn of fns) {
    try {
      await fn();
    } catch {
      /* swallow */
    }
  }
  if (registry.handlerSigint) process.off("SIGINT", registry.handlerSigint);
  if (registry.handlerSigterm) process.off("SIGTERM", registry.handlerSigterm);
  registry.installed = false;
  registry.running = false;
  registry.handlerSigint = undefined;
  registry.handlerSigterm = undefined;
}

/** Test-only: reset the registry without firing cleanups (for unit setup). */
export function _resetForTest(): void {
  registry.fns.clear();
  if (registry.handlerSigint) process.off("SIGINT", registry.handlerSigint);
  if (registry.handlerSigterm) process.off("SIGTERM", registry.handlerSigterm);
  registry.installed = false;
  registry.running = false;
  registry.handlerSigint = undefined;
  registry.handlerSigterm = undefined;
}

/** Test-only: peek at the current registration count. */
export function _registeredCountForTest(): number {
  return registry.fns.size;
}
