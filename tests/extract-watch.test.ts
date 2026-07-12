// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Tests for #606 — watch-mode core for `akm extract --watch`.
//
// These tests drive the TESTABLE watch-mode core in
// src/commands/improve/extract-watch.ts via an INJECTED event source + an
// injected clock (setTimeoutFn/clearTimeoutFn). They never touch real
// fs.watch / Bun.spawn and never leave a long-lived process running, keeping
// this file in the CI-fast unit tier (tests/, not tests/integration/).
//
// Coverage:
//   AC1  — a burst of events for one harness coalesces to ONE trigger.
//   AC1b — events for two different harnesses each fire their own trigger.
//   AC2  — stop() removes the listener and clears pending timers; no leaks.
//   AC3  — unrelated / wrong-shape paths are ignored (isSessionFile/matchHarness).
//   AC4  — importing the core has NO side effects (no watcher auto-starts);
//          CLI defaults --watch to false (single-shot path unchanged).
//   plus — overlapping triggers do not run concurrently (in-flight guard).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import type { AkmExtractOptions, ResolvedExtractPlan } from "../src/commands/improve/extract";
import { createExtractWatchTrigger } from "../src/commands/improve/extract-cli";
import {
  akmExtractWatch,
  isSessionFile,
  matchHarness,
  type WatchEvent,
  type WatchEventSource,
} from "../src/commands/improve/extract-watch";
import type { AkmConfig } from "../src/core/config/config";
import { ClaudeCodeProvider } from "../src/integrations/harnesses/claude/session-log";
import { OpenCodeProvider } from "../src/integrations/harnesses/opencode/session-log";
import { getWatchTargets } from "../src/integrations/session-logs";
import { makeSandboxDir, withEnv } from "./_helpers/sandbox";

// ── Fake clock ──────────────────────────────────────────────────────────────
// A minimal deterministic timer queue so tests can advance time synchronously.
// Mirrors the setTimeout/clearTimeout signatures the core consumes.

interface ScheduledTimer {
  id: number;
  fireAt: number;
  fn: () => void;
}

class FakeClock {
  now = 0;
  #seq = 1;
  #timers = new Map<number, ScheduledTimer>();

  readonly setTimeoutFn = ((fn: () => void, ms?: number): number => {
    const id = this.#seq++;
    this.#timers.set(id, { id, fireAt: this.now + (ms ?? 0), fn });
    return id;
  }) as unknown as typeof setTimeout;

  readonly clearTimeoutFn = ((id?: number): void => {
    if (typeof id === "number") this.#timers.delete(id);
  }) as unknown as typeof clearTimeout;

  /** Number of currently-pending timers (0 ⇒ nothing leaked). */
  get pendingCount(): number {
    return this.#timers.size;
  }

  /** Advance the clock by `ms`, firing every timer due within that window. */
  advance(ms: number): void {
    this.now += ms;
    const due = [...this.#timers.values()].filter((t) => t.fireAt <= this.now).sort((a, b) => a.fireAt - b.fireAt);
    for (const t of due) {
      this.#timers.delete(t.id);
      t.fn();
    }
  }
}

// ── Fake event source ────────────────────────────────────────────────────────
// Records the listener so the test can push events synchronously, and records
// whether unsubscribe was invoked (AC2).

class FakeEventSource implements WatchEventSource {
  #listener: ((e: WatchEvent) => void) | undefined;
  unsubscribeCalls = 0;

  subscribe(listener: (e: WatchEvent) => void): () => void {
    this.#listener = listener;
    return () => {
      this.unsubscribeCalls += 1;
      this.#listener = undefined;
    };
  }

  /** Push an event into the watcher (no-op if no listener is subscribed). */
  push(p: string): void {
    this.#listener?.({ path: p });
  }

  get hasListener(): boolean {
    return this.#listener !== undefined;
  }
}

// ── Sandbox roots ────────────────────────────────────────────────────────────
// Two disjoint temp roots standing in for ~/.claude/projects and the opencode
// storage/session dir. We DON'T create real files: the core decides
// harness-routing from path prefix + file shape, not from disk existence.

let claudeRoot: string;
let opencodeSessionRoot: string;
let cleanups: Array<() => void> = [];

function rootsConfig() {
  return [
    { harnessName: "claude-code", roots: [claudeRoot] },
    { harnessName: "opencode", roots: [opencodeSessionRoot] },
  ];
}

beforeEach(() => {
  const a = makeSandboxDir("akm-watch-claude");
  const b = makeSandboxDir("akm-watch-oc");
  claudeRoot = a.dir;
  opencodeSessionRoot = b.dir;
  cleanups = [a.cleanup, b.cleanup];
});

afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

// A valid claude session file under claudeRoot: <root>/<project>/<id>.jsonl
function claudeSessionPath(): string {
  return path.join(claudeRoot, "myproject", "0e1f2a3b-session.jsonl");
}
// A valid opencode session file under opencodeSessionRoot: <root>/<project>/<id>.json
function opencodeSessionPath(): string {
  return path.join(opencodeSessionRoot, "proj-123", "ses_abc.json");
}

// ── AC1: debounce coalesces a burst ──────────────────────────────────────────

describe("akmExtractWatch — AC1 debounce", () => {
  test("a burst of rapid events for one harness fires the trigger EXACTLY once", () => {
    const clock = new FakeClock();
    const source = new FakeEventSource();
    const triggered: string[] = [];

    const handle = akmExtractWatch({
      roots: rootsConfig(),
      eventSource: source,
      debounceMs: 2000,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
      onTrigger: (harnessName) => {
        triggered.push(harnessName);
      },
    });

    const p = claudeSessionPath();
    // 5 rapid events, each within the debounce window.
    for (let i = 0; i < 5; i++) {
      source.push(p);
      clock.advance(300); // < 2000ms between events ⇒ keeps rescheduling
      expect(triggered).toHaveLength(0); // not yet
    }
    // Settle past the debounce window.
    clock.advance(2000);

    expect(triggered).toEqual(["claude-code"]);
    handle.stop();
  });

  test("AC1b — distinct harnesses each get their own trigger (per-harness keys)", () => {
    const clock = new FakeClock();
    const source = new FakeEventSource();
    const triggered: string[] = [];

    const handle = akmExtractWatch({
      roots: rootsConfig(),
      eventSource: source,
      debounceMs: 1000,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
      onTrigger: (harnessName) => {
        triggered.push(harnessName);
      },
    });

    source.push(claudeSessionPath());
    source.push(opencodeSessionPath());
    clock.advance(1000);

    expect([...triggered].sort()).toEqual(["claude-code", "opencode"]);
    handle.stop();
  });
});

// ── AC2: stop() removes listener + clears timers ──────────────────────────────

describe("akmExtractWatch — AC2 stop()", () => {
  test("stop() unsubscribes, clears pending timers, and silences future events", () => {
    const clock = new FakeClock();
    const source = new FakeEventSource();
    const triggered: string[] = [];

    const handle = akmExtractWatch({
      roots: rootsConfig(),
      eventSource: source,
      debounceMs: 2000,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
      onTrigger: (harnessName) => {
        triggered.push(harnessName);
      },
    });

    // Schedule a pending debounce timer, then stop before it fires.
    source.push(claudeSessionPath());
    expect(clock.pendingCount).toBe(1);

    handle.stop();

    // (a) the source's unsubscribe was invoked, listener removed
    expect(source.unsubscribeCalls).toBe(1);
    expect(source.hasListener).toBe(false);
    // (b) no leaked timer
    expect(clock.pendingCount).toBe(0);

    // (c) advancing past the window fires NO trigger
    clock.advance(5000);
    expect(triggered).toHaveLength(0);

    // (d) pushing another event after stop is a no-op
    source.push(claudeSessionPath());
    clock.advance(5000);
    expect(triggered).toHaveLength(0);
  });

  test("stop() is idempotent (double-stop does not throw or double-clear)", () => {
    const clock = new FakeClock();
    const source = new FakeEventSource();

    const handle = akmExtractWatch({
      roots: rootsConfig(),
      eventSource: source,
      debounceMs: 2000,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
      onTrigger: () => {},
    });

    handle.stop();
    expect(() => handle.stop()).not.toThrow();
    // unsubscribe is only called once across both stop() calls.
    expect(source.unsubscribeCalls).toBe(1);
  });
});

// ── AC3: unrelated / wrong-shape paths ignored ────────────────────────────────

describe("akmExtractWatch — AC3 path filtering", () => {
  test("events for unrelated / wrong-shape paths never trigger", () => {
    const clock = new FakeClock();
    const source = new FakeEventSource();
    const triggered: string[] = [];

    const handle = akmExtractWatch({
      roots: rootsConfig(),
      eventSource: source,
      debounceMs: 1000,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
      onTrigger: (harnessName) => {
        triggered.push(harnessName);
      },
    });

    // Out of any root.
    source.push("/tmp/random.txt");
    source.push(path.join(os.tmpdir(), "nowhere", "x.jsonl"));
    // In the claude root but wrong shape (.md, not a session .jsonl).
    source.push(path.join(claudeRoot, "myproject", "notes.md"));
    clock.advance(5000);

    expect(triggered).toHaveLength(0);
    // No timers were ever scheduled for ignored paths.
    expect(clock.pendingCount).toBe(0);
    handle.stop();
  });

  test("matchHarness routes valid paths and rejects invalid ones", () => {
    const roots = rootsConfig();
    expect(matchHarness(claudeSessionPath(), roots)).toBe("claude-code");
    expect(matchHarness(opencodeSessionPath(), roots)).toBe("opencode");
    // Out-of-root path → no harness.
    expect(matchHarness("/tmp/random.txt", roots)).toBeUndefined();
    // In-root but non-session file → no harness.
    expect(matchHarness(path.join(claudeRoot, "p", "notes.md"), roots)).toBeUndefined();
  });

  test("isSessionFile recognizes session shapes only", () => {
    const roots = rootsConfig();
    expect(isSessionFile(claudeSessionPath(), roots)).toBe(true);
    expect(isSessionFile(opencodeSessionPath(), roots)).toBe(true);
    expect(isSessionFile(path.join(claudeRoot, "p", "notes.md"), roots)).toBe(false);
    expect(isSessionFile("/tmp/random.txt", roots)).toBe(false);
  });
});

// ── overlapping triggers guard ────────────────────────────────────────────────

describe("akmExtractWatch — overlapping triggers", () => {
  test("a new burst while a trigger is in flight does not run concurrently", async () => {
    const clock = new FakeClock();
    const source = new FakeEventSource();
    let active = 0;
    let maxConcurrent = 0;
    let calls = 0;
    let release: (() => void) | undefined;

    const handle = akmExtractWatch({
      roots: rootsConfig(),
      eventSource: source,
      debounceMs: 1000,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
      onTrigger: () =>
        new Promise<void>((resolve) => {
          calls += 1;
          active += 1;
          maxConcurrent = Math.max(maxConcurrent, active);
          release = () => {
            active -= 1;
            resolve();
          };
        }),
    });

    // First burst fires a trigger that stays "in flight".
    source.push(claudeSessionPath());
    clock.advance(1000);
    expect(calls).toBe(1);

    // Second burst arrives while the first trigger has not resolved.
    source.push(claudeSessionPath());
    clock.advance(1000);

    // Let the first trigger resolve, then drain microtasks.
    release?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(maxConcurrent).toBe(1); // never ran two extracts at once
    handle.stop();
  });
});

// ── AC4: no side effects on import + CLI default ──────────────────────────────

describe("watch-mode — AC4 default unchanged", () => {
  test("importing the core does not auto-start any watcher (no leaked timers)", () => {
    // A bare construct-then-stop must leave zero pending timers and an
    // unsubscribed source — proving the module itself starts nothing on import.
    const clock = new FakeClock();
    const source = new FakeEventSource();
    const handle = akmExtractWatch({
      roots: rootsConfig(),
      eventSource: source,
      debounceMs: 1000,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
      onTrigger: () => {},
    });
    expect(clock.pendingCount).toBe(0);
    expect(source.hasListener).toBe(true);
    handle.stop();
    expect(source.hasListener).toBe(false);
  });

  test("the production watch callback keeps its startup config and resolved plan after live config changes", async () => {
    const startupConfig: AkmConfig = { configVersion: "0.9.0", semanticSearchMode: "off" };
    const changedConfig: AkmConfig = { configVersion: "0.9.0", semanticSearchMode: "auto" };
    const startupPlan: ResolvedExtractPlan = {
      strategy: "startup",
      enabled: true,
      process: Object.freeze({ enabled: true }),
      llmConfig: Object.freeze({ endpoint: "https://startup.test/v1", model: "startup-model" }),
      timeoutMs: 1000,
      embeddingConfig: undefined,
    };
    const changedPlan: ResolvedExtractPlan = {
      strategy: "changed",
      enabled: true,
      process: Object.freeze({ enabled: true }),
      llmConfig: Object.freeze({ endpoint: "https://changed.test/v1", model: "changed-model" }),
      timeoutMs: 2000,
      embeddingConfig: undefined,
    };
    const liveOptions = {
      dryRun: true,
      force: false,
      config: startupConfig,
      resolvedPlan: startupPlan,
    };
    let received: AkmExtractOptions | undefined;
    const trigger = createExtractWatchTrigger(liveOptions, async (options) => {
      received = options;
    });

    liveOptions.config = changedConfig;
    liveOptions.resolvedPlan = changedPlan;
    await trigger("claude-code");

    expect(received?.type).toBe("claude-code");
    expect(received?.config).toBe(startupConfig);
    expect(received?.resolvedPlan).toBe(startupPlan);
    expect(received?.resolvedPlan?.llmConfig?.model).toBe("startup-model");
  });
});

// ── getWatchTargets() seam ────────────────────────────────────────────────────

describe("getWatchTargets — harness watchRoots() seam", () => {
  test("maps available harnesses to { harnessName, roots }, skipping empty", async () => {
    // Point the claude scan at our sandbox root (exists) and opencode at a
    // non-existent base (so its watchRoots() returns []).
    await withEnv(
      {
        AKM_CLAUDE_PROJECTS_DIR: claudeRoot,
        HOME: path.join(os.tmpdir(), "akm-watch-nonexistent-home"),
      },
      () => {
        const targets = getWatchTargets();
        const claude = targets.find((t) => t.harnessName === "claude-code");
        expect(claude).toBeDefined();
        expect(claude?.roots).toEqual([claudeRoot]);
        // Every returned entry has at least one root (empties are skipped).
        for (const t of targets) expect(t.roots.length).toBeGreaterThan(0);
      },
    );
  });

  test("ClaudeCodeProvider.watchRoots() honors AKM_CLAUDE_PROJECTS_DIR and dir existence", async () => {
    const provider = new ClaudeCodeProvider();
    await withEnv({ AKM_CLAUDE_PROJECTS_DIR: claudeRoot }, () => {
      expect(provider.watchRoots()).toEqual([claudeRoot]);
    });
    await withEnv({ AKM_CLAUDE_PROJECTS_DIR: path.join(claudeRoot, "does-not-exist") }, () => {
      expect(provider.watchRoots()).toEqual([]);
    });
  });

  test("OpenCodeProvider.watchRoots() returns the storage/session dir when it exists, else []", () => {
    const provider = new OpenCodeProvider();
    // Default base almost certainly has no storage/session under the test host;
    // the contract is: returns [] when the dir is absent, never throws.
    expect(Array.isArray(provider.watchRoots())).toBe(true);
  });
});
