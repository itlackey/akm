// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Testable watch-mode core for `akm extract --watch` (#606).
 *
 * This module holds NO real `fs.watch`: the event source is injected so the
 * debounce / routing / stop logic is fully unit-testable with a fake source +
 * injected clock. The CLI layer (extract-cli.ts) is the only place that
 * constructs a real `fs.watch`-backed {@link WatchEventSource}.
 *
 * Design:
 *   - A burst of rapid events for one harness coalesces into ONE trigger
 *     (per-harness debounce keyed by harness name).
 *   - Unrelated / wrong-shape paths are ignored and never schedule a timer.
 *   - `stop()` unsubscribes the listener and clears every pending timer; it is
 *     idempotent and leaves nothing running (PROCESS-HYGIENE).
 *   - Overlapping triggers for the same harness never run concurrently: an
 *     in-flight guard re-runs once after the current trigger resolves instead
 *     of launching a second extract in parallel.
 */

import type { WatchTarget } from "../../integrations/session-logs";
import { akmExtract } from "./extract";

/** A filesystem change event the watcher reacts to. */
export interface WatchEvent {
  path: string;
}

/**
 * The injectable event source. `subscribe` registers a listener and returns an
 * unsubscribe function that removes it. The CLI adapts `fs.watch` to this
 * shape; tests provide a fake that pushes events synchronously.
 */
export interface WatchEventSource {
  subscribe(listener: (e: WatchEvent) => void): () => void;
}

export interface AkmExtractWatchOptions {
  /** Per-harness watch roots (from `getWatchTargets()`). */
  roots: WatchTarget[];
  /** Injected event source (real fs.watch adapter in the CLI; fake in tests). */
  eventSource: WatchEventSource;
  /**
   * Called once per settled debounce window for a harness. Defaults to running
   * the real `akmExtract` for that harness. Tests inject a spy.
   */
  onTrigger?: (harnessName: string) => Promise<void> | void;
  /** Debounce window in ms (default 2000). */
  debounceMs?: number;
  /** Injectable timer fns so tests drive a fake clock deterministically. */
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
  /** Override the default session-file predicate (rarely needed). */
  isSessionFile?: (filePath: string, roots: WatchTarget[]) => boolean;
}

export interface AkmExtractWatchHandle {
  /** Stop watching: unsubscribe, clear pending timers. Idempotent. */
  stop(): void;
}

const DEFAULT_DEBOUNCE_MS = 2000;
/** Small look-back window for the default trigger's `akmExtract` call. */
const DEFAULT_TRIGGER_SINCE = "10m";

/**
 * Does `filePath` look like a real session file under one of the configured
 * roots? True only when the path is under a root AND matches that harness's
 * on-disk session-file shape:
 *   - claude-code: `<root>/<project>/<id>.jsonl`
 *   - opencode:    `<root>/<project>/<id>.json`
 * Anything out-of-root, or in-root with the wrong extension, returns false.
 */
export function isSessionFile(filePath: string, roots: WatchTarget[]): boolean {
  return matchHarness(filePath, roots) !== undefined;
}

/** Normalize a path for prefix comparison (ensure a trailing separator). */
function withSep(dir: string): string {
  return dir.endsWith("/") ? dir : `${dir}/`;
}

/**
 * Resolve which harness a path belongs to by longest-prefix match against the
 * configured roots, then validate the file shape for that harness. Returns the
 * harness name, or `undefined` when the path is out-of-root or not a session
 * file. Longest-prefix match guards against the (in practice impossible) case
 * of nested roots.
 */
export function matchHarness(filePath: string, roots: WatchTarget[]): string | undefined {
  let best: { harnessName: string } | undefined;
  let bestLen = -1;
  for (const target of roots) {
    for (const root of target.roots) {
      const prefix = withSep(root);
      if (filePath.startsWith(prefix) && prefix.length > bestLen) {
        best = { harnessName: target.harnessName };
        bestLen = prefix.length;
      }
    }
  }
  if (!best) return undefined;
  // Validate the file shape for the resolved harness.
  if (best.harnessName === "claude-code") {
    return filePath.endsWith(".jsonl") ? best.harnessName : undefined;
  }
  if (best.harnessName === "opencode") {
    return filePath.endsWith(".json") ? best.harnessName : undefined;
  }
  // Unknown harness: accept any file under its root.
  return best.harnessName;
}

/**
 * Start the watch-mode core. Returns a handle whose `stop()` tears everything
 * down. The event source is injected, so this never touches the real
 * filesystem itself.
 */
export function akmExtractWatch(options: AkmExtractWatchOptions): AkmExtractWatchHandle {
  const {
    roots,
    eventSource,
    debounceMs = DEFAULT_DEBOUNCE_MS,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
    isSessionFile: isSessionFileFn = isSessionFile,
  } = options;

  const onTrigger =
    options.onTrigger ??
    (async (harnessName: string) => {
      await akmExtract({ type: harnessName, since: DEFAULT_TRIGGER_SINCE, force: false });
    });

  let stopped = false;
  // Pending debounce timers, keyed by harness name.
  const pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // Harnesses with an in-flight trigger, and whether a re-run is queued.
  const inFlight = new Set<string>();
  const rerunPending = new Set<string>();

  function runTrigger(harnessName: string): void {
    if (stopped) return;
    if (inFlight.has(harnessName)) {
      // A trigger is already running for this harness; coalesce into a single
      // re-run after it resolves rather than launching a concurrent extract.
      rerunPending.add(harnessName);
      return;
    }
    inFlight.add(harnessName);
    // Invoke synchronously so a synchronous `onTrigger` observes its effect
    // before control returns (tests advance the clock then assert inline).
    // Wrap the (possibly async) result in a promise to drive the in-flight
    // guard's release without forcing the trigger itself into a microtask.
    let result: Promise<void> | void;
    try {
      result = onTrigger(harnessName);
    } catch (err) {
      // One failed extract must never kill the watcher (mirrors the non-fatal
      // handling in collectSessionEvents).
      console.error(`[akm] extract --watch trigger for "${harnessName}" failed:`, err);
      inFlight.delete(harnessName);
      if (rerunPending.delete(harnessName) && !stopped) runTrigger(harnessName);
      return;
    }
    Promise.resolve(result)
      .catch((err) => {
        console.error(`[akm] extract --watch trigger for "${harnessName}" failed:`, err);
      })
      .finally(() => {
        inFlight.delete(harnessName);
        if (rerunPending.delete(harnessName) && !stopped) {
          runTrigger(harnessName);
        }
      });
  }

  function onEvent(e: WatchEvent): void {
    if (stopped) return;
    if (!isSessionFileFn(e.path, roots)) return;
    const harnessName = matchHarness(e.path, roots);
    if (!harnessName) return;
    const existing = pendingTimers.get(harnessName);
    if (existing !== undefined) clearTimeoutFn(existing);
    const timer = setTimeoutFn(() => {
      pendingTimers.delete(harnessName);
      if (!stopped) runTrigger(harnessName);
    }, debounceMs);
    pendingTimers.set(harnessName, timer);
  }

  const unsubscribe = eventSource.subscribe(onEvent);

  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      unsubscribe();
      for (const timer of pendingTimers.values()) clearTimeoutFn(timer);
      pendingTimers.clear();
      rerunPending.clear();
    },
  };
}
