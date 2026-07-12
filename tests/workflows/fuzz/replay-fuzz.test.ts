// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import { closeWorkflowDatabase, openWorkflowDatabase } from "../../../src/workflows/db";
import {
  executeStepPlan,
  type UnitDispatchRequest,
  type UnitDispatchResult,
} from "../../../src/workflows/exec/native-executor";
import { canonicalJson, computeStepWorkList, unitIdFor } from "../../../src/workflows/exec/step-work";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeWorkflowTestConfig } from "../../_helpers/sandbox";
import { freezeWorkflowProgram } from "../../_helpers/workflow";
import { distinctJsonValues, randomJsonValue, reorderKeys } from "./_gen";
import { fuzzSeeds, Rng, withSeed } from "./_rng";

/**
 * Seeded fuzz for content-derived unit identity + replay (redesign addendum,
 * R2). Fan-out over random item lists exercises the invariant that makes a
 * frozen plan safely resumable: identity is a pure function of item CONTENT.
 *
 * Pure properties (many seeds):
 *   - unit id is invariant under object-key REORDERING;
 *   - reordering the item LIST yields the same id SET;
 *   - canonically-distinct items never collide, across large samples;
 *   - duplicate canonical items fail the work-list BEFORE any dispatch.
 *
 * Executor-backed properties (small seeds, isolated sqlite per iteration):
 *   - a completed same-hash journal row is REUSED (zero re-dispatch);
 *   - a same-id row with a DIFFERENT input hash raises replay divergence — a
 *     hard step failure, even under `on_error: continue`;
 *   - duplicate items dispatch NOTHING (fake dispatcher call count 0).
 *
 * The deterministic goldens live in `native-executor.test.ts`; this widens the
 * item-shape coverage. The executor sample is intentionally small to keep the
 * whole `fuzz/` directory in the fast tier.
 */

const MAP_WF = `version: 2
name: f
params: { items: { type: array } }
steps:
  - id: work
    map:
      over: \${{ params.items }}
      unit:
        on_error: continue
        instructions: Do \${{ item }}.
`;

const PLAN = freezeWorkflowProgram(MAP_WF, "workflows/f.yaml");
const STEP = PLAN.steps[0];
const ENGINES = PLAN.execution?.engines;
const NODE_ID = "work.unit"; // STEP.root (map).template.id

// ── Pure identity properties ─────────────────────────────────────────────────

describe("replay fuzz — unit id invariant under object-key reordering", () => {
  const seeds = fuzzSeeds(250);
  test("a key-reordered item hashes to the same content-derived unit id", () => {
    for (const seed of seeds) {
      withSeed(seed, () => {
        const rng = new Rng(seed);
        const item = randomJsonValue(rng, 3);
        const reordered = reorderKeys(rng, item);
        // Same canonical content ⇒ same id, regardless of key insertion order.
        expect(canonicalJson(reordered)).toBe(canonicalJson(item));
        expect(unitIdFor(NODE_ID, reordered, true)).toBe(unitIdFor(NODE_ID, item, true));
      });
    }
    expect(seeds.length).toBeGreaterThan(0);
  });
});

describe("replay fuzz — item-list reorder yields the same id SET", () => {
  const seeds = fuzzSeeds(250);
  test("reshuffling the fan-out list produces the identical set of unit ids", () => {
    for (const seed of seeds) {
      withSeed(seed, () => {
        const rng = new Rng(seed);
        const items = distinctJsonValues(rng, rng.range(1, 8));
        const shuffled = rng.shuffle(items);

        const original = computeStepWorkList(STEP, { runId: "r", params: { items }, stepOutputs: {} });
        const reordered = computeStepWorkList(STEP, { runId: "r", params: { items: shuffled }, stepOutputs: {} });
        expect(original.ok).toBe(true);
        expect(reordered.ok).toBe(true);
        if (!original.ok || !reordered.ok) return;

        const idsA = new Set(original.list.units.map((u) => u.unitId));
        const idsB = new Set(reordered.list.units.map((u) => u.unitId));
        expect([...idsA].sort()).toEqual([...idsB].sort());
        expect(idsA.size).toBe(items.length); // one id per distinct item
      });
    }
    expect(seeds.length).toBeGreaterThan(0);
  });
});

describe("replay fuzz — distinct items never collide", () => {
  const seeds = fuzzSeeds(150);
  test("a large sample of canonically-distinct items yields all-distinct unit ids", () => {
    for (const seed of seeds) {
      withSeed(seed, () => {
        const rng = new Rng(seed);
        const items = distinctJsonValues(rng, rng.range(10, 40));
        const ids = items.map((item) => unitIdFor(NODE_ID, item, true));
        expect(new Set(ids).size).toBe(items.length);
      });
    }
    expect(seeds.length).toBeGreaterThan(0);
  });
});

describe("replay fuzz — duplicate canonical items fail before dispatch", () => {
  const seeds = fuzzSeeds(200);
  test("a list with a duplicate fails the work-list, naming the collision", () => {
    for (const seed of seeds) {
      withSeed(seed, () => {
        const rng = new Rng(seed);
        const base = distinctJsonValues(rng, rng.range(1, 6));
        // Insert a canonical duplicate of an existing item at a random spot.
        const dupSource = rng.pick(base);
        const dup = reorderKeys(rng, dupSource); // canonically equal, maybe key-shuffled
        const withDup = [...base];
        withDup.splice(rng.int(withDup.length + 1), 0, dup);

        const result = computeStepWorkList(STEP, { runId: "r", params: { items: withDup }, stepOutputs: {} });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).toContain("duplicate items");
      });
    }
    expect(seeds.length).toBeGreaterThan(0);
  });
});

// ── Executor-backed properties (isolated sqlite per iteration) ────────────────

/** Seed a run + one pending step so the executor's journal has FK targets. */
function seedRun(runId: string, params: Record<string, unknown>): void {
  const db = openWorkflowDatabase();
  try {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO workflow_runs
         (id, workflow_ref, scope_key, workflow_entry_id, workflow_title, status,
          params_json, current_step_id, created_at, updated_at)
       VALUES (?, 'workflow:f', 'dir:v1:f', NULL, 'F', 'active', ?, 'work', ?, ?)`,
    ).run(runId, JSON.stringify(params), now, now);
    db.prepare(
      `INSERT INTO workflow_run_steps
         (run_id, step_id, step_title, instructions, completion_json, sequence_index, status)
       VALUES (?, 'work', 'Work', 'instructions', NULL, 0, 'pending')`,
    ).run(runId);
  } finally {
    closeWorkflowDatabase(db);
  }
}

/** Distinct scalar items so `${{ item }}` always resolves (dispatch == count). */
function distinctScalars(rng: Rng, count: number): unknown[] {
  const seen = new Set<string>();
  const out: unknown[] = [];
  let guard = 0;
  while (out.length < count && guard++ < count * 20) {
    const value: unknown = rng.bool() ? `s-${rng.int(1_000_000)}` : rng.range(-1_000_000, 1_000_000);
    const key = canonicalJson(value) ?? "null";
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  if (out.length === 0) out.push(`s-${rng.int(1_000_000)}`);
  return out;
}

describe("replay fuzz — executor reuse, divergence, and dup-before-dispatch", () => {
  const seeds = fuzzSeeds(8);
  // Each seed runs several async executeStepPlan passes against isolated
  // storage, so the wall-clock cost scales with the seed count. Give the
  // heavy test a timeout that grows with `AKM_FUZZ_SEEDS` deep runs; the
  // default 8-seed fast tier stays well under the 5s floor.
  const heavyTimeoutMs = Math.max(5_000, seeds.length * 300);
  test(
    "same-hash rows reuse (0 re-dispatch), tampered hash diverges, dups dispatch nothing",
    async () => {
      for (const seed of seeds) {
        let storage: IsolatedAkmStorage | undefined;
        try {
          storage = withIsolatedAkmStorage();
          writeWorkflowTestConfig();
          await withSeedAsync(seed, async () => {
            const rng = new Rng(seed);
            const items = distinctScalars(rng, rng.range(1, 4));
            const runId = `run-reuse-${seed}`;
            seedRun(runId, { items });

            let dispatches = 0;
            const dispatcher = async (req: UnitDispatchRequest): Promise<UnitDispatchResult> => {
              dispatches++;
              return { ok: true, text: `did ${req.unitId}` };
            };

            // 1) First execution dispatches exactly one unit per item.
            const first = await executeStepPlan(STEP, {
              runId,
              workflowRef: "workflow:f",
              params: { items },
              evidence: {},
              dispatcher,
              engines: ENGINES,
            });
            expect(first.ok).toBe(true);
            expect(dispatches).toBe(items.length);

            // 2) Re-execution with identical inputs reuses every journaled row.
            const second = await executeStepPlan(STEP, {
              runId,
              workflowRef: "workflow:f",
              params: { items },
              evidence: {},
              dispatcher: async () => {
                dispatches++;
                return { ok: true, text: "must-not-run" };
              },
              engines: ENGINES,
            });
            expect(second.ok).toBe(true);
            expect(dispatches).toBe(items.length); // zero re-dispatch

            // 3) Same items, tampered params ⇒ same ids / different hash ⇒ hard
            //    replay divergence, even though the unit is on_error: continue.
            const diverged = await executeStepPlan(STEP, {
              runId,
              workflowRef: "workflow:f",
              params: { items, tamper: `v-${seed}` },
              evidence: {},
              dispatcher,
              engines: ENGINES,
            });
            expect(diverged.ok).toBe(false);
            expect(diverged.summary).toContain("replay divergence");
            expect(dispatches).toBe(items.length); // still no re-dispatch
          });

          // 4) Duplicate items dispatch nothing at all (separate run).
          await withSeedAsync(seed, async () => {
            const rng = new Rng(seed * 7 + 1);
            const scalars = distinctScalars(rng, rng.range(1, 3));
            const withDup = [...scalars, scalars[0]];
            const dupRunId = `run-dup-${seed}`;
            seedRun(dupRunId, { items: withDup });
            let dupDispatches = 0;
            const dupResult = await executeStepPlan(STEP, {
              runId: dupRunId,
              workflowRef: "workflow:f",
              params: { items: withDup },
              evidence: {},
              dispatcher: async () => {
                dupDispatches++;
                return { ok: true, text: "must-not-run" };
              },
              engines: ENGINES,
            });
            expect(dupResult.ok).toBe(false);
            expect(dupDispatches).toBe(0);
            expect(dupResult.summary).toContain("duplicate items");
          });
        } finally {
          storage?.cleanup();
        }
      }
      expect(seeds.length).toBeGreaterThan(0);
    },
    heavyTimeoutMs,
  );
});

/** Async twin of `withSeed` — tags any rejection with its seed. */
async function withSeedAsync<T>(seed: number, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`[seed=${seed}] ${message}`);
  }
}
