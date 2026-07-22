// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseRef } from "../../scripts/akm-eval/src/lib/ref-normalize";
import { openStateDatabase } from "../../src/core/state-db";

const VERDICT_SCRIPT = path.resolve("scripts/akm-eval/src/proactive-verdict.ts");
const REAL_QUERY_SCRIPT = path.resolve("scripts/akm-eval/src/gen-real-query-suite.ts");
const tempDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-eval-measurement-"));
  tempDirs.push(dir);
  return dir;
}

function isoDaysFromNow(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString();
}

function createCurrentDatabases(root: string): { statePath: string; indexPath: string } {
  const statePath = path.join(root, "state.db");
  const migrated = openStateDatabase(statePath);
  migrated.close();

  const indexPath = path.join(root, "index.db");
  const index = new Database(indexPath);
  index.exec("CREATE TABLE entries (item_ref TEXT)");
  index.close();
  return { statePath, indexPath };
}

interface ProposalSeed {
  id: string;
  ref: string;
  lane: string;
  createdAt: string;
  updatedAt: string;
  decidedAt?: string;
}

function seedProposal(db: Database, seed: ProposalSeed): void {
  const metadata = {
    eligibilitySource: seed.lane,
    ...(seed.decidedAt ? { review: { outcome: "accepted", decidedAt: seed.decidedAt } } : {}),
  };
  db.prepare(
    `INSERT INTO proposals
       (id, stash_dir, ref, status, source, created_at, updated_at, content, metadata_json)
     VALUES (?, ?, ?, 'accepted', 'reflect', ?, ?, '', ?)`,
  ).run(seed.id, "/stash", seed.ref, seed.createdAt, seed.updatedAt, JSON.stringify(metadata));
}

function seedUsage(
  db: Database,
  eventType: string,
  ref: string | null,
  source: string,
  createdAt: string,
  options: { query?: string; signal?: string; metadata?: Record<string, unknown> } = {},
): void {
  db.prepare(
    `INSERT INTO usage_events (event_type, query, entry_ref, signal, metadata, source, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    eventType,
    options.query ?? null,
    ref,
    options.signal ?? null,
    options.metadata ? JSON.stringify(options.metadata) : null,
    source,
    createdAt,
  );
}

function runVerdict(
  root: string,
  statePath: string,
  indexPath: string,
  out = path.join(root, "verdict.json"),
  extraArgs: string[] = [],
) {
  const result = spawnSync(
    "bun",
    [
      VERDICT_SCRIPT,
      "--stash",
      root,
      "--state-db",
      statePath,
      "--index-db",
      indexPath,
      "--treatment-file",
      path.join(root, "missing-treatment.txt"),
      "--format",
      "json",
      "--out",
      out,
      ...extraArgs,
    ],
    { encoding: "utf8" },
  );
  if (result.status === null) throw new Error(`verdict process did not exit: ${String(result.error)}`);
  return { ...result, status: result.status };
}

function seedEvalRun(root: string, id: string, fingerprint: string, score: number): void {
  const runDir = path.join(root, ".akm", "evals", "runs", id);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(
    path.join(runDir, "eval-result.json"),
    `${JSON.stringify({
      schemaVersion: 2,
      evalRunId: id,
      suite: "real-query-20260722T000000Z",
      mode: "baseline",
      startedAt: `2026-01-0${Number(id.slice(-1)) + 1}T00:00:00.000Z`,
      completedAt: `2026-01-0${Number(id.slice(-1)) + 1}T00:00:01.000Z`,
      durationMs: 1000,
      akm: {},
      inputs: { caseCount: 1, caseDir: "/cases/real-query", suiteFingerprint: fingerprint },
      scores: { overall: score, deterministic: score },
      countsByType: {},
      metrics: {},
      errors: [],
      artifacts: {},
    })}\n`,
  );
}

function parseVerdict(stdout: string): {
  metrics: { laneGrr: Array<{ lane: string; promoted30d: number; readBack: number; grr: number | null }> };
} {
  return JSON.parse(stdout) as {
    metrics: { laneGrr: Array<{ lane: string; promoted30d: number; readBack: number; grr: number | null }> };
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("akm-eval GRR measurement", () => {
  test("runtime ref parsing accepts only current concept refs", () => {
    const legacyRef = ["skill", "review"].join(":");
    const nestedLegacyRef = ["skill", "tools/review"].join(":");
    expect(parseRef("skills/review")?.canonical).toBe("skills/review");
    expect(parseRef("team//knowledge/deploy#rollback")?.canonical).toBe("team//knowledge/deploy#rollback");
    expect(parseRef("knowledge/http:cache")?.canonical).toBe("knowledge/http:cache");
    expect(parseRef("skills/tools/review:deep")?.canonical).toBe("skills/tools/review:deep");
    expect(parseRef("team//knowledge/deploy#rollback:fast")?.canonical).toBe("team//knowledge/deploy#rollback:fast");
    expect(parseRef(legacyRef)).toBeUndefined();
    expect(parseRef(`team//${legacyRef}`)).toBeUndefined();
    expect(parseRef(nestedLegacyRef)).toBeUndefined();
    expect(parseRef(`team//${nestedLegacyRef}`)).toBeUndefined();
  });

  test("reads usage_events from state.db and requires usage strictly after acceptance", () => {
    const root = tempDir();
    const { statePath, indexPath } = createCurrentDatabases(root);
    const state = new Database(statePath);
    try {
      const accepted = isoDaysFromNow(-2);
      seedProposal(state, {
        id: "accepted-after-created-window",
        ref: "personal//knowledge/temporal",
        lane: "temporal",
        createdAt: isoDaysFromNow(-45),
        updatedAt: isoDaysFromNow(-1),
        decidedAt: accepted,
      });
      seedUsage(state, "show", "personal//knowledge/temporal", "user", isoDaysFromNow(-3));
      seedUsage(state, "show", "personal//knowledge/temporal", "user", accepted);
      seedUsage(state, "show", "personal//knowledge/temporal", "user", isoDaysFromNow(-1));

      seedProposal(state, {
        id: "pre-acceptance-only",
        ref: "personal//knowledge/pre-only",
        lane: "temporal",
        createdAt: isoDaysFromNow(-3),
        updatedAt: accepted,
        decidedAt: accepted,
      });
      seedUsage(state, "curate", "personal//knowledge/pre-only", "user", isoDaysFromNow(-4));

      seedProposal(state, {
        id: "updated-at-fallback",
        ref: "personal//knowledge/fallback",
        lane: "temporal",
        createdAt: isoDaysFromNow(-40),
        updatedAt: isoDaysFromNow(-2),
      });
      seedUsage(state, "show", "personal//knowledge/fallback", "user", isoDaysFromNow(-1));
    } finally {
      state.close();
    }

    const result = runVerdict(root, statePath, indexPath);
    expect([0, 1, 3]).toContain(result.status);
    const lane = parseVerdict(result.stdout).metrics.laneGrr.find((row) => row.lane === "temporal");
    expect(lane).toEqual({ lane: "temporal", promoted30d: 3, readBack: 2, grr: 2 / 3 });

    const index = new Database(indexPath, { readonly: true });
    try {
      const usageTable = index.query("SELECT name FROM sqlite_master WHERE type='table' AND name='usage_events'").get();
      expect(usageTable).toBeNull();
    } finally {
      index.close();
    }
  });

  test("anchors repeated acceptance to the latest accepted revision", () => {
    const root = tempDir();
    const { statePath, indexPath } = createCurrentDatabases(root);
    const state = new Database(statePath);
    try {
      const ref = "personal//lessons/repeated";
      seedProposal(state, {
        id: "first-revision",
        ref,
        lane: "repeated",
        createdAt: isoDaysFromNow(-12),
        updatedAt: isoDaysFromNow(-10),
        decidedAt: isoDaysFromNow(-10),
      });
      seedProposal(state, {
        id: "second-revision",
        ref,
        lane: "repeated",
        createdAt: isoDaysFromNow(-3),
        updatedAt: isoDaysFromNow(-2),
        decidedAt: isoDaysFromNow(-2),
      });
      seedUsage(state, "show", ref, "user", isoDaysFromNow(-5));
    } finally {
      state.close();
    }

    const result = runVerdict(root, statePath, indexPath);
    expect([0, 1, 3]).toContain(result.status);
    expect(parseVerdict(result.stdout).metrics.laneGrr.find((row) => row.lane === "repeated")).toEqual({
      lane: "repeated",
      promoted30d: 1,
      readBack: 0,
      grr: 0,
    });
  });

  test("preserves duplicate bundle identity and excludes non-demand provenance", () => {
    const root = tempDir();
    const { statePath, indexPath } = createCurrentDatabases(root);
    const state = new Database(statePath);
    try {
      const accepted = isoDaysFromNow(-2);
      for (const [id, ref] of [
        ["bundle-a", "bundle-a//skills/shared"],
        ["bundle-b", "bundle-b//skills/shared"],
        ["audit-only", "bundle-a//skills/audit-only"],
        ["unknown-only", "bundle-a//skills/unknown-only"],
        ["impression-only", "bundle-a//skills/impression-only"],
      ] as const) {
        seedProposal(state, {
          id,
          ref,
          lane: "identity",
          createdAt: isoDaysFromNow(-3),
          updatedAt: accepted,
          decidedAt: accepted,
        });
      }
      seedUsage(state, "show", "bundle-a//skills/shared", "user", isoDaysFromNow(-1));
      seedUsage(state, "show", "bundle-a//skills/audit-only", "audit", isoDaysFromNow(-1));
      seedUsage(state, "show", "bundle-b//skills/shared", "improve", isoDaysFromNow(-1));
      seedUsage(state, "show", "bundle-b//skills/shared", "task", isoDaysFromNow(-1));
      seedUsage(state, "show", "bundle-a//skills/unknown-only", "unknown", isoDaysFromNow(-1));
      seedUsage(state, "select", "bundle-a//skills/unknown-only", "user", isoDaysFromNow(-1));
      seedUsage(state, "search", "bundle-a//skills/impression-only", "user", isoDaysFromNow(-1));
    } finally {
      state.close();
    }

    const result = runVerdict(root, statePath, indexPath);
    expect([0, 1, 3]).toContain(result.status);
    expect(parseVerdict(result.stdout).metrics.laneGrr.find((row) => row.lane === "identity")).toEqual({
      lane: "identity",
      promoted30d: 5,
      readBack: 1,
      grr: 0.2,
    });
  });

  test("derives distinct JSON and Markdown verdict paths for every --out suffix", () => {
    const root = tempDir();
    const { statePath, indexPath } = createCurrentDatabases(root);
    const markdownPath = path.join(root, "monthly.md");

    const result = runVerdict(root, statePath, indexPath, markdownPath);
    expect([0, 1, 3]).toContain(result.status);
    expect(fs.readFileSync(markdownPath, "utf8")).toStartWith("# akm-eval-proactive-verdict");
    const jsonPath = path.join(root, "monthly.json");
    expect(() => JSON.parse(fs.readFileSync(jsonPath, "utf8"))).not.toThrow();
  });

  test("auto-selects the newest run before finding the oldest baseline with its fingerprint", () => {
    const root = tempDir();
    const { statePath, indexPath } = createCurrentDatabases(root);
    const fingerprintA = "a".repeat(64);
    const fingerprintB = "b".repeat(64);
    seedEvalRun(root, "run-a1", fingerprintA, 0.1);
    seedEvalRun(root, "run-a2", fingerprintA, 0.2);
    seedEvalRun(root, "run-b1", fingerprintB, 0.4);
    seedEvalRun(root, "run-b2", fingerprintB, 0.7);

    const result = runVerdict(root, statePath, indexPath);
    expect([0, 1, 3]).toContain(result.status);
    const report = JSON.parse(result.stdout) as {
      metrics: { retrievalQuality: { baselineRunId: string; currentRunId: string; delta: number } };
    };
    expect(report.metrics.retrievalQuality).toMatchObject({
      baselineRunId: "run-b1",
      currentRunId: "run-b2",
    });
    expect(report.metrics.retrievalQuality.delta).toBeCloseTo(0.3);

    const mismatch = runVerdict(root, statePath, indexPath, path.join(root, "explicit.json"), [
      "--baseline-run",
      "run-a2",
      "--current-run",
      "run-b2",
    ]);
    expect(mismatch.status).toBe(2);
    expect(mismatch.stderr).toContain("suite fingerprint mismatch");
  });
});

describe("real-query suite generation", () => {
  test("uses state.db user engagements and current fully-qualified refs", () => {
    const root = tempDir();
    const { statePath, indexPath } = createCurrentDatabases(root);
    const index = new Database(indexPath);
    const state = new Database(statePath);
    try {
      index.prepare("INSERT INTO entries (item_ref) VALUES (?)").run("bundle-a//knowledge/shared");
      index.prepare("INSERT INTO entries (item_ref) VALUES (?)").run("bundle-b//knowledge/shared");

      const queryMs = Date.now() - 2 * 86_400_000;
      const queryAt = new Date(queryMs).toISOString();
      const engagedAt = new Date(queryMs + 60_000).toISOString();
      seedUsage(state, "search", null, "user", queryAt, {
        query: "shared deployment guide",
        metadata: { resultCount: 2 },
      });
      // A returned search hit is an impression, not genuine engagement.
      seedUsage(state, "search", "bundle-b//knowledge/shared", "user", queryAt, {
        query: "shared deployment guide",
      });
      seedUsage(state, "show", "bundle-b//knowledge/shared", "audit", engagedAt);
      seedUsage(state, "show", "bundle-a//knowledge/shared", "user", engagedAt);

      const auditQueryMs = Date.now() - 4 * 86_400_000;
      seedUsage(state, "search", null, "audit", new Date(auditQueryMs).toISOString(), {
        query: "eval-only query",
        metadata: { resultCount: 1 },
      });
      seedUsage(state, "show", "bundle-b//knowledge/shared", "user", new Date(auditQueryMs + 60_000).toISOString());

      seedUsage(state, "search", null, "user", isoDaysFromNow(-0.5), {
        query: "impression only",
        metadata: { resultCount: 1 },
      });
      seedUsage(state, "search", "bundle-a//knowledge/shared", "user", isoDaysFromNow(-0.5), {
        query: "impression only",
      });

      const selectQueryMs = Date.now() - 6 * 60 * 60_000;
      seedUsage(state, "search", null, "user", new Date(selectQueryMs).toISOString(), {
        query: "select-only query",
        metadata: { resultCount: 1 },
      });
      seedUsage(state, "select", "bundle-b//knowledge/shared", "user", new Date(selectQueryMs + 60_000).toISOString());
    } finally {
      index.close();
      state.close();
    }

    const casesRoot = path.join(root, "cases");
    const result = spawnSync(
      "bun",
      [
        REAL_QUERY_SCRIPT,
        "--state-db",
        statePath,
        "--index-db",
        indexPath,
        "--cases-root",
        casesRoot,
        "--out-suite",
        "real-query",
        "--format",
        "json",
      ],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(0);

    const suiteDir = path.join(casesRoot, "real-query");
    const files = fs.readdirSync(suiteDir).filter((file) => file.endsWith(".json"));
    expect(files).toHaveLength(1);
    const caseFile = files[0];
    if (!caseFile) throw new Error("real-query case was not generated");
    const generated = JSON.parse(fs.readFileSync(path.join(suiteDir, caseFile), "utf8")) as {
      input: { query: string };
      expected: { mustIncludeRefs: string[] };
    };
    expect(generated.input.query).toBe("shared deployment guide");
    expect(generated.expected.mustIncludeRefs).toEqual(["bundle-a//knowledge/shared"]);
  });

  test("refuses to overwrite an existing generated suite", () => {
    const root = tempDir();
    const { statePath, indexPath } = createCurrentDatabases(root);
    const casesRoot = path.join(root, "cases");
    const suiteDir = path.join(casesRoot, "real-query-existing");
    fs.mkdirSync(suiteDir, { recursive: true });
    const existing = path.join(suiteDir, "rq-001-existing.json");
    fs.writeFileSync(existing, "existing generation\n");

    const result = spawnSync(
      "bun",
      [
        REAL_QUERY_SCRIPT,
        "--state-db",
        statePath,
        "--index-db",
        indexPath,
        "--cases-root",
        casesRoot,
        "--out-suite",
        "real-query-existing",
      ],
      { encoding: "utf8" },
    );

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("already exists");
    expect(fs.readFileSync(existing, "utf8")).toBe("existing generation\n");
  });

  test("recovers publication interrupted between the suite and manifest renames", () => {
    const root = tempDir();
    const { statePath, indexPath } = createCurrentDatabases(root);
    const index = new Database(indexPath);
    const state = new Database(statePath);
    try {
      index.prepare("INSERT INTO entries (item_ref) VALUES (?)").run("bundle-a//knowledge/recovery");
      const queryMs = Date.now() - 60 * 60_000;
      seedUsage(state, "search", null, "user", new Date(queryMs).toISOString(), {
        query: "publication recovery",
      });
      seedUsage(state, "show", "bundle-a//knowledge/recovery", "user", new Date(queryMs + 60_000).toISOString());
    } finally {
      index.close();
      state.close();
    }

    const casesRoot = path.join(root, "cases");
    const args = [
      REAL_QUERY_SCRIPT,
      "--state-db",
      statePath,
      "--index-db",
      indexPath,
      "--cases-root",
      casesRoot,
      "--out-suite",
      "real-query-recovery",
      "--format",
      "json",
    ];
    const interrupted = spawnSync("bun", args, {
      encoding: "utf8",
      env: { ...process.env, AKM_TEST_REAL_QUERY_CRASH_AFTER_SUITE_PUBLISH: "1" },
    });
    expect(interrupted.status).not.toBe(0);
    expect(fs.existsSync(path.join(casesRoot, "real-query-recovery"))).toBe(true);
    expect(fs.existsSync(path.join(casesRoot, "real-query-recovery.manifest.json"))).toBe(false);
    fs.rmSync(statePath);
    fs.rmSync(indexPath);

    const recovered = spawnSync("bun", args, { encoding: "utf8" });
    expect(recovered.status, recovered.stderr).toBe(0);
    expect(fs.existsSync(path.join(casesRoot, "real-query-recovery.manifest.json"))).toBe(true);
    expect(fs.existsSync(path.join(casesRoot, ".real-query-recovery.publishing"))).toBe(false);
    expect(JSON.parse(recovered.stdout)).toMatchObject({ suite: "real-query-recovery", emittedCases: 1 });
  });
});
