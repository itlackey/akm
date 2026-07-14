// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Golden capture: P0-A high-retrieval fallback selection sets (WI-02, plan
 * §5 ledger bullet 2 / R2). Chunk 0a brief §2.1, `anchors.md`
 * `preparation.ts:1270-1330` (threshold + gate), `:1555`/`:2039`
 * (`eligibilitySource='high-retrieval'` stamp), `:1094-1153` (`noFeedbackPool`
 * partition), `:1191-1362` (full lane context).
 *
 * P0-A rescues zero-feedback, never-reflected refs that have been retrieved
 * at least `minRetrievalCount` (default 5) times — `count > 0 && count >=
 * threshold && !lastReflectProposalTs.has(ref)` (`preparation.ts:1327-1330`).
 * This suite pins: the threshold boundary, the once-per-asset gate, and
 * (critically, brief §2.6 correction 1 / risk 1) that P0-A is NOT the only
 * lane rescuing never-rated assets — the default-ON proactive-maintenance
 * lane and the #608 high-salience lane also do, so Chunk 7's diff review
 * must attribute lane removals correctly rather than assuming every
 * never-rated-asset selection came from P0-A.
 *
 * IMPORTANT — the once-per-asset gate is EVENT-driven, not
 * proposal-record-driven (brief §2.6 correction / risk 2): the gate reads
 * `buildLatestProposalTsMap` (`eligibility.ts:382-410`), which sources
 * EXCLUSIVELY from `reflect_invoked` events in state.db (emitted at
 * `akmReflect` entry, `reflect.ts:953`). The `reflectFn` injected by this
 * harness is a recording stub that bypasses `akmReflect` entirely, so it
 * NEVER emits that event — a persisted proposal alone does not move the
 * cursor. The "once-per-asset" scenario below therefore emits the
 * `reflect_invoked` event explicitly between runs (mirroring what
 * `akmReflect` would do), per brief WI-02 step 3 and the existing pattern at
 * `tests/commands/improve/improve-eligibility.test.ts:754`.
 *
 * Designation: `re-baseline` @ Chunk 7 (`DESIGNATIONS.json`) — Chunk 7
 * deletes the P0-A lane; this fixture is the reviewed before-state.
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { AkmDistillResult } from "../../../src/commands/improve/distill";
import { akmImprove } from "../../../src/commands/improve/improve";
import type { AkmReflectResult } from "../../../src/commands/improve/reflect";
import { upsertAssetSalience } from "../../../src/commands/improve/salience";
import { saveConfig } from "../../../src/core/config/config";
import { appendEvent } from "../../../src/core/events";
import { getDbPath } from "../../../src/core/paths";
import { openStateDatabase } from "../../../src/core/state-db";
import { closeDatabase, openExistingDatabase } from "../../../src/indexer/db/db";
import { akmIndex } from "../../../src/indexer/indexer";
import { insertUsageEvent } from "../../../src/indexer/usage/usage-events";
import { expectGolden } from "../../_helpers/golden";
import { withTestImproveLlm } from "../../_helpers/improve-config";
import { withIsolatedAkmStorage } from "../../_helpers/sandbox";
import {
  memoryRef,
  P0A_ABOVE_THRESHOLD_NAME,
  P0A_ATTRIBUTION_FILLER_COUNT,
  P0A_ATTRIBUTION_FILLER_PREFIX,
  P0A_ATTRIBUTION_HIGH_RETRIEVAL_NAME,
  P0A_ATTRIBUTION_HIGH_SALIENCE_NAME,
  P0A_ATTRIBUTION_SIGNAL_DELTA_NAME,
  P0A_BELOW_THRESHOLD_NAME,
  P0A_ISOLATION_HIGH_RETRIEVAL_NAME,
  P0A_ISOLATION_PLAIN_NAME,
  P0A_ONCE_PER_ASSET_NAME,
} from "../../fixtures/goldens/improve/fixture-refs";

const GOLDEN_PATH = "tests/fixtures/goldens/improve/p0a-selection.json";
const HEAD_SHA = "3d9ee7b1917e8c4872f135fe9993d94b61b36ed1";
const RETRIEVAL_THRESHOLD = 5;

function writeMemory(stashDir: string, name: string, body: string): void {
  const filePath = path.join(stashDir, "memories", `${name}.md`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `---\ndescription: ${name}\n---\n\n${body}\n`, "utf8");
}

async function buildIndex(stashDir: string): Promise<void> {
  saveConfig(withTestImproveLlm({ semanticSearchMode: "off" }));
  await akmIndex({ stashDir, full: true });
}

/** Seed `count` `search` usage events so getRetrievalCounts sees `ref` as retrieved. Must run AFTER buildIndex(). */
function seedRetrievals(ref: string, count: number): void {
  const db = openExistingDatabase(getDbPath());
  try {
    for (let i = 0; i < count; i++) {
      insertUsageEvent(db, { event_type: "search", entry_ref: ref, query: "q", source: "user" });
    }
  } finally {
    closeDatabase(db);
  }
}

/** Seed a content-derived asset_salience row (#608 high-salience lane admission). */
function seedSalience(ref: string, encoding: number): void {
  const db = openStateDatabase();
  try {
    upsertAssetSalience(db, ref, { encoding, outcome: 0, retrieval: 0, rankScore: 0.2, encodingSource: "content" });
  } finally {
    db.close();
  }
}

/** Isolates the P0-A / signal-delta gates from the default-ON proactive-maintenance lane. Pattern: improve-eligibility.test.ts:93. */
function configWithoutPoolGuard(): import("../../../src/core/config/config").AkmConfig {
  return withTestImproveLlm({
    semanticSearchMode: "off",
    improve: {
      strategies: {
        default: { processes: { consolidate: { minPoolSize: 0 }, proactiveMaintenance: { enabled: false } } },
      },
    },
  } as import("../../../src/core/config/config").AkmConfig);
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
  lessonRef: `lesson:${ref.replace(/[:/]/g, "-")}-lesson`,
});

/** Run akmImprove, recording (ref -> eligibilitySource) for every reflectFn call. */
async function runAndRecord(
  stashDir: string,
  config: import("../../../src/core/config/config").AkmConfig,
): Promise<Map<string, string | undefined>> {
  const seen = new Map<string, string | undefined>();
  await akmImprove({
    scope: "memory",
    stashDir,
    config,
    minRetrievalCount: RETRIEVAL_THRESHOLD,
    ensureIndexFn: async () => false,
    reindexFn: async () => ({ schemaVersion: 1, ok: true, indexed: 0, warnings: [], errors: [], durationMs: 0 }),
    reflectFn: async ({ ref, eligibilitySource }) => {
      if (ref) seen.set(ref, eligibilitySource);
      return okReflect(ref ?? "");
    },
    distillFn: async ({ ref }) => okDistill(ref ?? ""),
  });
  return seen;
}

/** Above/below-threshold scenario: single ref, `count` seeded retrievals, isolated from other lanes. */
async function runThresholdCase(name: string, count: number): Promise<Map<string, string | undefined>> {
  const storage = withIsolatedAkmStorage();
  try {
    const ref = memoryRef(name);
    writeMemory(storage.stashDir, name, `Retrieval count ${count}, never rated.`);
    await buildIndex(storage.stashDir);
    seedRetrievals(ref, count);
    return await runAndRecord(storage.stashDir, configWithoutPoolGuard());
  } finally {
    storage.cleanup();
  }
}

/** Once-per-asset scenario: run 1 selects the ref; an explicit reflect_invoked cursor event is emitted; run 2 must not re-select it. */
async function runOncePerAssetCase(): Promise<{
  run1: Map<string, string | undefined>;
  run2: Map<string, string | undefined>;
}> {
  const storage = withIsolatedAkmStorage();
  try {
    const ref = memoryRef(P0A_ONCE_PER_ASSET_NAME);
    writeMemory(storage.stashDir, P0A_ONCE_PER_ASSET_NAME, "High retrieval, rescued once.");
    await buildIndex(storage.stashDir);
    seedRetrievals(ref, RETRIEVAL_THRESHOLD * 2);

    const run1 = await runAndRecord(storage.stashDir, configWithoutPoolGuard());

    // The stub bypasses akmReflect, so no reflect_invoked event was emitted by
    // run 1. Emit it explicitly (mirrors reflect.ts:953) so the gate's cursor
    // (buildLatestProposalTsMap, eligibility.ts:382-410) actually advances —
    // brief WI-02 step 3 / risk 2.
    appendEvent({ eventType: "reflect_invoked", ref, metadata: { eligibilitySource: "high-retrieval" } });

    const run2 = await runAndRecord(storage.stashDir, configWithoutPoolGuard());
    return { run1, run2 };
  } finally {
    storage.cleanup();
  }
}

/** Lane-isolation scenario (proactive OFF): one high-retrieval ref + one plain zero-signal ref. */
async function runLaneIsolationCase(): Promise<Map<string, string | undefined>> {
  const storage = withIsolatedAkmStorage();
  try {
    const hiRet = memoryRef(P0A_ISOLATION_HIGH_RETRIEVAL_NAME);
    writeMemory(storage.stashDir, P0A_ISOLATION_HIGH_RETRIEVAL_NAME, "Frequently retrieved.");
    writeMemory(storage.stashDir, P0A_ISOLATION_PLAIN_NAME, "Nothing special, never rated, never retrieved.");
    await buildIndex(storage.stashDir);
    seedRetrievals(hiRet, RETRIEVAL_THRESHOLD);
    return await runAndRecord(storage.stashDir, configWithoutPoolGuard());
  } finally {
    storage.cleanup();
  }
}

/**
 * Lane-attribution scenario (DEFAULT config, proactive ON): one ref per
 * reactive lane plus enough filler refs to saturate the default
 * `proactiveMaintenance.maxPerRun` (15) cap — see fixture-refs.ts doc comment
 * for why the high-salience ref's name sorts after the fillers.
 */
async function runLaneAttributionCase(): Promise<Map<string, string | undefined>> {
  const storage = withIsolatedAkmStorage();
  try {
    const signalRef = memoryRef(P0A_ATTRIBUTION_SIGNAL_DELTA_NAME);
    const hiRetRef = memoryRef(P0A_ATTRIBUTION_HIGH_RETRIEVAL_NAME);
    const hiSalRef = memoryRef(P0A_ATTRIBUTION_HIGH_SALIENCE_NAME);

    writeMemory(storage.stashDir, P0A_ATTRIBUTION_SIGNAL_DELTA_NAME, "Has fresh feedback.");
    writeMemory(storage.stashDir, P0A_ATTRIBUTION_HIGH_RETRIEVAL_NAME, "Frequently retrieved.");
    writeMemory(storage.stashDir, P0A_ATTRIBUTION_HIGH_SALIENCE_NAME, "Highly salient distilled content.");
    for (let i = 0; i < P0A_ATTRIBUTION_FILLER_COUNT; i++) {
      writeMemory(
        storage.stashDir,
        `${P0A_ATTRIBUTION_FILLER_PREFIX}${String(i).padStart(2, "0")}`,
        `Filler content ${i}.`,
      );
    }
    await buildIndex(storage.stashDir);

    appendEvent({ eventType: "feedback", ref: signalRef, metadata: { signal: "negative" } });
    seedRetrievals(hiRetRef, RETRIEVAL_THRESHOLD * 2);
    seedSalience(hiSalRef, 0.95);

    // DEFAULT config: no `config` override besides the LLM engine seam (so
    // reflect calls never attempt a real network request) — proactiveMaintenance
    // ships enabled:true in src/assets/improve-strategies/default.json.
    return await runAndRecord(storage.stashDir, withTestImproveLlm({ semanticSearchMode: "off" }));
  } finally {
    storage.cleanup();
  }
}

function countsBySourceOf(seen: Map<string, string | undefined>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const source of seen.values()) {
    const key = source ?? "unknown";
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

describe("goldens: P0-A high-retrieval selection sets (WI-02, R2)", () => {
  test("5 seeded retrievals (== threshold) -> selected, eligibilitySource:'high-retrieval'", async () => {
    const seen = await runThresholdCase(P0A_ABOVE_THRESHOLD_NAME, RETRIEVAL_THRESHOLD);
    expect(seen.get(memoryRef(P0A_ABOVE_THRESHOLD_NAME))).toBe("high-retrieval");
  });

  test("4 seeded retrievals (< threshold) -> not selected", async () => {
    const seen = await runThresholdCase(P0A_BELOW_THRESHOLD_NAME, RETRIEVAL_THRESHOLD - 1);
    expect(seen.has(memoryRef(P0A_BELOW_THRESHOLD_NAME))).toBe(false);
  });

  test("once-per-asset: explicit reflect_invoked cursor event between runs -> zero selections on run 2", async () => {
    const ref = memoryRef(P0A_ONCE_PER_ASSET_NAME);
    const { run1, run2 } = await runOncePerAssetCase();
    expect(run1.get(ref)).toBe("high-retrieval");
    expect(run2.has(ref)).toBe(false);
  });

  test("lane isolation (configWithoutPoolGuard, proactive OFF): selection set is P0-A-only", async () => {
    const seen = await runLaneIsolationCase();
    expect(seen.get(memoryRef(P0A_ISOLATION_HIGH_RETRIEVAL_NAME))).toBe("high-retrieval");
    expect(seen.has(memoryRef(P0A_ISOLATION_PLAIN_NAME))).toBe(false);
    expect([...seen.values()]).toEqual(["high-retrieval"]);
  });

  test("lane attribution (DEFAULT config, proactive ON): per-lane selection counts", async () => {
    const seen = await runLaneAttributionCase();

    expect(seen.get(memoryRef(P0A_ATTRIBUTION_SIGNAL_DELTA_NAME))).toBe("signal-delta");
    expect(seen.get(memoryRef(P0A_ATTRIBUTION_HIGH_RETRIEVAL_NAME))).toBe("high-retrieval");
    expect(seen.get(memoryRef(P0A_ATTRIBUTION_HIGH_SALIENCE_NAME))).toBe("high-salience");
    const fillerSources = new Set<string | undefined>();
    for (let i = 0; i < P0A_ATTRIBUTION_FILLER_COUNT; i++) {
      fillerSources.add(seen.get(memoryRef(`${P0A_ATTRIBUTION_FILLER_PREFIX}${String(i).padStart(2, "0")}`)));
    }
    expect(fillerSources).toEqual(new Set(["proactive"]));
    expect(countsBySourceOf(seen)).toEqual({
      "signal-delta": 1,
      "high-retrieval": 1,
      "high-salience": 1,
      proactive: P0A_ATTRIBUTION_FILLER_COUNT,
    });
  });

  // Re-runs every scenario above (fresh sandboxes) purely to assemble the
  // committed golden fixture — kept independent of the assertion tests above
  // so this capture never depends on bun:test's within-file execution order.
  test("golden fixture: serialize all P0-A selection scenarios", async () => {
    const aboveSeen = await runThresholdCase(P0A_ABOVE_THRESHOLD_NAME, RETRIEVAL_THRESHOLD);
    const belowSeen = await runThresholdCase(P0A_BELOW_THRESHOLD_NAME, RETRIEVAL_THRESHOLD - 1);
    const { run1: onceRun1, run2: onceRun2 } = await runOncePerAssetCase();
    const isolationSeen = await runLaneIsolationCase();
    const attrSeen = await runLaneAttributionCase();

    const aboveRef = memoryRef(P0A_ABOVE_THRESHOLD_NAME);
    const belowRef = memoryRef(P0A_BELOW_THRESHOLD_NAME);
    const onceRef = memoryRef(P0A_ONCE_PER_ASSET_NAME);
    const isoHiRet = memoryRef(P0A_ISOLATION_HIGH_RETRIEVAL_NAME);
    const isoPlain = memoryRef(P0A_ISOLATION_PLAIN_NAME);

    expectGolden(GOLDEN_PATH, {
      scenario: "improve P0-A high-retrieval fallback selection sets (WI-02, R2)",
      capturedAtHead: HEAD_SHA,
      threshold: RETRIEVAL_THRESHOLD,
      notes: [
        "The once-per-asset gate cursor (buildLatestProposalTsMap, eligibility.ts:382-410) is EVENT-driven " +
          "(reflect_invoked, reflect.ts:953), NOT proposal-record-driven -- a persisted reflect proposal without " +
          "the event does not block re-rescue. The reflectFn stub used to capture this fixture bypasses akmReflect " +
          "and therefore never emits that event on its own; the 'oncePerAsset' case emits it explicitly between " +
          "runs so the captured run-2 outcome reflects the gate's real cursor behavior, not an artifact of the " +
          "stub. Chunk 7's diff review needs this distinction to read the P0-A lane deletion correctly.",
        "P0-A is NOT the only lane rescuing never-rated assets at this HEAD (plan §5 ledger bullet 2 is stale): " +
          "the default-ON proactive-maintenance lane (src/assets/improve-strategies/default.json, " +
          "proactiveMaintenance.enabled=true, maxPerRun=15) and the #608 high-salience lane also do. The " +
          "'laneAttribution' case captures per-lane selection counts under DEFAULT config so lane removals in " +
          "Chunk 7 can be attributed correctly rather than assumed to all be P0-A.",
        "Designation: re-baseline @ Chunk 7 (DESIGNATIONS.json) -- Chunk 7 deletes the P0-A lane and this fixture " +
          "is the reviewed before-state the diff review verifies against.",
      ],
      cases: {
        aboveThreshold: {
          retrievals: RETRIEVAL_THRESHOLD,
          selected: aboveSeen.has(aboveRef),
          eligibilitySource: aboveSeen.get(aboveRef) ?? null,
        },
        belowThreshold: {
          retrievals: RETRIEVAL_THRESHOLD - 1,
          selected: belowSeen.has(belowRef),
        },
        oncePerAsset: {
          run1: { selected: onceRun1.has(onceRef), eligibilitySource: onceRun1.get(onceRef) ?? null },
          run2AfterExplicitCursorEvent: { selected: onceRun2.has(onceRef) },
        },
        laneIsolation: {
          config: "configWithoutPoolGuard (proactive OFF)",
          highRetrievalRefSelected: isolationSeen.has(isoHiRet),
          plainRefSelected: isolationSeen.has(isoPlain),
          totalSelections: isolationSeen.size,
        },
        laneAttribution: {
          config: "DEFAULT (proactiveMaintenance.enabled=true per default.json)",
          countsBySource: countsBySourceOf(attrSeen),
        },
      },
    });
  });
});
