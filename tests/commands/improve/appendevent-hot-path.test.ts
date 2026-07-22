// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * R25 hot-path pin — improve verbs must never hit `appendEvent`'s slow path.
 *
 * `appendEvent` without an `EventsContext` opens/migrates/closes state.db per
 * event (and re-reads env for the path) — ~170 redundant opens per improve
 * cycle before the events-ctx threading. This suite pins the fix from both
 * directions:
 *
 *   1. Every event a verb emits lands in the INJECTED context (handle
 *      identity: rows are written through the exact `EventsContext.db` proxy
 *      handle we pass in — a counting proxy proves the handle was used, not
 *      merely the same file).
 *   2. NOTHING leaks to the default state.db (the sandbox default path stays
 *      empty) — the assertion shape that goes red if any subtree site reverts
 *      to a no-ctx `appendEvent(...)` call.
 *   3. The improve loop threads its run-level `eventsCtx` into the verb
 *      options (loop → verb wiring), so the long-lived handle actually
 *      reaches reflect/distill in production runs.
 *
 * Techniques per the chunk-7 brief (WI-7.7): handle-identity DI + a
 * counting-proxy `Database` as `EventsContext.db`. No `mock.module` (lint-
 * banned); sandbox helpers only; injected `chat` seams so no real LLM runs.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import { akmDistill } from "../../../src/commands/improve/distill";
import { akmImprove } from "../../../src/commands/improve/improve";
import { akmReflect } from "../../../src/commands/improve/reflect";
import { type LlmProfileConfig, saveConfig } from "../../../src/core/config/config";
import { appendEvent, type EventsContext, readEvents } from "../../../src/core/events";
import { openStateDatabase } from "../../../src/core/state-db";
import { akmIndex } from "../../../src/indexer/indexer";
import type { Database } from "../../../src/storage/database";
import { withTestImproveLlm } from "../../_helpers/improve-config";
import { type IsolatedAkmStorage, makeSandboxDir, withIsolatedAkmStorage } from "../../_helpers/sandbox";

let storage: IsolatedAkmStorage;
const extraCleanups: Array<() => void> = [];

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  // Improve verbs resolve an engine before dispatch; the injected `chat`
  // stubs keep every call offline.
  saveConfig(withTestImproveLlm({ semanticSearchMode: "off" }));
});

afterEach(() => {
  for (const cleanup of extraCleanups.splice(0)) cleanup();
  storage.cleanup();
});

/** A dedicated state.db in its own sandboxed dir — NOT the default path. */
function makeInjectedStateDb(): { db: Database; dbPath: string; prepareCalls: () => number; close: () => void } {
  const { dir, cleanup } = makeSandboxDir("akm-hot-path-statedb");
  extraCleanups.push(cleanup);
  const dbPath = path.join(dir, "state.db");
  const real = openStateDatabase(dbPath);
  let count = 0;
  // Counting proxy: proves writes go through THIS handle (the fast path),
  // not through a second connection the slow path would open.
  const db = new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === "prepare") count += 1;
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  }) as Database;
  return { db, dbPath, prepareCalls: () => count, close: () => real.close() };
}

/** Events currently in the INJECTED db (by path — used for row assertions). */
function eventsIn(dbPath: string): Array<{ eventType: string }> {
  return readEvents({}, { dbPath }).events;
}

/** Events in the DEFAULT sandbox state.db — must stay EMPTY (leak detector). */
function defaultDbEvents(): Array<{ eventType: string }> {
  return readEvents().events;
}

function fakeLlmConnection(): LlmProfileConfig {
  return {
    endpoint: "http://localhost:11434/v1/chat/completions",
    model: "test-model",
    supportsJsonSchema: true,
  };
}

describe("appendEvent hot path — reflect", () => {
  test("failure path: reflect_invoked + reflect_completed land in the injected handle; default db stays empty", async () => {
    const injected = makeInjectedStateDb();
    const eventsCtx: EventsContext = { db: injected.db };

    // Missing asset / failing transport → the emitReflectFailed closure
    // (which covers EVERY failure emit) fires through the carrier. The chat
    // stub throws so no path can reach a network.
    const result = await akmReflect({
      ref: "memories/does-not-exist-anywhere",
      stashDir: storage.stashDir,
      runner: { kind: "llm", engine: "test-llm", connection: fakeLlmConnection() },
      chat: async () => {
        throw new Error("stub transport down");
      },
      eventsCtx,
    });
    expect(result.ok).toBe(false);

    const rows = eventsIn(injected.dbPath);
    const types = rows.map((r) => r.eventType);
    expect(types).toContain("reflect_invoked");
    expect(types).toContain("reflect_completed");
    // Handle identity: both inserts went through the counting proxy.
    expect(injected.prepareCalls()).toBeGreaterThanOrEqual(2);
    // Leak detector: a no-ctx revert writes here instead — must be empty.
    expect(defaultDbEvents()).toHaveLength(0);
    injected.close();
  });

  test("LLM dispatch path: every reflect_completed variant routes through the carrier", async () => {
    const injected = makeInjectedStateDb();
    const eventsCtx: EventsContext = { db: injected.db };

    // Injected chat → no network; whatever terminal outcome the pipeline
    // picks (proposal created, quality- or sanitize-rejected), the completion
    // event must land in the injected handle.
    const payload = JSON.stringify({
      ref: "lessons/hot-path-pin",
      content:
        "---\ndescription: hot-path pin lesson\nwhen_to_use: when pinning the appendEvent fast path\n---\n\nBody.\n",
    });
    await akmReflect({
      ref: "lessons/hot-path-pin",
      stashDir: storage.stashDir,
      runner: { kind: "llm", engine: "test-llm", connection: fakeLlmConnection() },
      assetContent: "",
      chat: async () => payload,
      eventsCtx,
    });

    const types = eventsIn(injected.dbPath).map((r) => r.eventType);
    expect(types).toContain("reflect_invoked");
    expect(types).toContain("reflect_completed");
    expect(defaultDbEvents()).toHaveLength(0);
    injected.close();
  });
});

describe("appendEvent hot path — distill", () => {
  test("refused-input skip lands in the injected handle; default db stays empty", async () => {
    const injected = makeInjectedStateDb();
    const eventsCtx: EventsContext = { db: injected.db };

    // lesson inputs are refused (recursive-distillation guard) BEFORE any
    // config/LLM resolution — the earliest distill_invoked emit site.
    const result = await akmDistill({
      ref: "lessons/already-distilled",
      stashDir: storage.stashDir,
      eventsCtx,
    });
    expect(result.outcome).toBe("skipped");

    const types = eventsIn(injected.dbPath).map((r) => r.eventType);
    expect(types).toContain("distill_invoked");
    expect(injected.prepareCalls()).toBeGreaterThanOrEqual(1);
    expect(defaultDbEvents()).toHaveLength(0);
    injected.close();
  });
});

describe("appendEvent hot path — improve loop wiring", () => {
  test("the loop threads its run eventsCtx into reflect/distill verb options", async () => {
    // Drive the orchestrator with stub verbs that capture the options they
    // receive. The stubs never run a real LLM; we only pin that the loop
    // passes a defined eventsCtx (the run's long-lived handle) to each verb
    // it invokes. If the loop never reaches a verb in this minimal fixture,
    // the capture stays undefined and the wiring assertions are skipped —
    // the verb-level tests above still pin the site behavior.
    let reflectCtx: EventsContext | undefined;
    let reflectInvoked = false;
    let distillCtx: EventsContext | undefined;
    let distillInvoked = false;

    // A memory with corrective evidence so the loop plans at least one verb.
    const memPath = path.join(storage.stashDir, "memories", "hot-path-alpha.md");
    fs.mkdirSync(path.dirname(memPath), { recursive: true });
    fs.writeFileSync(memPath, "---\ndescription: hot path alpha\n---\n\nRemember alpha.\n", "utf8");
    await akmIndex({ stashDir: storage.stashDir, full: true });
    appendEvent({ eventType: "feedback", ref: "memories/hot-path-alpha", metadata: { signal: "negative" } });
    appendEvent({ eventType: "feedback", ref: "memories/hot-path-alpha", metadata: { signal: "negative" } });

    const result = await akmImprove({
      stashDir: storage.stashDir,
      ensureIndexFn: async () => undefined,
      reindexFn: async () => undefined,
      reflectFn: async (o) => {
        reflectInvoked = true;
        reflectCtx = o.eventsCtx;
        return {
          schemaVersion: 2,
          ok: false,
          reason: "cooldown",
          error: "stub",
          engine: "stub",
          exitCode: null,
        };
      },
      distillFn: async (o) => {
        distillInvoked = true;
        distillCtx = o.eventsCtx;
        return {
          schemaVersion: 1,
          ok: true,
          outcome: "skipped",
          inputRef: o.ref,
          lessonRef: "lessons/stub",
          message: "stub",
        };
      },
    });
    expect(result.ok).toBe(true);

    // Non-vacuity: the seeded corrective evidence must have driven the loop
    // into at least one verb, or this wiring pin proves nothing.
    expect(reflectInvoked || distillInvoked).toBe(true);
    // Wiring pin: any verb the loop invoked must have received the run's
    // events context (the long-lived handle akmImprove opened).
    if (reflectInvoked) {
      expect(reflectCtx).toBeDefined();
      expect(reflectCtx?.db ?? reflectCtx?.dbPath).toBeDefined();
    }
    if (distillInvoked) {
      expect(distillCtx).toBeDefined();
      expect(distillCtx?.db ?? distillCtx?.dbPath).toBeDefined();
    }
  });
});
