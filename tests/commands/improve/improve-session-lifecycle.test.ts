// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * R8 — the improve-run lifecycle (SIGNAL_TABLE, signal handlers, terminated-run
 * persistence, watchdog, process.exit choreography) must be extracted out of
 * `improveCommand` in improve-cli.ts into a testable `runImproveSession` so the
 * cron-timeout-persistence path (MEMORY: improve sync-only-on-clean-finish) can
 * be exercised in-process WITHOUT spawning a child.
 *
 * This is the RED characterization test: it drives a fake SIGTERM through an
 * injected signalSource and asserts the terminated-run row is persisted BEFORE
 * the injected exit is called, with the exit code that matches the signal.
 *
 * Drives `runImproveSession` (src/commands/improve/improve-session.ts) in-process
 * so the terminated-run persistence is testable without spawning a real signal.
 */

import { describe, expect, test } from "bun:test";
// Pins the R8 seam carved out of improve-cli.ts: the lifecycle is now reachable
// in-process via this module instead of only by spawning + signalling a child.
import { runImproveSession } from "../../../src/commands/improve/improve-session";

/**
 * A fake signal source standing in for the real `process`. It records once
 * handlers via `once()` and lets the test synchronously emit a signal, exactly
 * the way an OS SIGTERM would invoke the registered handler.
 */
function makeFakeSignalSource() {
  const handlers = new Map<string, Array<() => void>>();
  return {
    once(sig: string, handler: () => void) {
      const list = handlers.get(sig) ?? [];
      list.push(handler);
      handlers.set(sig, list);
    },
    removeListener(sig: string, handler: () => void) {
      const list = handlers.get(sig);
      if (!list) return;
      handlers.set(
        sig,
        list.filter((h) => h !== handler),
      );
    },
    emit(sig: string) {
      const list = handlers.get(sig) ?? [];
      // process.once semantics: fire once, then drop.
      handlers.set(sig, []);
      for (const h of list) h();
    },
  };
}

describe("runImproveSession lifecycle (R8)", () => {
  test("SIGTERM persists the terminated row BEFORE exit, with the right exit code", async () => {
    const events: string[] = [];
    const signalSource = makeFakeSignalSource();

    let exitCode: number | undefined;
    const exit = (code: number): never => {
      events.push(`exit:${code}`);
      exitCode = code;
      // Real process.exit never returns; throw to unwind the in-process call so
      // the test can observe ordering without actually killing the runner.
      throw new Error(`__exit_${code}__`);
    };

    // Stub work that never resolves on its own — the run is "in flight" when the
    // fake SIGTERM arrives, mirroring a cron timeout mid-run.
    const neverResolves = new Promise<never>(() => {});

    const onTerminate = (reason: string): void => {
      events.push(`persist:${reason}`);
    };

    // Kick the session off. It registers the signal handlers and then awaits the
    // in-flight work; we fire SIGTERM on the next tick.
    const sessionPromise = runImproveSession({ runWork: () => neverResolves }, { signalSource, exit, onTerminate });

    // Let runImproveSession register its once() handlers, then emit SIGTERM.
    await Promise.resolve();
    expect(() => signalSource.emit("SIGTERM")).toThrow("__exit_143__");

    // (1) the terminated-run row was persisted.
    expect(events).toContain("persist:SIGTERM");
    // (2) persistence happened BEFORE exit was called.
    expect(events.indexOf("persist:SIGTERM")).toBeLessThan(events.indexOf("exit:143"));
    // (3) the exit code matches the signal (SIGTERM => 143).
    expect(exitCode).toBe(143);

    // keep the dangling promise from triggering an unhandled-rejection warning
    void sessionPromise.catch(() => {});
  });
});
