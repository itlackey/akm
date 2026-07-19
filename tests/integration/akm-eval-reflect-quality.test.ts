/**
 * Tests for the akm-eval `reflect-quality` runner — the case that
 * replaces the hand-rolled jq classification over improve-result.json.
 *
 * Covers:
 *   - schema-shape detection (missing required string field / JSON
 *     Parse error / Unterminated string).
 *   - content-policy detection (Reflect rejected: EXCESSIVE_*).
 *   - gate-refused detection (Reflect refused:).
 *   - the LLM-touched denominator excludes gate-refused.
 *   - schemaShapeRate computes against the LLM-touched denominator.
 *   - threshold-skip when sample < requires.minLlmTouchedReflects.
 *   - end-to-end runner against fixture improve-result.json files
 *     under a tmpdir-staged stash.
 */

import { Database } from "bun:sqlite";
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  aggregateReflectActions,
  type ClassifiedReflectAction,
  classifyReflectAction,
  collectReflectActions,
  type ReflectActionInput,
  runReflectQualityCase,
} from "../../scripts/akm-eval/src/runners/reflect-quality";
import type { EvalCase, EvalContext } from "../../scripts/akm-eval/src/types";

const createdTmpDirs: string[] = [];
const ORIGINAL_AKM_DATA_DIR = process.env.AKM_DATA_DIR;

afterAll(() => {
  for (const dir of createdTmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  if (ORIGINAL_AKM_DATA_DIR === undefined) {
    delete process.env.AKM_DATA_DIR;
  } else {
    process.env.AKM_DATA_DIR = ORIGINAL_AKM_DATA_DIR;
  }
});

afterEach(() => {
  if (ORIGINAL_AKM_DATA_DIR === undefined) {
    delete process.env.AKM_DATA_DIR;
  } else {
    process.env.AKM_DATA_DIR = ORIGINAL_AKM_DATA_DIR;
  }
});

/**
 * Initialize a fresh state.db with the `improve_runs` schema in the given
 * data dir. The runner reads from this database via `AKM_DATA_DIR`.
 */
function initStateDb(dataDir: string): void {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new Database(path.join(dataDir, "state.db"));
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS improve_runs (
        id            TEXT    PRIMARY KEY,
        started_at    TEXT    NOT NULL,
        completed_at  TEXT,
        stash_dir     TEXT    NOT NULL,
        dry_run       INTEGER NOT NULL DEFAULT 0,
        profile       TEXT,
        strategy      TEXT,
        scope_mode    TEXT    NOT NULL,
        scope_value   TEXT,
        guidance      TEXT,
        ok            INTEGER NOT NULL,
        result_json   TEXT    NOT NULL,
        metrics_json  TEXT,
        metadata_json TEXT    NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS idx_improve_runs_started ON improve_runs(started_at);
      CREATE INDEX IF NOT EXISTS idx_improve_runs_dry_run ON improve_runs(dry_run);
      CREATE INDEX IF NOT EXISTS idx_improve_runs_stash_scope ON improve_runs(stash_dir, scope_mode);
    `);
  } finally {
    db.close();
  }
}

/**
 * Create a temp stash with its own state.db, and point AKM_DATA_DIR at it
 * so the runner's source loader resolves to this stash's database.
 */
function makeTmpStash(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-eval-reflect-"));
  createdTmpDirs.push(dir);
  fs.mkdirSync(path.join(dir, ".akm", "runs"), { recursive: true });
  const dataDir = path.join(dir, ".akm", "data");
  initStateDb(dataDir);
  process.env.AKM_DATA_DIR = dataDir;
  return dir;
}

/**
 * Derive a started_at timestamp from the runId so chronological ordering
 * by `started_at` matches the lexicographic ordering of ISO-prefixed ids
 * the legacy filesystem layout used.
 */
function startedAtFromRunId(runId: string): string {
  // Run ids look like "2026-05-21T10-00-00-000Z-abc"; turn the leading
  // dash-encoded ISO stamp back into a proper ISO-8601 string when
  // possible, otherwise fall back to a derived monotonic stamp keyed on
  // the id so sort-by-started_at remains stable across inserts.
  const m = runId.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/);
  if (m) return `${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`;
  return new Date().toISOString();
}

/**
 * Insert an improve-run row into the state.db indicated by AKM_DATA_DIR.
 * Replaces the legacy `<stash>/.akm/runs/<id>/improve-result.json` write.
 */
function writeImproveRun(stashRoot: string, runId: string, actions: ReflectActionInput[]): void {
  const dataDir = process.env.AKM_DATA_DIR;
  if (!dataDir) throw new Error("writeImproveRun: AKM_DATA_DIR not set (call makeTmpStash first)");
  const envelope = {
    schemaVersion: 2,
    ok: true,
    strategy: "default",
    scope: { mode: "all" },
    dryRun: false,
    memorySummary: { eligible: 0, derived: 0 },
    plannedRefs: [],
    actions,
  };
  const db = new Database(path.join(dataDir, "state.db"));
  try {
    db.prepare(
      `INSERT INTO improve_runs
         (id, started_at, completed_at, stash_dir, dry_run, profile, strategy,
           scope_mode, scope_value, guidance, ok, result_json, metrics_json, metadata_json)
       VALUES (?, ?, NULL, ?, 0, NULL, 'default', 'all', NULL, NULL, 1, ?, NULL, '{}')`,
    ).run(runId, startedAtFromRunId(runId), stashRoot, JSON.stringify(envelope));
  } finally {
    db.close();
  }
}

function makeCtx(stashRoot: string): EvalContext {
  return {
    stashRoot,
    dataDir: path.join(stashRoot, ".akm", "data"),
    akmBin: "akm",
    casesRoot: path.join(stashRoot, "cases"),
    outRoot: path.join(stashRoot, "out"),
    keepSandbox: false,
    env: {},
  };
}

function makeCase(overrides: Partial<EvalCase> = {}): EvalCase {
  return {
    schemaVersion: 1,
    id: "test-reflect-failure-breakdown",
    suite: "improve-smoke",
    type: "reflect-quality",
    description: "test case",
    input: { windowRuns: 100 },
    expected: {},
    ...overrides,
  };
}

describe("classifyReflectAction", () => {
  test("classifies mode='reflect' as succeeded", () => {
    const result = classifyReflectAction({ mode: "reflect", ref: "memories/foo" }, "run-1");
    expect(result).not.toBeNull();
    expect(result?.classification).toBe("succeeded");
  });

  test("classifies missing-required-string-field as schemaShape", () => {
    const result = classifyReflectAction(
      {
        mode: "reflect-failed",
        ref: "memories/foo",
        result: { error: 'agent response missing required string field "ref"' },
      },
      "run-1",
    );
    expect(result?.classification).toBe("schemaShape");
  });

  test("classifies JSON Parse error as schemaShape", () => {
    const result = classifyReflectAction(
      {
        mode: "reflect-failed",
        ref: "memories/foo",
        result: { error: "JSON Parse error: Unterminated string" },
      },
      "run-1",
    );
    expect(result?.classification).toBe("schemaShape");
  });

  test("classifies Unterminated string as schemaShape", () => {
    const result = classifyReflectAction(
      {
        mode: "reflect-failed",
        ref: "memories/foo",
        result: { error: "Unterminated string somewhere in body" },
      },
      "run-1",
    );
    expect(result?.classification).toBe("schemaShape");
  });

  test("classifies EXCESSIVE_EXPANSION as contentPolicy", () => {
    const result = classifyReflectAction(
      {
        mode: "reflect-failed",
        ref: "memories/foo",
        result: {
          error:
            "Reflect rejected: EXCESSIVE_EXPANSION — proposed body is 481% of source (maximum 200%) for ref memory:foo. Speculative material was likely added.",
        },
      },
      "run-1",
    );
    expect(result?.classification).toBe("contentPolicy");
  });

  test("classifies EXCESSIVE_SHRINKAGE as contentPolicy", () => {
    const result = classifyReflectAction(
      {
        mode: "reflect-failed",
        ref: "memories/foo",
        result: {
          error:
            "Reflect rejected: EXCESSIVE_SHRINKAGE — proposed body is 13% of source (minimum 50%) for ref memory:foo. Concrete content was likely deleted.",
        },
      },
      "run-1",
    );
    expect(result?.classification).toBe("contentPolicy");
  });

  test("classifies Reflect refused asset type as gateRefused", () => {
    const result = classifyReflectAction(
      {
        mode: "reflect-failed",
        ref: "scripts/google/get-token.ts",
        result: {
          error:
            'Reflect refused: asset type "script" is not supported by reflect (only markdown-canonical types are allowed: agent, command, knowledge, lesson, memory, skill, workflow). Use `akm propose` or edit the file directly.',
        },
      },
      "run-1",
    );
    expect(result?.classification).toBe("gateRefused");
  });

  test("classifies unrecognised reflect-failed reasons as 'other'", () => {
    const result = classifyReflectAction(
      {
        mode: "reflect-failed",
        ref: "memories/foo",
        result: { error: "Agent retargeted proposal: expected ref X but got Y..." },
      },
      "run-1",
    );
    expect(result?.classification).toBe("other");
  });

  test("returns null for non-reflect modes (e.g. distill)", () => {
    const result = classifyReflectAction({ mode: "distill", ref: "memories/foo" }, "run-1");
    expect(result).toBeNull();
  });

  test("treats missing error as not-schemaShape on reflect-failed", () => {
    // When mode is reflect-failed but no error string is present, we fall
    // through to "other" — neither succeeded nor any specific classifier.
    const result = classifyReflectAction({ mode: "reflect-failed", ref: "memories/foo" }, "run-1");
    expect(result?.classification).toBe("other");
  });
});

describe("aggregateReflectActions", () => {
  function classify(actions: ReflectActionInput[], runId = "run-1"): ClassifiedReflectAction[] {
    return actions.map((a) => classifyReflectAction(a, runId)).filter((x): x is ClassifiedReflectAction => x !== null);
  }

  test("LLM-touched denominator excludes gate-refused", () => {
    // 2 succeeded + 1 schemaShape + 1 contentPolicy + 1 gateRefused
    // → llmTouched = 4 (gateRefused excluded)
    const classified = classify([
      { mode: "reflect", ref: "a" },
      { mode: "reflect", ref: "b" },
      { mode: "reflect-failed", ref: "c", result: { error: 'agent response missing required string field "ref"' } },
      {
        mode: "reflect-failed",
        ref: "d",
        result: { error: "Reflect rejected: EXCESSIVE_EXPANSION — too long" },
      },
      {
        mode: "reflect-failed",
        ref: "scripts/e",
        result: { error: 'Reflect refused: asset type "script" is not supported' },
      },
    ]);
    const agg = aggregateReflectActions(classified);
    expect(agg.counts.succeeded).toBe(2);
    expect(agg.counts.schemaShape).toBe(1);
    expect(agg.counts.contentPolicy).toBe(1);
    expect(agg.counts.gateRefused).toBe(1);
    expect(agg.counts.other).toBe(0);
    expect(agg.counts.totalReflectActions).toBe(5);
    expect(agg.counts.llmTouched).toBe(4); // gateRefused excluded
    expect(agg.schemaShapeRate).toBeCloseTo(0.25, 9); // 1 / 4
    expect(agg.contentPolicyRate).toBeCloseTo(0.25, 9);
    expect(agg.successRate).toBeCloseTo(0.5, 9);
  });

  test("includes 'other' in the LLM-touched denominator", () => {
    // Unrecognised reflect-failed reasons still represent LLM round-trips
    // that completed but produced unusable output → count toward
    // llmTouched. Only gateRefused is a pre-validation rejection.
    const classified = classify([
      { mode: "reflect", ref: "a" },
      { mode: "reflect-failed", ref: "b", result: { error: "Agent retargeted proposal" } },
    ]);
    const agg = aggregateReflectActions(classified);
    expect(agg.counts.other).toBe(1);
    expect(agg.counts.llmTouched).toBe(2); // succeeded + other
    expect(agg.schemaShapeRate).toBe(0);
  });

  test("returns null rates when llmTouched is 0 (only gate-refused)", () => {
    const classified = classify([
      {
        mode: "reflect-failed",
        ref: "scripts/e",
        result: { error: 'Reflect refused: asset type "script" is not supported' },
      },
    ]);
    const agg = aggregateReflectActions(classified);
    expect(agg.counts.llmTouched).toBe(0);
    expect(agg.schemaShapeRate).toBeNull();
    expect(agg.contentPolicyRate).toBeNull();
    expect(agg.successRate).toBeNull();
  });

  test("caps the per-class evidence samples at 3", () => {
    const many: ReflectActionInput[] = [];
    for (let i = 0; i < 5; i++) {
      many.push({
        mode: "reflect-failed",
        ref: `memories/foo-${i}`,
        result: { error: 'agent response missing required string field "ref"' },
      });
    }
    const classified = classify(many);
    const agg = aggregateReflectActions(classified);
    expect(agg.counts.schemaShape).toBe(5);
    expect(agg.samples.schemaShape.length).toBe(3);
  });
});

describe("collectReflectActions (end-to-end fixture)", () => {
  test("reads multiple improve-result.json files and classifies them", () => {
    const stash = makeTmpStash();
    writeImproveRun(stash, "2026-05-21T10-00-00-000Z-aaa", [
      { mode: "reflect", ref: "memories/a" },
      {
        mode: "reflect-failed",
        ref: "memories/b",
        result: { error: 'agent response missing required string field "ref"' },
      },
      { mode: "distill", ref: "memories/c" },
    ]);
    writeImproveRun(stash, "2026-05-21T11-00-00-000Z-bbb", [
      {
        mode: "reflect-failed",
        ref: "memories/d",
        result: { error: "Reflect rejected: EXCESSIVE_EXPANSION — too long" },
      },
      {
        mode: "reflect-failed",
        ref: "scripts/e",
        result: { error: 'Reflect refused: asset type "script" is not supported' },
      },
    ]);

    const collected = collectReflectActions(stash, 100);
    expect(collected.runIdsRead.length).toBe(2);
    expect(collected.actions.length).toBe(4); // distill action filtered out

    const agg = aggregateReflectActions(collected.actions);
    expect(agg.counts.succeeded).toBe(1);
    expect(agg.counts.schemaShape).toBe(1);
    expect(agg.counts.contentPolicy).toBe(1);
    expect(agg.counts.gateRefused).toBe(1);
    expect(agg.counts.llmTouched).toBe(3);
    expect(agg.schemaShapeRate).toBeCloseTo(1 / 3, 9);
  });

  test("respects windowRuns by trimming oldest runs", () => {
    const stash = makeTmpStash();
    // 3 runs total; window of 2 should drop the oldest.
    writeImproveRun(stash, "2026-05-21T10-00-00-000Z-aaa", [{ mode: "reflect", ref: "memories/a" }]);
    writeImproveRun(stash, "2026-05-21T11-00-00-000Z-bbb", [{ mode: "reflect", ref: "memories/b" }]);
    writeImproveRun(stash, "2026-05-21T12-00-00-000Z-ccc", [{ mode: "reflect", ref: "memories/c" }]);

    const collected = collectReflectActions(stash, 2);
    expect(collected.runIdsRead.length).toBe(2);
    expect(collected.actions.length).toBe(2);
    const refs = collected.actions.map((a) => a.ref).sort();
    expect(refs).toEqual(["memories/b", "memories/c"]);
  });

  test("returns empty when stash has no improve runs", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-eval-empty-"));
    createdTmpDirs.push(dir);
    const dataDir = path.join(dir, ".akm", "data");
    initStateDb(dataDir);
    process.env.AKM_DATA_DIR = dataDir;
    const collected = collectReflectActions(dir, 20);
    expect(collected.actions).toEqual([]);
    expect(collected.runIdsRead).toEqual([]);
  });
});

describe("runReflectQualityCase", () => {
  test("metrics-only case (no expectations) passes and reports rates", async () => {
    const stash = makeTmpStash();
    writeImproveRun(stash, "2026-05-21T10-00-00-000Z-aaa", [
      { mode: "reflect", ref: "memories/a" },
      {
        mode: "reflect-failed",
        ref: "memories/b",
        result: { error: 'agent response missing required string field "ref"' },
      },
      {
        mode: "reflect-failed",
        ref: "scripts/c",
        result: { error: 'Reflect refused: asset type "script" is not supported' },
      },
    ]);

    const result = await runReflectQualityCase(makeCase(), makeCtx(stash));
    expect(result.passed).toBe(true);
    expect(result.skipped).toBeUndefined();
    expect(result.type).toBe("reflect-quality");
    const counts = result.metrics.counts as {
      llmTouched: number;
      gateRefused: number;
      succeeded: number;
      schemaShape: number;
    };
    expect(counts.llmTouched).toBe(2);
    expect(counts.gateRefused).toBe(1);
    expect(result.metrics.schemaShapeRate).toBeCloseTo(0.5, 9);
  });

  test("gate case skips when sample size is below minLlmTouchedReflects", async () => {
    const stash = makeTmpStash();
    // Only 2 LLM-touched reflects across the window.
    writeImproveRun(stash, "2026-05-21T10-00-00-000Z-aaa", [
      { mode: "reflect", ref: "memories/a" },
      {
        mode: "reflect-failed",
        ref: "memories/b",
        result: { error: 'agent response missing required string field "ref"' },
      },
    ]);

    const result = await runReflectQualityCase(
      makeCase({
        expected: { maxSchemaShapeRate: 0.1 },
        requires: { minLlmTouchedReflects: 10 },
      }),
      makeCtx(stash),
    );
    expect(result.skipped).toBe(true);
    expect(result.skipReason).toContain("minLlmTouchedReflects=10");
    // Skip path still passes (score=1) so the suite gate doesn't fire on
    // thin sample sizes — same pattern as proposal-accept-rate-floor.
    expect(result.passed).toBe(true);
    expect(result.score).toBe(1);
  });

  test("gate case fails when schemaShapeRate exceeds maxSchemaShapeRate", async () => {
    const stash = makeTmpStash();
    // 10 LLM-touched reflects; 4 schema-shape failures → 40% (> 10% gate).
    const actions: ReflectActionInput[] = [];
    for (let i = 0; i < 6; i++) actions.push({ mode: "reflect", ref: `memories/ok-${i}` });
    for (let i = 0; i < 4; i++) {
      actions.push({
        mode: "reflect-failed",
        ref: `memories/bad-${i}`,
        result: { error: 'agent response missing required string field "ref"' },
      });
    }
    writeImproveRun(stash, "2026-05-21T10-00-00-000Z-aaa", actions);

    const result = await runReflectQualityCase(
      makeCase({
        expected: { maxSchemaShapeRate: 0.1 },
        requires: { minLlmTouchedReflects: 10 },
        scoring: { deterministic: true, passThreshold: 1.0 },
      }),
      makeCtx(stash),
    );
    expect(result.skipped).toBeUndefined();
    expect(result.passed).toBe(false);
    expect(result.score).toBe(0); // 0 of 1 checks ok
    expect(result.metrics.schemaShapeRate).toBeCloseTo(0.4, 9);
  });

  test("gate case passes when schemaShapeRate is at or below the floor", async () => {
    const stash = makeTmpStash();
    // 10 LLM-touched reflects; 1 schema-shape → 10% (boundary).
    const actions: ReflectActionInput[] = [];
    for (let i = 0; i < 9; i++) actions.push({ mode: "reflect", ref: `memories/ok-${i}` });
    actions.push({
      mode: "reflect-failed",
      ref: "memories/bad",
      result: { error: 'agent response missing required string field "ref"' },
    });
    writeImproveRun(stash, "2026-05-21T10-00-00-000Z-aaa", actions);

    const result = await runReflectQualityCase(
      makeCase({
        expected: { maxSchemaShapeRate: 0.1 },
        requires: { minLlmTouchedReflects: 10 },
        scoring: { deterministic: true, passThreshold: 1.0 },
      }),
      makeCtx(stash),
    );
    expect(result.skipped).toBeUndefined();
    expect(result.passed).toBe(true);
    expect(result.metrics.schemaShapeRate).toBeCloseTo(0.1, 9);
  });

  test("emits per-class evidence samples for triage", async () => {
    const stash = makeTmpStash();
    writeImproveRun(stash, "2026-05-21T10-00-00-000Z-aaa", [
      {
        mode: "reflect-failed",
        ref: "memories/bad-1",
        result: { error: 'agent response missing required string field "ref"' },
      },
      {
        mode: "reflect-failed",
        ref: "memories/bad-2",
        result: { error: "Reflect rejected: EXCESSIVE_EXPANSION — way too long" },
      },
    ]);

    const result = await runReflectQualityCase(makeCase(), makeCtx(stash));
    const evidence = result.evidence.sampleByClass as Record<string, Array<{ ref: string }>>;
    expect(evidence.schemaShape.length).toBe(1);
    expect(evidence.schemaShape[0].ref).toBe("memories/bad-1");
    expect(evidence.contentPolicy.length).toBe(1);
    expect(evidence.contentPolicy[0].ref).toBe("memories/bad-2");
  });
});
