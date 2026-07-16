// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * R5 — collapse/churn detector
 * (docs/design/improve-collapse-churn-detector-design.md §8).
 *
 * Headline: a deterministic collapse simulation — seed a distinct-vocabulary
 * memory corpus, run synthetic merge passes against the stash files
 * (information-preserving first, then lossy/provenance-dropping), and assert
 * the detector's metrics + alerts track the collapse. Everything runs FTS-only
 * (`semanticSearchMode: "off"`) — the detector never needs an embedding model.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { ndcgAtK } from "../../../../scripts/akm-eval/src/rank-metrics";
import {
  type CollapseDetectorConfig,
  computeCycleMetrics,
  ensureCanarySet,
  evaluateCollapseAlerts,
  normHash,
  refreshCanarySet,
  runCollapseDetector,
} from "../../../../src/commands/improve/collapse-detector";
import { saveConfig } from "../../../../src/core/config/config";
import { openStateDatabase } from "../../../../src/core/state-db";
import { closeDatabase, openExistingDatabase } from "../../../../src/indexer/db/db";
import { akmIndex } from "../../../../src/indexer/indexer";
import type { Database as IndexDatabase, Database as StateDatabase } from "../../../../src/storage/database";
import {
  type CycleMetricsRow,
  insertCycleMetrics,
  queryRecentCycleMetrics,
} from "../../../../src/storage/repositories/canaries-repository";
import { withTestImproveLlm } from "../../../_helpers/improve-config";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../../../_helpers/sandbox";

let storage: IsolatedAkmStorage;
let stateDb: StateDatabase;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  saveConfig(
    withTestImproveLlm({
      semanticSearchMode: "off",
      sources: [{ type: "filesystem", path: storage.stashDir }],
      registries: [],
    }),
  );
  stateDb = openStateDatabase();
});

afterEach(() => {
  stateDb.close();
  storage.cleanup();
});

// ── Corpus helpers ────────────────────────────────────────────────────────────

/** 30 memories, each with a distinct topic vocabulary (no shared bigrams). */
const TOPICS = Array.from({ length: 30 }, (_, i) => ({
  name: `topic-${String(i).padStart(2, "0")}-notes`,
  words: Array.from({ length: 10 }, (_, w) => `w${i}x${w}word`),
}));

function writeMemory(name: string, body: string, frontmatter: Record<string, unknown> = {}): void {
  const dir = path.join(storage.stashDir, "memories");
  fs.mkdirSync(dir, { recursive: true });
  const fmLines = Object.entries({ description: `Notes about ${name}`, ...frontmatter }).map(([k, v]) =>
    Array.isArray(v) ? `${k}: [${v.join(", ")}]` : `${k}: ${v}`,
  );
  fs.writeFileSync(path.join(dir, `${name}.md`), `---\n${fmLines.join("\n")}\n---\n\n${body}\n`, "utf8");
}

function removeMemory(name: string): void {
  fs.rmSync(path.join(storage.stashDir, "memories", `${name}.md`), { force: true });
}

function seedCorpus(): void {
  for (const t of TOPICS) {
    writeMemory(t.name, `${t.words.join(" ")} in project practice.`);
  }
}

async function reindex(): Promise<void> {
  await akmIndex({ stashDir: storage.stashDir, full: true });
}

function withIndexDb<T>(fn: (db: IndexDatabase) => T): T {
  const db = openExistingDatabase();
  try {
    return fn(db);
  } finally {
    closeDatabase(db);
  }
}

const CFG: CollapseDetectorConfig = { windowCycles: 2 };

function snapshot(runId: string, acceptedActions = 0, mergeFloorViolations = 0): CycleMetricsRow {
  const row = withIndexDb((indexDb) =>
    computeCycleMetrics(stateDb, indexDb, {
      runId,
      pass: "consolidate",
      acceptedActions,
      mergeFloorViolations,
      cfg: CFG,
    }),
  );
  if (row === null) throw new Error("expected a measurable cycle (non-empty corpus)");
  return row;
}

function record(row: CycleMetricsRow, cfg: CollapseDetectorConfig = CFG) {
  const history = queryRecentCycleMetrics(stateDb, row.canary_set_id, cfg.windowCycles ?? 5);
  const alerts = evaluateCollapseAlerts(history, row, cfg);
  row.alerts_json = JSON.stringify(alerts.map((a) => a.kind));
  insertCycleMetrics(stateDb, row);
  return alerts;
}

// ── Canary minting ────────────────────────────────────────────────────────────

describe("ensureCanarySet", () => {
  test("mints a frozen set from the live index; second call returns the same set", async () => {
    seedCorpus();
    await reindex();
    const first = withIndexDb((db) => ensureCanarySet(stateDb, db, CFG));
    expect(first).not.toBeNull();
    if (!first) throw new Error("unreachable");
    expect(first.canaries.length).toBeGreaterThan(0);
    expect(first.canaries.length).toBeLessThanOrEqual(40);
    const second = withIndexDb((db) => ensureCanarySet(stateDb, db, CFG));
    if (!second) throw new Error("unreachable");
    expect(second.canarySetId).toBe(first.canarySetId);
    expect(second.canaries.map((c) => c.anchor_ref)).toEqual(first.canaries.map((c) => c.anchor_ref));
  });

  test("empty index → null (no set minted, no phantom set ids)", async () => {
    // Indexed but EMPTY stash: ensureCanarySet must refuse to mint rather
    // than creating a fresh unused set id every cycle (which would keep the
    // trend window permanently empty while recording fake recall-0 rows).
    await reindex();
    const result = withIndexDb((db) => ensureCanarySet(stateDb, db, CFG));
    expect(result).toBeNull();
    const count = stateDb.prepare("SELECT COUNT(*) AS n FROM canary_queries").get() as { n: number };
    expect(count.n).toBe(0);
  });

  test("cycle-0 mean recall on a healthy corpus is high (canary mechanism sanity)", async () => {
    seedCorpus();
    await reindex();
    const row = snapshot("cycle-0");
    // Every canary query is built from its own anchor's name/description —
    // FTS must find well-formed content on a healthy store.
    expect(row.mean_recall).toBeGreaterThanOrEqual(0.9);
    expect(row.distinct_content_ratio).toBeGreaterThanOrEqual(0.99);
    // Pin the canonical metrics path (shared with curate-golden via re-export).
    expect(ndcgAtK(["a"], new Set(["a"]), 10)).toBe(1);
  });
});

describe("refreshCanarySet", () => {
  test("mint-first: an empty index keeps the old baseline instead of destroying it", async () => {
    seedCorpus();
    await reindex();
    const first = withIndexDb((db) => ensureCanarySet(stateDb, db, CFG));
    if (!first) throw new Error("unreachable");

    // Wipe the stash and reindex → nothing mintable.
    for (const t of TOPICS) removeMemory(t.name);
    await reindex();
    const refreshed = withIndexDb((db) => refreshCanarySet(stateDb, db, CFG));
    expect(refreshed).toBeNull();
    // The old set is still the active baseline — refresh did NOT deactivate it.
    const active = withIndexDb((db) => ensureCanarySet(stateDb, db, CFG));
    expect(active?.canarySetId).toBe(first.canarySetId);
  });

  test("successful refresh mints a new set and deactivates ALL older active sets", async () => {
    seedCorpus();
    await reindex();
    const first = withIndexDb((db) => ensureCanarySet(stateDb, db, CFG));
    if (!first) throw new Error("unreachable");
    const refreshed = withIndexDb((db) => refreshCanarySet(stateDb, db, CFG));
    if (!refreshed) throw new Error("unreachable");
    expect(refreshed.canarySetId).not.toBe(first.canarySetId);
    const activeSetIds = new Set(
      (
        stateDb.prepare("SELECT DISTINCT canary_set_id FROM canary_queries WHERE active = 1").all() as Array<{
          canary_set_id: string;
        }>
      ).map((r) => r.canary_set_id),
    );
    expect([...activeSetIds]).toEqual([refreshed.canarySetId]);
  });
});

// ── The headline collapse simulation ─────────────────────────────────────────

describe("collapse simulation (synthetic merge passes)", () => {
  test("information-preserving merge survives; lossy merges trip a collapse alert by pass ≤ 4", async () => {
    seedCorpus();
    await reindex();

    // Cycle 0 + 1: healthy baseline (windowCycles=2 needs two history rows).
    const baseline0 = snapshot("cycle-0");
    expect(record(baseline0)).toHaveLength(0);
    const baseline1 = snapshot("cycle-1");
    expect(record(baseline1)).toHaveLength(0);
    const baselineRecall = baseline1.mean_recall;

    // ── Pass 1: FAITHFUL merges — topics 0-8 merge 3-into-1. FTS covers the
    // searchable surface (name/description/tags/TOC), not the raw body, so a
    // faithful merge keeps the member topics in its description + tags —
    // exactly what a real consolidate merge preserves — and xrefs carry
    // provenance for the merge-following hit rule.
    for (let g = 0; g < 3; g++) {
      const members = TOPICS.slice(g * 3, g * 3 + 3);
      for (const m of members) removeMemory(m.name);
      writeMemory(`merged-${g}`, members.map((m) => m.words.join(" ")).join(" "), {
        description: `Merged notes about ${members.map((m) => m.name).join(" ")}`,
        tags: members.map((m) => m.name),
        generation: 1,
        xrefs: members.map((m) => `memory:${m.name}`),
      });
    }
    await reindex();
    const pass1 = snapshot("cycle-2");
    // Merge-following: anchors for topics 0-8 are gone from the index but the
    // merged docs carry their vocabulary + canonical xrefs — recall survives.
    expect(pass1.mean_recall).toBeGreaterThanOrEqual(baselineRecall - 0.05);
    const pass1Alerts = record(pass1);
    expect(pass1Alerts.map((a) => a.kind)).not.toContain("collapse-recall");

    // ── Passes 2-4: LOSSY merges — replace everything in progressively larger
    // generic blobs with NO provenance and NO source vocabulary.
    const remaining = TOPICS.slice(9).map((t) => t.name);
    const genericBody = "general lesson about project workflows and best practices for teams";
    let cycle = 3;
    let collapsed = false;
    for (let pass = 2; pass <= 4 && !collapsed; pass++) {
      // Consume ~half the remaining originals + all prior generic blobs into
      // fewer, blander, near-identical files (provenance deliberately dropped).
      const consume = remaining.splice(0, Math.ceil(remaining.length / 2));
      for (const name of consume) removeMemory(name);
      for (let g = 0; g < 3; g++) {
        // Identical bland description across all generic docs — the converged
        // fingerprint a real collapse produces.
        writeMemory(`generic-${pass}-${g}`, genericBody, {
          description: "General lesson about project workflows and best practices",
          generation: pass,
        });
      }
      await reindex();
      const row = snapshot(`cycle-${cycle}`);
      const alerts = record(row);
      cycle++;
      if (alerts.some((a) => a.kind.startsWith("collapse"))) collapsed = true;
    }
    expect(collapsed).toBe(true);

    // The trend metrics moved the right way across the simulation.
    const finalRows = queryRecentCycleMetrics(stateDb, baseline0.canary_set_id, 10);
    const last = finalRows[finalRows.length - 1];
    expect(last.mean_recall).toBeLessThan(baselineRecall);
    expect(last.distinct_content_ratio).toBeLessThan(baseline1.distinct_content_ratio);
  });

  test("churn: paraphrase-only cycles with accepted volume fire churn and nothing else", async () => {
    seedCorpus();
    await reindex();

    // Baseline history (windowCycles=2), each cycle reporting accepted work.
    for (let i = 0; i < 2; i++) {
      record(snapshot(`cycle-${i}`, 20));
    }
    // Paraphrase: append one word to every body — store shape and canary hits
    // stay stable while "work" accumulates.
    for (const t of TOPICS) {
      writeMemory(t.name, `${t.words.join(" ")} in project practice. revised`);
    }
    await reindex();
    const row = snapshot("cycle-2", 20);
    const alerts = record(row);
    expect(alerts.map((a) => a.kind)).toEqual(["churn"]);
  });
});

// ── evaluateCollapseAlerts — pure table tests ─────────────────────────────────

function row(overrides: Partial<CycleMetricsRow>): CycleMetricsRow {
  return {
    run_id: "r",
    ts: "2026-07-02T00:00:00.000Z",
    pass: "consolidate",
    canary_set_id: "set",
    mean_recall: 0.9,
    mean_ndcg: 0.85,
    mean_mrr: 0.8,
    canary_ranks_json: "[]",
    store_total: 100,
    store_by_type_json: "{}",
    distinct_content_ratio: 0.95,
    mean_bigram_diversity: 0.9,
    over_generation_count: 0,
    accepted_actions: 0,
    merge_floor_violations: 0,
    alerts_json: "[]",
    ...overrides,
  };
}

describe("evaluateCollapseAlerts (pure)", () => {
  const cfg: CollapseDetectorConfig = { windowCycles: 3 };
  const healthy = [row({}), row({}), row({})];

  test("window shorter than windowCycles never alerts (except merge-floor)", () => {
    expect(evaluateCollapseAlerts([row({})], row({ mean_recall: 0 }), cfg)).toHaveLength(0);
    const floorOnly = evaluateCollapseAlerts([row({})], row({ mean_recall: 0, merge_floor_violations: 3 }), cfg);
    expect(floorOnly.map((a) => a.kind)).toEqual(["merge-floor"]);
    // Below the alert minimum (3): counted in the row, but no alert — one or
    // two borderline merges per cycle must not generate alert fatigue.
    expect(evaluateCollapseAlerts([row({})], row({ merge_floor_violations: 2 }), cfg)).toHaveLength(0);
  });

  test("recall drop vs window MEDIAN: just-below threshold quiet, at threshold fires", () => {
    // median recall = 0.9; threshold 0.15 → fires at ≤ 0.75.
    expect(evaluateCollapseAlerts(healthy, row({ mean_recall: 0.76 }), cfg)).toHaveLength(0);
    const fired = evaluateCollapseAlerts(healthy, row({ mean_recall: 0.75 }), cfg);
    expect(fired.map((a) => a.kind)).toEqual(["collapse-recall"]);
  });

  test("median-of-window is robust to a single noisy history cycle", () => {
    // One crazy-low history row does not drag the baseline down: median of
    // (0.9, 0.9, 0.1) is 0.9, so current 0.75 still fires.
    const noisy = [row({}), row({}), row({ mean_recall: 0.1 })];
    const fired = evaluateCollapseAlerts(noisy, row({ mean_recall: 0.75 }), cfg);
    expect(fired.map((a) => a.kind)).toEqual(["collapse-recall"]);
  });

  test("entropy decline must be BOTH monotonic and ≥ threshold", () => {
    const declining = [
      row({ distinct_content_ratio: 0.95 }),
      row({ distinct_content_ratio: 0.93 }),
      row({ distinct_content_ratio: 0.92 }),
    ];
    // Total decline 0.95 → 0.89 = 0.06 ≥ 0.05, monotonic → fires.
    const fired = evaluateCollapseAlerts(declining, row({ distinct_content_ratio: 0.89 }), cfg);
    expect(fired.map((a) => a.kind)).toEqual(["collapse-entropy"]);
    // Non-monotonic path (bounce upward mid-window) → quiet.
    const bouncy = [
      row({ distinct_content_ratio: 0.95 }),
      row({ distinct_content_ratio: 0.96 }),
      row({ distinct_content_ratio: 0.92 }),
    ];
    expect(evaluateCollapseAlerts(bouncy, row({ distinct_content_ratio: 0.89 }), cfg)).toHaveLength(0);
    // Monotonic but shallow (< 0.05 total) → quiet.
    const shallow = [
      row({ distinct_content_ratio: 0.95 }),
      row({ distinct_content_ratio: 0.94 }),
      row({ distinct_content_ratio: 0.93 }),
    ];
    expect(evaluateCollapseAlerts(shallow, row({ distinct_content_ratio: 0.92 }), cfg)).toHaveLength(0);
  });

  test("shrink alert needs BOTH >20% shrink AND rising over-generation", () => {
    const hist = [row({ store_total: 100 }), row({ store_total: 100 }), row({ store_total: 100 })];
    // Shrink without generation rise = deletion hygiene → quiet.
    expect(evaluateCollapseAlerts(hist, row({ store_total: 70 }), cfg)).toHaveLength(0);
    const fired = evaluateCollapseAlerts(hist, row({ store_total: 70, over_generation_count: 3 }), cfg);
    expect(fired.map((a) => a.kind)).toEqual(["collapse-shrink"]);
  });

  test("churn needs volume AND flat score AND flat entropy", () => {
    const busy = [row({ accepted_actions: 10 }), row({ accepted_actions: 10 }), row({ accepted_actions: 10 })];
    const fired = evaluateCollapseAlerts(busy, row({}), cfg);
    expect(fired.map((a) => a.kind)).toEqual(["churn"]);
    // Moving canary score (≥ 0.02 nDCG delta) → not churn.
    expect(evaluateCollapseAlerts(busy, row({ mean_ndcg: 0.88 }), cfg)).toHaveLength(0);
    // Insufficient volume → not churn.
    const quiet = [row({ accepted_actions: 5 }), row({ accepted_actions: 5 }), row({ accepted_actions: 5 })];
    expect(evaluateCollapseAlerts(quiet, row({}), cfg)).toHaveLength(0);
  });
});

describe("normHash", () => {
  test("whitespace/case-insensitive, content-sensitive", () => {
    expect(normHash("Alpha  Beta\nGamma")).toBe(normHash("alpha beta gamma"));
    expect(normHash("alpha beta gamma")).not.toBe(normHash("alpha beta delta"));
  });
});

// ── Orchestrator (runCollapseDetector) ────────────────────────────────────────

describe("runCollapseDetector orchestrator", () => {
  test("qualifying invocation persists exactly one cycle row and returns it", async () => {
    seedCorpus();
    await reindex();
    const result = runCollapseDetector({
      runId: "run-orchestrated",
      pass: "consolidate",
      acceptedActions: 2,
      mergeFloorViolations: 0,
      config: withTestImproveLlm({ semanticSearchMode: "off" }) as never,
    });
    expect(result).toBeDefined();
    expect(result?.run_id).toBe("run-orchestrated");
    const rows = queryRecentCycleMetrics(stateDb, result?.canary_set_id ?? "", 10);
    expect(rows).toHaveLength(1);
    expect(rows[0].accepted_actions).toBe(2);
  });

  test("enabled:false is a complete no-op (no canaries minted, no rows)", async () => {
    seedCorpus();
    await reindex();
    const result = runCollapseDetector({
      runId: "run-disabled",
      pass: "consolidate",
      acceptedActions: 0,
      mergeFloorViolations: 0,
      config: { semanticSearchMode: "off", improve: { collapseDetector: { enabled: false } } } as never,
    });
    expect(result).toBeUndefined();
    const count = stateDb.prepare("SELECT COUNT(*) AS n FROM canary_queries").get() as { n: number };
    expect(count.n).toBe(0);
  });

  test("fail-open: unreadable index path warns and returns undefined (never throws)", async () => {
    const result = runCollapseDetector({
      runId: "run-broken",
      pass: "consolidate",
      acceptedActions: 0,
      mergeFloorViolations: 0,
      config: withTestImproveLlm({ semanticSearchMode: "off" }) as never,
      indexDbPath: "/nonexistent/dir/index.db",
    });
    expect(result).toBeUndefined();
  });
});

// ── Improve-run wiring (hook gating, negative path) ──────────────────────────

describe("post-loop hook gating", () => {
  test("a run with no consolidate/recombine work writes no cycle rows", async () => {
    seedCorpus();
    await reindex();
    const { akmImprove } = await import("../../../../src/commands/improve/improve");
    await akmImprove({
      scope: "memory",
      stashDir: storage.stashDir,
      config: withTestImproveLlm({ semanticSearchMode: "off" }) as never,
      ensureIndexFn: async () => false,
      reindexFn: async () => ({ schemaVersion: 1, ok: true, indexed: 0, warnings: [], errors: [], durationMs: 0 }),
      reflectFn: async () => ({ schemaVersion: 1, ok: true, outcome: "skipped", ref: "", message: "stub" }) as never,
      distillFn: async () =>
        ({ schemaVersion: 1, ok: true, outcome: "skipped", inputRef: "", lessonRef: "", message: "stub" }) as never,
    });
    const count = stateDb.prepare("SELECT COUNT(*) AS n FROM improve_cycle_metrics").get() as { n: number };
    expect(count.n).toBe(0);
  });
});
