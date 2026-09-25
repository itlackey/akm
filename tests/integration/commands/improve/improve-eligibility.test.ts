// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Candidate selection against the improve ledger.
 *
 * Reflect/distill: a ref is re-eligible iff new feedback landed since its last
 * attempt on that source (the ledger's `last_attempt_at`) and no rejection
 * window holds it. Consolidate: a memory judged within its revisit window and
 * unchanged since is not judged again. These tests seed ledger rows directly
 * and drive `akmImprove` end to end.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { inspectConsolidationPool } from "../../../../src/commands/improve/consolidate";
import {
  buildLatestFeedbackTsMap,
  collectEligibleRefs,
  dedupeRefs,
  resolveImproveScope,
} from "../../../../src/commands/improve/eligibility";
import { akmImprove } from "../../../../src/commands/improve/improve";
import type { AssetSalienceRow } from "../../../../src/commands/improve/salience";
import {
  DEFAULT_ENCODING_SALIENCE,
  DEFAULT_TYPE_ENCODING_WEIGHTS,
  isContentEncodingRow,
  upsertAssetSalience,
} from "../../../../src/commands/improve/salience";
import { improveStateReadRefs } from "../../../../src/commands/improve/source-identity";
import { saveConfig } from "../../../../src/core/config/config";
import type { ConfigError } from "../../../../src/core/errors";
import { appendEvent, readEvents } from "../../../../src/core/events";
import type { AkmDistillResult, AkmReflectResult } from "../../../../src/core/improve-types";
import { openStateDatabase } from "../../../../src/core/state-db";
import { akmIndex } from "../../../../src/indexer/indexer";
import {
  type ImproveLedgerOutcome,
  recordImproveLedger,
} from "../../../../src/storage/repositories/improve-ledger-repository";
import { closeDatabase, openExistingDatabase } from "../../../../src/storage/repositories/index-connection";
import { getAllEntries } from "../../../../src/storage/repositories/index-entries-repository";
import { withImproveAutonomy, withTestImproveLlm } from "../../../_helpers/improve-config";
import { type IsolatedAkmStorage, mutateScopedEnv, withIsolatedAkmStorage } from "../../../_helpers/sandbox";

describe("resolveImproveScope syntax classification", () => {
  test("rejects colon, fragment, and malformed slash-shaped explicit refs as usage errors", () => {
    for (const input of ["memory:old", "memories/item#section", "memories/../item"]) {
      expect(() => resolveImproveScope(input)).toThrow(/Invalid --scope/);
    }
  });
});

describe("dedupeRefs durable identity", () => {
  test("dedupes by itemRef while preserving the first display ref", () => {
    expect(
      dedupeRefs([
        { ref: "lessons/first-display", itemRef: "stash//lessons/shared", reason: "scope-type" },
        { ref: "lessons/second-display", itemRef: "stash//lessons/shared", reason: "scope-type" },
      ]),
    ).toEqual([{ ref: "lessons/first-display", itemRef: "stash//lessons/shared", reason: "scope-type" }]);
  });
});

// Deterministic, strictly-ordered timestamps for signal-delta ordering.
// These replace `await sleep(10)` between two appendEvent() calls: instead of
// relying on the wall clock to advance between writes (flaky on a coarse
// clock), we inject explicit ts values via `appendEvent(input, { now })`.
// They must stay within the 30-day FEEDBACK_SIGNAL_WINDOW_DAYS so feedback
// events still count as "current signal", so they are anchored near now().
// NEWER_MS > OLDER_MS guarantees the lexicographic ISO comparison in
// improve.ts (`fb > lp`) resolves the intended ordering deterministically.
const OLDER_MS = Date.now() - 60_000;
const NEWER_MS = Date.now() - 30_000;

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeMemory(stashDir: string, name: string, body: string, mtime?: Date): void {
  const filePath = path.join(stashDir, "memories", `${name}.md`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `---\ndescription: ${name}\n---\n\n${body}\n`, "utf8");
  if (mtime) fs.utimesSync(filePath, mtime, mtime);
}

async function buildIndex(stashDir: string): Promise<void> {
  mutateScopedEnv("AKM_BUNDLE_DIR", stashDir);
  saveConfig(
    withImproveAutonomy(
      withTestImproveLlm({
        semanticSearchMode: "off",
        bundles: { stash: { path: stashDir, writable: true } },
        defaultBundle: "stash",
        defaultWriteTarget: "stash",
      }),
    ),
  );
  await akmIndex({ stashDir, full: true });
}

function durableRef(ref: string): string {
  return `stash//${ref}`;
}

/** Seed an improve-ledger attempt on `ref` (keyed by its item_ref) at `atMs`. */
function recordAttempt(
  stashDir: string,
  ref: string,
  source: "reflect" | "distill" | "consolidate",
  outcome: ImproveLedgerOutcome,
  atMs: number = Date.now(),
  key: string = durableRef(ref),
): void {
  const db = openStateDatabase();
  try {
    recordImproveLedger(db, { stashDir, ref: key, source, outcome, at: new Date(atMs).toISOString() });
  } finally {
    db.close();
  }
}

// #553: these pool-delta / #551-gate tests use single-memory sandboxed pools.
// The default consolidate minPoolSize guard (500) would otherwise short-circuit
// the consolidation pass before the mtime-delta gate runs. Disable the pool-size
// guard (minPoolSize: 0) so these tests exercise the gate they pin, not the new
// guard. (A dedicated suite covers the minPoolSize guard itself.)
//
// proactiveMaintenance is ALSO disabled explicitly because these tests pin the
// signal-delta / high-salience SELECTION gates in isolation. The opt-in lane
// deliberately selects never-reflected refs regardless of signal. That separate
// behaviour is covered by proactive-maintenance-flow.test.ts; leaving it on here
// would mask the gate each test is asserting.
function configWithoutPoolGuard(stashDir: string): import("../../../../src/core/config/config").AkmConfig {
  return withImproveAutonomy(
    withTestImproveLlm({
      semanticSearchMode: "off",
      bundles: { stash: { path: stashDir, writable: true } },
      defaultBundle: "stash",
      defaultWriteTarget: "stash",
      improve: {
        strategies: {
          default: { processes: { consolidate: { minPoolSize: 0 }, proactiveMaintenance: { enabled: false } } },
        },
      },
    } as import("../../../../src/core/config/config").AkmConfig),
  );
}

const okReflect = (ref: string): AkmReflectResult => ({
  schemaVersion: 2,
  ok: true,
  proposal: {
    id: `p-${ref.replace(/[^a-z0-9]/gi, "-")}`,
    ref,
    status: "pending",
    source: "reflect",
    createdAt: "2026-05-26T00:00:00.000Z",
    updatedAt: "2026-05-26T00:00:00.000Z",
    payload: { content: "# proposal" },
    changes: [{ path: "lessons/proposal.md", after: "# proposal", op: "update" }],
    proposedTarget: { source: "stash", root: "/tmp/stash" },
  },
  ref,
  engine: "test",
  durationMs: 1,
});

const okDistill = (ref: string): AkmDistillResult => ({
  schemaVersion: 1,
  ok: true,
  outcome: "queued",
  inputRef: ref,
  proposalRef: `lessons/${ref.replaceAll("/", "-")}-lesson`,
});

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
});

afterEach(() => {
  storage.cleanup();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("skips a malformed indexed ref without discarding valid candidates", async () => {
  const stash = makeTempDir("akm-elig-malformed-ref-");
  writeMemory(stash, "valid", "Valid memory.");
  writeMemory(stash, "bad#fragment", "Malformed ref.");
  await buildIndex(stash);

  const result = await collectEligibleRefs({ mode: "all" }, stash, {});

  expect(result.plannedRefs.map((entry) => entry.ref)).toEqual(["memories/valid"]);
  expect(result.plannedRefs[0]?.filePath).toBe(path.join(stash, "memories", "valid.md"));
  expect(result.plannedRefs[0]?.itemRef).toBe("stash//memories/valid");
  expect(result.memorySummary).toEqual({ eligible: 1, derived: 0 });
  expect(result.strategyFilteredRefs).toEqual([]);
});

test("a read-only nested bundle is never eligible through its writable ancestor", async () => {
  const stash = makeTempDir("akm-elig-nested-owner-");
  const nested = path.join(stash, ".read-only-bundle");
  writeMemory(stash, "writable", "Writable memory.");
  writeMemory(nested, "readonly", "Read-only nested memory.");
  mutateScopedEnv("AKM_BUNDLE_DIR", stash);
  const config = withImproveAutonomy(
    withTestImproveLlm({
      semanticSearchMode: "off",
      bundles: {
        primary: { path: stash, writable: true },
        nested: { path: nested, writable: false },
      },
      defaultBundle: "primary",
      defaultWriteTarget: "primary",
    }),
  );
  saveConfig(config);
  await akmIndex({ stashDir: stash, full: true });

  const db = openExistingDatabase();
  try {
    expect(
      getAllEntries(db)
        .map((entry) => `${entry.bundleId}//${entry.conceptId}`)
        .sort(),
    ).toEqual(["nested//memories/readonly", "primary//memories/writable"]);
  } finally {
    closeDatabase(db);
  }

  const result = await collectEligibleRefs({ mode: "all" }, stash, {}, config);
  const pool = inspectConsolidationPool(
    {
      config,
      writeTarget: {
        selector: "primary",
        source: { kind: "filesystem", name: "primary", path: stash },
        config: { type: "filesystem", name: "primary", path: stash, writable: true },
      },
    },
    stash,
    [],
  );
  expect({
    plannedRefs: result.plannedRefs.map((entry) => entry.itemRef),
    memorySummary: result.memorySummary,
    consolidationPool: pool.memories.map((memory) => memory.name),
  }).toEqual({
    plannedRefs: ["primary//memories/writable"],
    memorySummary: { eligible: 1, derived: 0 },
    consolidationPool: ["writable"],
  });
});

test("live eligibility rejects an index without entries instead of receiving an incompatible handle", async () => {
  const stash = makeTempDir("akm-elig-empty-index-");
  writeMemory(stash, "valid", "Valid memory.");
  await buildIndex(stash);

  const db = openExistingDatabase();
  db.exec("DROP TABLE entries");
  closeDatabase(db);

  await expect(collectEligibleRefs({ mode: "all" }, stash, {})).rejects.toMatchObject({
    code: "INDEX_SCHEMA_INCOMPATIBLE",
  } satisfies Partial<ConfigError>);
});

// ── Reflect signal-delta ────────────────────────────────────────────────────

describe("durable eligibility keys", () => {
  test("uses exactly one durable key", () => {
    expect(improveStateReadRefs("memories/auth-tips", "team//memories/auth-tips")).toEqual([
      "team//memories/auth-tips",
    ]);
    expect(improveStateReadRefs("memories/auth-tips")).toEqual(["memories/auth-tips"]);
  });

  test("a durable feedback event correlates on the conceptId key", () => {
    appendEvent(
      { eventType: "feedback", ref: "memories/auth-tips", metadata: { signal: "positive" } },
      { now: () => NEWER_MS },
    );

    expect(buildLatestFeedbackTsMap(["memories/auth-tips"], new Date(0).toISOString())).toEqual(
      new Map([["memories/auth-tips", new Date(NEWER_MS).toISOString()]]),
    );
  });
});

describe("reflect signal-delta eligibility", () => {
  test("new feedback after last reflect proposal → eligible", async () => {
    const stash = makeTempDir("akm-elig-reflect-eligible-");
    writeMemory(stash, "auth-tips", "Use VPN.");
    await buildIndex(stash);

    // Older reflect attempt recorded in the ledger.
    recordAttempt(stash, "memories/auth-tips", "reflect", "unchanged", OLDER_MS);
    // Newer feedback event arrived after the reflect (injected ts strictly > reflect).
    appendEvent(
      {
        eventType: "feedback",
        ref: durableRef("memories/auth-tips"),
        metadata: { signal: "negative" },
      },
      { now: () => NEWER_MS },
    );

    const reflected: string[] = [];
    await akmImprove({
      scope: "memory",
      stashDir: stash,
      ensureIndexFn: async () => false,
      reindexFn: async () => ({ schemaVersion: 1, ok: true, indexed: 0, warnings: [], errors: [], durationMs: 0 }),
      reflectFn: async ({ ref }) => {
        if (ref) reflected.push(ref);
        return okReflect(ref ?? "");
      },
      distillFn: async ({ ref }) => okDistill(ref ?? ""),
    });

    expect(reflected).toContain("memories/auth-tips");
  });

  test("no new feedback since last reflect proposal → ineligible", async () => {
    const stash = makeTempDir("akm-elig-reflect-no-signal-");
    writeMemory(stash, "stale", "Old content.");
    await buildIndex(stash);

    // Old feedback event THEN a reflect attempt (the attempt is newer).
    appendEvent(
      {
        eventType: "feedback",
        ref: durableRef("memories/stale"),
        metadata: { signal: "negative" },
      },
      { now: () => OLDER_MS },
    );
    recordAttempt(stash, "memories/stale", "reflect", "unchanged", NEWER_MS);

    const reflected: string[] = [];
    await akmImprove({
      scope: "memory",
      stashDir: stash,
      ensureIndexFn: async () => false,
      reindexFn: async () => ({ schemaVersion: 1, ok: true, indexed: 0, warnings: [], errors: [], durationMs: 0 }),
      reflectFn: async ({ ref }) => {
        if (ref) reflected.push(ref);
        return okReflect(ref ?? "");
      },
      distillFn: async ({ ref }) => okDistill(ref ?? ""),
    });

    expect(reflected).not.toContain("memories/stale");
  });

  test("a rejection window holds the ref even after new feedback", async () => {
    const stash = makeTempDir("akm-elig-reflect-rejected-");
    writeMemory(stash, "refused", "Content a reviewer turned down.");
    await buildIndex(stash);
    recordAttempt(stash, "memories/refused", "reflect", "rejected", OLDER_MS);
    appendEvent(
      { eventType: "feedback", ref: durableRef("memories/refused"), metadata: { signal: "negative" } },
      { now: () => NEWER_MS },
    );

    const reflected: string[] = [];
    await akmImprove({
      scope: "memory",
      stashDir: stash,
      config: configWithoutPoolGuard(stash),
      ensureIndexFn: async () => false,
      reindexFn: async () => ({ schemaVersion: 1, ok: true, indexed: 0, warnings: [], errors: [], durationMs: 0 }),
      reflectFn: async ({ ref }) => {
        if (ref) reflected.push(ref);
        return okReflect(ref ?? "");
      },
      distillFn: async ({ ref }) => okDistill(ref ?? ""),
    });

    expect(reflected).not.toContain("memories/refused");
  });

  test("never-reflected ref with feedback signal → eligible", async () => {
    const stash = makeTempDir("akm-elig-reflect-first-time-");
    writeMemory(stash, "fresh", "Fresh content.");
    await buildIndex(stash);
    appendEvent({
      eventType: "feedback",
      ref: durableRef("memories/fresh"),
      metadata: { signal: "positive" },
    });

    const reflected: string[] = [];
    await akmImprove({
      scope: "memory",
      stashDir: stash,
      ensureIndexFn: async () => false,
      reindexFn: async () => ({ schemaVersion: 1, ok: true, indexed: 0, warnings: [], errors: [], durationMs: 0 }),
      reflectFn: async ({ ref }) => {
        if (ref) reflected.push(ref);
        return okReflect(ref ?? "");
      },
      distillFn: async ({ ref }) => okDistill(ref ?? ""),
    });

    expect(reflected).toContain("memories/fresh");
  });

  test("never-reflected ref without any signal → ineligible", async () => {
    const stash = makeTempDir("akm-elig-reflect-silent-");
    writeMemory(stash, "silent", "Silent content.");
    await buildIndex(stash);

    const reflected: string[] = [];
    await akmImprove({
      scope: "memory",
      stashDir: stash,
      config: configWithoutPoolGuard(stash), // isolate the signal-delta gate from proactive selection
      ensureIndexFn: async () => false,
      reindexFn: async () => ({ schemaVersion: 1, ok: true, indexed: 0, warnings: [], errors: [], durationMs: 0 }),
      reflectFn: async ({ ref }) => {
        if (ref) reflected.push(ref);
        return okReflect(ref ?? "");
      },
      distillFn: async ({ ref }) => okDistill(ref ?? ""),
    });

    expect(reflected).not.toContain("memories/silent");
  });
});

// ── Distill signal-delta ────────────────────────────────────────────────────

describe("distill signal-delta eligibility", () => {
  test("new feedback after last distill proposal → eligible", async () => {
    const stash = makeTempDir("akm-elig-distill-eligible-");
    writeMemory(stash, "auth-tips", "VPN required.");
    await buildIndex(stash);

    recordAttempt(stash, "memories/auth-tips", "distill", "proposed", OLDER_MS);
    appendEvent(
      {
        eventType: "feedback",
        ref: durableRef("memories/auth-tips"),
        metadata: { signal: "negative" },
      },
      { now: () => NEWER_MS },
    );

    const distilled: string[] = [];
    await akmImprove({
      scope: "memory",
      stashDir: stash,
      ensureIndexFn: async () => false,
      reindexFn: async () => ({ schemaVersion: 1, ok: true, indexed: 0, warnings: [], errors: [], durationMs: 0 }),
      reflectFn: async ({ ref }) => okReflect(ref ?? ""),
      distillFn: async ({ ref }) => {
        if (ref) distilled.push(ref);
        return okDistill(ref ?? "");
      },
    });

    expect(distilled).toContain("memories/auth-tips");
  });

  test("no new feedback since last distill proposal → ineligible (for distill)", async () => {
    const stash = makeTempDir("akm-elig-distill-stale-");
    writeMemory(stash, "old-memory", "Stable content.");
    await buildIndex(stash);

    appendEvent(
      {
        eventType: "feedback",
        ref: durableRef("memories/old-memory"),
        metadata: { signal: "negative" },
      },
      { now: () => OLDER_MS },
    );
    recordAttempt(stash, "memories/old-memory", "distill", "proposed", NEWER_MS);

    const distilled: string[] = [];
    await akmImprove({
      scope: "memory",
      stashDir: stash,
      ensureIndexFn: async () => false,
      reindexFn: async () => ({ schemaVersion: 1, ok: true, indexed: 0, warnings: [], errors: [], durationMs: 0 }),
      reflectFn: async ({ ref }) => okReflect(ref ?? ""),
      distillFn: async ({ ref }) => {
        if (ref) distilled.push(ref);
        return okDistill(ref ?? "");
      },
    });

    expect(distilled).not.toContain("memories/old-memory");
  });

  test("never-distilled memory with feedback signal → distill-eligible", async () => {
    const stash = makeTempDir("akm-elig-distill-first-");
    writeMemory(stash, "new-tip", "A new tip.");
    await buildIndex(stash);
    appendEvent({
      eventType: "feedback",
      ref: durableRef("memories/new-tip"),
      metadata: { signal: "positive" },
    });

    const distilled: string[] = [];
    await akmImprove({
      scope: "memory",
      stashDir: stash,
      ensureIndexFn: async () => false,
      reindexFn: async () => ({ schemaVersion: 1, ok: true, indexed: 0, warnings: [], errors: [], durationMs: 0 }),
      reflectFn: async ({ ref }) => okReflect(ref ?? ""),
      distillFn: async ({ ref }) => {
        if (ref) distilled.push(ref);
        return okDistill(ref ?? "");
      },
    });

    expect(distilled).toContain("memories/new-tip");
  });

  test("never-distilled memory without signal → ineligible", async () => {
    const stash = makeTempDir("akm-elig-distill-no-signal-");
    writeMemory(stash, "untouched", "Untouched memory.");
    await buildIndex(stash);

    const distilled: string[] = [];
    await akmImprove({
      scope: "memory",
      stashDir: stash,
      ensureIndexFn: async () => false,
      reindexFn: async () => ({ schemaVersion: 1, ok: true, indexed: 0, warnings: [], errors: [], durationMs: 0 }),
      reflectFn: async ({ ref }) => okReflect(ref ?? ""),
      distillFn: async ({ ref }) => {
        if (ref) distilled.push(ref);
        return okDistill(ref ?? "");
      },
    });

    expect(distilled).not.toContain("memories/untouched");
  });
});

// ── Consolidate: the improve ledger narrows the pool ────────────────────────

describe("consolidate ledger eligibility", () => {
  test("every memory judged recently and unchanged since → skipped (improve_skipped emitted)", async () => {
    const stash = makeTempDir("akm-elig-consolidate-skip-");
    writeMemory(stash, "old-mem", "Stable content.", new Date(Date.now() - 60_000));
    await buildIndex(stash);
    recordAttempt(stash, "memories/old-mem", "consolidate", "judged_no_action", Date.now(), "memories/old-mem");

    const result = await akmImprove({
      scope: "memory",
      config: configWithoutPoolGuard(stash),
      stashDir: stash,
      ensureIndexFn: async () => false,
      reindexFn: async () => ({ schemaVersion: 1, ok: true, indexed: 0, warnings: [], errors: [], durationMs: 0 }),
      reflectFn: async ({ ref }) => okReflect(ref ?? ""),
      distillFn: async ({ ref }) => okDistill(ref ?? ""),
    });

    expect(result.consolidation?.processed ?? 0).toBe(0);
    const skipped = readEvents({ type: "improve_skipped", ref: "memories/_consolidation" }).events;
    expect(skipped.some((e) => e.metadata?.reason === "consolidation_no_memory_updates")).toBe(true);
  });

  test("a memory edited after its judgement is back in the pool (no skip event)", async () => {
    const stash = makeTempDir("akm-elig-consolidate-runs-");
    recordAttempt(
      stash,
      "memories/fresh-mem",
      "consolidate",
      "judged_no_action",
      Date.now() - 60_000,
      "memories/fresh-mem",
    );
    writeMemory(stash, "fresh-mem", "Edited since the last judgement.", new Date(Date.now() + 5_000));
    await buildIndex(stash);

    await akmImprove({
      scope: "memory",
      config: configWithoutPoolGuard(stash),
      stashDir: stash,
      ensureIndexFn: async () => false,
      reindexFn: async () => ({ schemaVersion: 1, ok: true, indexed: 0, warnings: [], errors: [], durationMs: 0 }),
      reflectFn: async ({ ref }) => okReflect(ref ?? ""),
      distillFn: async ({ ref }) => okDistill(ref ?? ""),
    });

    const skipped = readEvents({ type: "improve_skipped", ref: "memories/_consolidation" }).events;
    expect(skipped.some((e) => e.metadata?.reason === "consolidation_no_memory_updates")).toBe(false);
  });

  // #551: consolidation runs BEFORE the session-extract phase. The
  // consolidation decision event (here, the ledger-delta skip) is emitted
  // strictly BEFORE `improve_invoked`, which is emitted AFTER the extract
  // phase inside the preparation stage. Events are returned in monotonic
  // insertion order (`ORDER BY id ASC`), so the index comparison is
  // deterministic.
  test("consolidation phase is emitted before the extract phase (event order)", async () => {
    const stash = makeTempDir("akm-551-order-");
    writeMemory(stash, "settled-mem", "Stable content.", new Date(Date.now() - 60_000));
    await buildIndex(stash);
    recordAttempt(stash, "memories/settled-mem", "consolidate", "judged_no_action", Date.now(), "memories/settled-mem");

    await akmImprove({
      scope: "memory",
      config: configWithoutPoolGuard(stash),
      stashDir: stash,
      ensureIndexFn: async () => false,
      reindexFn: async () => ({ schemaVersion: 1, ok: true, indexed: 0, warnings: [], errors: [], durationMs: 0 }),
      reflectFn: async ({ ref }) => okReflect(ref ?? ""),
      distillFn: async ({ ref }) => okDistill(ref ?? ""),
    });

    const all = readEvents({}).events;
    const consolidationIdx = all.findIndex(
      (e) =>
        e.eventType === "improve_skipped" &&
        e.ref === "memories/_consolidation" &&
        e.metadata?.reason === "consolidation_no_memory_updates",
    );
    const improveInvokedIdx = all.findIndex((e) => e.eventType === "improve_invoked");
    expect(consolidationIdx).toBeGreaterThanOrEqual(0);
    expect(improveInvokedIdx).toBeGreaterThanOrEqual(0);
    expect(consolidationIdx).toBeLessThan(improveInvokedIdx);
  });
});

// ── Layer 3: high-salience admission gate (#608) ──────────────────────────────

describe("high-salience admission gate (#608)", () => {
  // #644 follow-up: the high-salience lane requires a CONTENT-derived encoding
  // score (`encoding_source = 'content'`), not the per-type weight stub. Default
  // to "content" here so existing #608 cases model genuinely distilled assets
  // (the lane's real targets); the type-stub exclusion is asserted separately.
  function seedSalience(
    ref: string,
    encoding: number,
    encodingSource: "content" | "type-stub" | null = "content",
  ): void {
    const db = openStateDatabase();
    try {
      if (encodingSource === null) {
        // Rows without explicit content provenance must never enter the lane.
        db.prepare(
          `INSERT INTO asset_salience
             (asset_ref, encoding_salience, outcome_salience, retrieval_salience, rank_score, consecutive_no_ops, updated_at, encoding_source)
           VALUES (?, ?, 0, 0, 0.2, 0, ?, NULL)
           ON CONFLICT(asset_ref) DO UPDATE SET
             encoding_salience = excluded.encoding_salience,
             encoding_source = NULL,
             updated_at = excluded.updated_at`,
        ).run(ref, encoding, Date.now());
      } else {
        upsertAssetSalience(db, ref, {
          encoding,
          outcome: 0,
          retrieval: 0,
          rankScore: 0.2,
          encodingSource,
        });
      }
    } finally {
      db.close();
    }
  }

  test("zero-feedback ref with content encoding_salience ≥ threshold and no prior reflect → reflected", async () => {
    const stash = makeTempDir("akm-hs-rescue-");
    writeMemory(stash, "salient", "Newly distilled, never surfaced to a user.");
    await buildIndex(stash);
    // High CONTENT-derived encoding_salience, no retrieval, no feedback — only the
    // high-salience lane can rescue it (memory type-weight fallback is 0.5, below
    // threshold). This is #608's real target: a distilled, content-scored asset.
    seedSalience(durableRef("memories/salient"), 0.9, "content");

    const reflected: string[] = [];
    await akmImprove({
      scope: "memory",
      stashDir: stash,
      ensureIndexFn: async () => false,
      reindexFn: async () => ({ schemaVersion: 1, ok: true, indexed: 0, warnings: [], errors: [], durationMs: 0 }),
      reflectFn: async ({ ref }) => {
        if (ref) reflected.push(ref);
        return okReflect(ref ?? "");
      },
      distillFn: async ({ ref }) => okDistill(ref ?? ""),
    });

    expect(reflected).toContain("memories/salient");
  });

  test("high-salience fires at most once per asset (a prior reflect attempt blocks re-rescue)", async () => {
    const stash = makeTempDir("akm-hs-once-");
    writeMemory(stash, "salient", "High salience but already reflected once.");
    await buildIndex(stash);
    seedSalience(durableRef("memories/salient"), 0.9, "content");
    // A reflect attempt already exists for this ref (its revisit window has
    // elapsed). Without the once-per-asset rule the high-salience lane
    // re-selected it every run (auto-accept emits a `promoted` event, not
    // `feedback`, so it never leaves noFeedbackCandidates), burning LLM calls
    // and churning the asset. The rule must block re-rescue.
    recordAttempt(stash, "memories/salient", "reflect", "accepted", OLDER_MS);

    const reflected: string[] = [];
    await akmImprove({
      scope: "memory",
      stashDir: stash,
      ensureIndexFn: async () => false,
      reindexFn: async () => ({ schemaVersion: 1, ok: true, indexed: 0, warnings: [], errors: [], durationMs: 0 }),
      reflectFn: async ({ ref }) => {
        if (ref) reflected.push(ref);
        return okReflect(ref ?? "");
      },
      distillFn: async ({ ref }) => okDistill(ref ?? ""),
    });

    expect(reflected).not.toContain("memories/salient");
  });

  // The lane cap must take the TOP-N candidates BY SCORE, not the first N found
  // in scan order — previously a higher-salience candidate found later in the
  // scan lost its slot to an earlier lower-scoring one.
  test("cap selects the highest-scoring qualifier, not the first in scan order", async () => {
    const stash = makeTempDir("akm-hs-order-");
    // "aaa" sorts before "zzz" in scan order but carries the LOWER score.
    writeMemory(stash, "aaa", "Scan-order-first, lower salience.");
    writeMemory(stash, "zzz", "Scan-order-last, higher salience.");
    await buildIndex(stash);
    seedSalience(durableRef("memories/aaa"), 0.8, "content");
    seedSalience(durableRef("memories/zzz"), 0.95, "content");

    const reflected: string[] = [];
    await akmImprove({
      scope: "memory",
      stashDir: stash,
      config: configWithoutPoolGuard(stash), // isolate the high-salience gate from proactive selection
      limit: 10, // cap = floor(10 × 0.1) = 1 → exactly one high-salience slot
      ensureIndexFn: async () => false,
      reindexFn: async () => ({ schemaVersion: 1, ok: true, indexed: 0, warnings: [], errors: [], durationMs: 0 }),
      reflectFn: async ({ ref }) => {
        if (ref) reflected.push(ref);
        return okReflect(ref ?? "");
      },
      distillFn: async ({ ref }) => okDistill(ref ?? ""),
    });

    expect(reflected).toContain("memories/zzz");
    expect(reflected).not.toContain("memories/aaa");
  });

  // #644 follow-up — the lore-writer case. A type-stub row (encoding_salience set
  // to the per-type WEIGHT STUB, e.g. agent 0.9) must NOT be admitted: before this
  // fix "high-salience" degenerated into "is a skill/agent/command/lesson", and a
  // type-stub agent (lore-writer) was selected by the lane on every run. The gate
  // now requires content-derived provenance, so a `type-stub` row is excluded even
  // though its `encoding_salience` (0.9) is well above the 0.75 threshold.
  test("type-stub row (encoding_source='type-stub', 0.9) is NOT admitted — the lore-writer case", async () => {
    const stash = makeTempDir("akm-hs-typestub-");
    writeMemory(stash, "stub", "Type-stub asset; never content-scored.");
    await buildIndex(stash);
    // Explicit type-stub provenance: isContentEncodingRow returns false outright,
    // regardless of the value differing from the (memory) stub.
    seedSalience(durableRef("memories/stub"), 0.9, "type-stub");

    const reflected: string[] = [];
    await akmImprove({
      scope: "memory",
      stashDir: stash,
      config: configWithoutPoolGuard(stash), // isolate the high-salience gate from proactive selection
      ensureIndexFn: async () => false,
      reindexFn: async () => ({ schemaVersion: 1, ok: true, indexed: 0, warnings: [], errors: [], durationMs: 0 }),
      reflectFn: async ({ ref }) => {
        if (ref) reflected.push(ref);
        return okReflect(ref ?? "");
      },
      distillFn: async ({ ref }) => okDistill(ref ?? ""),
    });

    expect(reflected).not.toContain("memories/stub");
  });

  test("NULL-provenance rows are not admitted", async () => {
    const stash = makeTempDir("akm-hs-null-diff-");
    writeMemory(stash, "legacy", "Legacy row, value differs from stub.");
    await buildIndex(stash);
    seedSalience(durableRef("memories/legacy"), 0.9, null);

    const reflected: string[] = [];
    await akmImprove({
      scope: "memory",
      stashDir: stash,
      ensureIndexFn: async () => false,
      reindexFn: async () => ({ schemaVersion: 1, ok: true, indexed: 0, warnings: [], errors: [], durationMs: 0 }),
      reflectFn: async ({ ref }) => {
        if (ref) reflected.push(ref);
        return okReflect(ref ?? "");
      },
      distillFn: async ({ ref }) => okDistill(ref ?? ""),
    });

    expect(reflected).not.toContain("memories/legacy");
  });

  test("NULL provenance is never content regardless of score", () => {
    const equalsStub: AssetSalienceRow = {
      asset_ref: "lessons/atstub",
      encoding_salience: DEFAULT_TYPE_ENCODING_WEIGHTS.lesson ?? DEFAULT_ENCODING_SALIENCE,
      outcome_salience: 0,
      retrieval_salience: 0,
      rank_score: 0.2,
      consecutive_no_ops: 0,
      updated_at: Date.now(),
      encoding_source: null,
    };
    expect(isContentEncodingRow(equalsStub)).toBe(false);
    expect(isContentEncodingRow({ ...equalsStub, encoding_salience: 0.9 })).toBe(false);
  });
});

// ── Aggregated no_new_signal skip event ──────────────────────────────────────

describe("aggregated no_new_signal skip event", () => {
  test("stale-feedback refs emit a single counted improve_skipped, not one per ref", async () => {
    const stash = makeTempDir("akm-no-new-signal-");
    // Two refs with feedback on record but a NEWER reflect+distill attempt →
    // signal-delta gate rejects both for reflect AND distill (fully skipped).
    writeMemory(stash, "stale-a", "Stable A.");
    writeMemory(stash, "stale-b", "Stable B.");
    await buildIndex(stash);

    for (const name of ["stale-a", "stale-b"]) {
      const ref = durableRef(`memories/${name}`);
      appendEvent({ eventType: "feedback", ref, metadata: { signal: "negative" } }, { now: () => OLDER_MS });
      recordAttempt(stash, `memories/${name}`, "reflect", "unchanged", NEWER_MS);
      recordAttempt(stash, `memories/${name}`, "distill", "proposed", NEWER_MS);
    }

    await akmImprove({
      scope: "memory",
      stashDir: stash,
      ensureIndexFn: async () => false,
      reindexFn: async () => ({ schemaVersion: 1, ok: true, indexed: 0, warnings: [], errors: [], durationMs: 0 }),
      reflectFn: async ({ ref }) => okReflect(ref ?? ""),
      distillFn: async ({ ref }) => okDistill(ref ?? ""),
    });

    const noNewSignal = readEvents({ type: "improve_skipped" }).events.filter(
      (e) => e.metadata?.reason === "no_new_signal",
    );
    // Exactly ONE aggregated event (not one per ref), carrying the ref count.
    expect(noNewSignal.length).toBe(1);
    expect(noNewSignal[0]?.ref).toBeUndefined();
    expect(noNewSignal[0]?.metadata?.count).toBe(2);
  });
});

// ── Attribution: eligibilitySource lane tagging ──────────────────────────────
//
// Each eligibility lane must stamp the ref it selects with the correct
// `eligibilitySource` so the planner can thread it to reflect/distill and onto
// the persisted proposal. The improve harness mocks reflectFn/distillFn, so we
// capture the `eligibilitySource` option the planner passes per ref. The real
// reflect/distill event + proposal stamping is covered by reflect-propose.test
// and distill.test; proactive lane tagging is in proactive-maintenance-flow.test.

describe("attribution: eligibilitySource lane tagging", () => {
  test("signal-delta lane stamps eligibilitySource='signal-delta'", async () => {
    const stash = makeTempDir("akm-attr-signal-");
    writeMemory(stash, "rated", "Has fresh feedback.");
    await buildIndex(stash);
    recordAttempt(stash, "memories/rated", "reflect", "unchanged", OLDER_MS);
    appendEvent(
      { eventType: "feedback", ref: durableRef("memories/rated"), metadata: { signal: "negative" } },
      { now: () => NEWER_MS },
    );

    const seen = new Map<string, string | undefined>();
    await akmImprove({
      scope: "memory",
      stashDir: stash,
      ensureIndexFn: async () => false,
      reindexFn: async () => ({ schemaVersion: 1, ok: true, indexed: 0, warnings: [], errors: [], durationMs: 0 }),
      reflectFn: async ({ ref, eligibilitySource }) => {
        if (ref) seen.set(ref, eligibilitySource);
        return okReflect(ref ?? "");
      },
      distillFn: async ({ ref }) => okDistill(ref ?? ""),
    });

    expect(seen.get("memories/rated")).toBe("signal-delta");
  });

  test("explicit --scope <ref> bypass stamps eligibilitySource='scope'", async () => {
    const stash = makeTempDir("akm-attr-scope-");
    writeMemory(stash, "targeted", "Explicitly targeted, no feedback at all.");
    await buildIndex(stash);

    const seen = new Map<string, string | undefined>();
    await akmImprove({
      scope: "memories/targeted",
      stashDir: stash,
      ensureIndexFn: async () => false,
      reindexFn: async () => ({ schemaVersion: 1, ok: true, indexed: 0, warnings: [], errors: [], durationMs: 0 }),
      reflectFn: async ({ ref, eligibilitySource }) => {
        if (ref) seen.set(ref, eligibilitySource);
        return okReflect(ref ?? "");
      },
      distillFn: async ({ ref }) => okDistill(ref ?? ""),
    });

    expect(seen.get("memories/targeted")).toBe("scope");
  });
});

// Removed keys (cooldownByType, cooldownDays, feedbackDistillation) are
// rejected by the strict() default on the affected schema objects — no
// custom test coverage needed beyond zod's own.
