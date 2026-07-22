// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fingerprintEvalCases } from "../../scripts/akm-eval/src/sources/eval-runs";
import type { EvalCase, EvalCaseResult } from "../../scripts/akm-eval/src/types";

const RUN_SCRIPT = path.resolve("scripts/akm-eval/src/run.ts");
const COMPARE_SCRIPT = path.resolve("scripts/akm-eval/src/compare.ts");
const TREND_SCRIPT = path.resolve("scripts/akm-eval/src/trend.ts");
const REPLAY_SCRIPT = path.resolve("scripts/akm-eval/src/replay.ts");
const tempDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-eval-fingerprint-"));
  tempDirs.push(dir);
  return dir;
}

function writeCase(file: string, query: string): void {
  fs.writeFileSync(
    file,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        id: "fingerprint-case",
        suite: "fingerprint",
        type: "retrieval",
        description: "Fingerprint fixture.",
        input: { query, topK: 1 },
        expected: { mustIncludeRefs: ["bundle//knowledge/answer"] },
      },
      null,
      2,
    )}\n`,
  );
}

function runEval(root: string, casesRoot: string, fakeAkm: string, envLog: string): string {
  const runsDir = path.join(root, ".akm", "evals", "runs");
  const before = new Set(fs.existsSync(runsDir) ? fs.readdirSync(runsDir) : []);
  const result = spawnSync(
    "bun",
    [
      RUN_SCRIPT,
      "--suite",
      "fingerprint",
      "--stash",
      root,
      "--cases-dir",
      casesRoot,
      "--akm",
      fakeAkm,
      "--format",
      "none",
    ],
    {
      encoding: "utf8",
      env: { ...(process.env as Record<string, string>), EVAL_ENV_LOG: envLog, AKM_EVENT_SOURCE: "user" },
    },
  );
  expect(result.status).toBe(0);
  const created = fs.readdirSync(runsDir).find((entry) => entry !== "latest" && !before.has(entry));
  expect(created).toBeDefined();
  if (!created) throw new Error("eval run directory was not created");
  return created;
}

function readFingerprint(root: string, runId: string): string | undefined {
  const file = path.join(root, ".akm", "evals", "runs", runId, "eval-result.json");
  const result = JSON.parse(fs.readFileSync(file, "utf8")) as { inputs: { suiteFingerprint?: string } };
  return result.inputs.suiteFingerprint;
}

function writeRunEnvelope(
  root: string,
  runId: string,
  suite: string,
  caseDir: string,
  suiteFingerprint: string,
  score = 1,
): string {
  const runDir = path.join(root, ".akm", "evals", "runs", runId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(
    path.join(runDir, "eval-result.json"),
    `${JSON.stringify({
      schemaVersion: 2,
      evalRunId: runId,
      suite,
      mode: "baseline",
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:00:01.000Z",
      durationMs: 1000,
      akm: {},
      inputs: { caseCount: 1, caseDir, suiteFingerprint },
      scores: { overall: score, deterministic: score },
      countsByType: {},
      metrics: {},
      errors: [],
      artifacts: {},
    })}\n`,
  );
  return runDir;
}

function writeRecordedReplay(root: string, runId: string, fingerprintOverride?: string): { fingerprint: string } {
  const casesRoot = path.join(root, "cases");
  const suite = "replay-fingerprint";
  const suiteDir = path.join(casesRoot, suite);
  fs.mkdirSync(suiteDir, { recursive: true });
  const evalCase: EvalCase = {
    schemaVersion: 1,
    id: "replay-case",
    suite,
    type: "retrieval",
    description: "Replay fingerprint fixture.",
    input: { query: "replay query", topK: 1 },
    expected: {},
  };
  fs.writeFileSync(path.join(suiteDir, "case.json"), `${JSON.stringify(evalCase, null, 2)}\n`);
  const fingerprint = fingerprintEvalCases([evalCase], suiteDir);
  const runDir = writeRunEnvelope(root, runId, suite, suiteDir, fingerprintOverride ?? fingerprint);
  const expected: EvalCaseResult = {
    caseId: evalCase.id,
    type: "retrieval",
    score: 1,
    passed: true,
    metrics: {
      includeScore: 1,
      keywordScore: 1,
      forbiddenScore: 1,
      minHitsScore: 1,
      hitAt1: null,
      hitAtK: true,
      forbiddenHits: [],
      keywordHits: [],
      hitCount: 0,
    },
    evidence: {
      query: "replay query",
      topK: 1,
      refs: [],
      topHitArtifact: "Query: replay query\n\nTop hits:",
    },
    durationMs: 0,
  };
  fs.writeFileSync(path.join(runDir, "case-results.jsonl"), `${JSON.stringify(expected)}\n`);
  const replayDir = path.join(runDir, "artifacts", "replay");
  fs.mkdirSync(replayDir, { recursive: true });
  const invocations = [
    { id: 1, kind: "akm", args: ["--version"], stdout: "fake 1.0\n", stderr: "", status: 0, durationMs: 1 },
    {
      id: 2,
      kind: "akm",
      args: ["search", "replay query", "--format", "jsonl", "--shape", "agent", "--limit", "1"],
      stdout: "",
      stderr: "",
      status: 0,
      durationMs: 1,
    },
  ];
  fs.writeFileSync(
    path.join(replayDir, "akm-invocations.jsonl"),
    `${invocations.map((row) => JSON.stringify(row)).join("\n")}\n`,
  );
  fs.writeFileSync(path.join(replayDir, "state-db-queries.jsonl"), "");
  fs.writeFileSync(path.join(replayDir, "improve-results.jsonl"), "");
  return { fingerprint };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("akm-eval suite identity", () => {
  test("stores a deterministic fingerprint, stamps subprocesses audit, and rejects mismatched comparisons", () => {
    const root = tempDir();
    const casesRoot = path.join(root, "cases");
    const suiteDir = path.join(casesRoot, "fingerprint");
    fs.mkdirSync(suiteDir, { recursive: true });
    const caseFile = path.join(suiteDir, "case.json");
    writeCase(caseFile, "first query");

    const envLog = path.join(root, "event-sources.log");
    const fakeAkm = path.join(root, "fake-akm.sh");
    fs.writeFileSync(
      fakeAkm,
      `#!/bin/sh\nprintf '%s\\n' "\${AKM_EVENT_SOURCE:-unset}" >> "$EVAL_ENV_LOG"\nif [ "$1" = "--version" ]; then\n  printf 'fake-akm 1.0\\n'\nelif [ "$1" = "search" ]; then\n  printf '%s\\n' '{"ref":"bundle//knowledge/answer","name":"answer","type":"knowledge"}'\nfi\n`,
    );
    fs.chmodSync(fakeAkm, 0o755);

    const first = runEval(root, casesRoot, fakeAkm, envLog);
    const same = runEval(root, casesRoot, fakeAkm, envLog);
    const firstFingerprint = readFingerprint(root, first);
    const firstEnvelope = JSON.parse(
      fs.readFileSync(path.join(root, ".akm", "evals", "runs", first, "eval-result.json"), "utf8"),
    ) as { schemaVersion: number };
    expect(firstEnvelope.schemaVersion).toBe(2);
    expect(firstFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(readFingerprint(root, same)).toBe(firstFingerprint);

    writeCase(caseFile, "changed query");
    const changed = runEval(root, casesRoot, fakeAkm, envLog);
    expect(readFingerprint(root, changed)).not.toBe(firstFingerprint);

    const sources = fs.readFileSync(envLog, "utf8").trim().split("\n");
    expect(sources.length).toBeGreaterThan(0);
    expect(new Set(sources)).toEqual(new Set(["audit"]));

    const comparison = spawnSync("bun", [COMPARE_SCRIPT, first, changed, "--stash", root], {
      encoding: "utf8",
    });
    expect(comparison.status).toBe(2);
    expect(comparison.stderr).toContain("suite fingerprint mismatch");
  });

  test("canonicalizes object keys and includes transitive fixture and probe bytes", () => {
    const root = tempDir();
    const suiteDir = path.join(root, "cases", "identity");
    const fixtureDir = path.join(suiteDir, "fixtures", "sample");
    const probesDir = path.join(suiteDir, "probes");
    fs.mkdirSync(fixtureDir, { recursive: true });
    fs.mkdirSync(probesDir, { recursive: true });
    fs.writeFileSync(path.join(fixtureDir, "asset.md"), "fixture-v1\n");
    fs.writeFileSync(path.join(probesDir, "probe.json"), '{"grade":"pass"}\n');

    const first = JSON.parse(
      '{"schemaVersion":1,"id":"identity","suite":"identity","type":"memory-safety","description":"identity","input":{"fixture":"fixtures/sample","probesDir":"probes","nested":{"z":1,"a":2}},"expected":{"b":2,"a":1}}',
    ) as EvalCase;
    const reordered = JSON.parse(
      '{"expected":{"a":1,"b":2},"input":{"nested":{"a":2,"z":1},"probesDir":"probes","fixture":"fixtures/sample"},"description":"identity","type":"memory-safety","suite":"identity","id":"identity","schemaVersion":1}',
    ) as EvalCase;

    const initial = fingerprintEvalCases([first], suiteDir);
    expect(fingerprintEvalCases([reordered], suiteDir)).toBe(initial);

    fs.writeFileSync(path.join(fixtureDir, "asset.md"), "fixture-v2\n");
    const fixtureChanged = fingerprintEvalCases([first], suiteDir);
    expect(fixtureChanged).not.toBe(initial);

    fs.writeFileSync(path.join(probesDir, "probe.json"), '{"grade":"reject"}\n');
    expect(fingerprintEvalCases([first], suiteDir)).not.toBe(fixtureChanged);
  });

  test("preserves case execution order in the suite fingerprint", () => {
    const first = {
      schemaVersion: 1,
      id: "first",
      suite: "ordered",
      type: "retrieval",
      description: "Runs first.",
      input: { query: "first", topK: 1 },
      expected: {},
    } satisfies EvalCase;
    const second = {
      schemaVersion: 1,
      id: "second",
      suite: "ordered",
      type: "retrieval",
      description: "Runs second.",
      input: { query: "second", topK: 1 },
      expected: {},
    } satisfies EvalCase;

    expect(fingerprintEvalCases([first, second])).not.toBe(fingerprintEvalCases([second, first]));
  });

  test("rejects symlinked suite dependencies instead of fingerprinting link text", () => {
    const root = tempDir();
    const suiteDir = path.join(root, "cases", "symlinked");
    const fixtureDir = path.join(suiteDir, "fixtures");
    fs.mkdirSync(fixtureDir, { recursive: true });
    fs.writeFileSync(path.join(fixtureDir, "target.md"), "consumed bytes\n");
    fs.symlinkSync("target.md", path.join(fixtureDir, "linked.md"));
    const evalCase = {
      schemaVersion: 1,
      id: "symlinked",
      suite: "symlinked",
      type: "memory-safety",
      description: "Symlink dependency.",
      input: { fixture: "fixtures" },
      expected: {},
    } satisfies EvalCase;

    expect(() => fingerprintEvalCases([evalCase], suiteDir)).toThrow(/symbolic link|symlink/i);
  });

  test("trend rejects a suite containing mixed fingerprints", () => {
    const root = tempDir();
    writeRunEnvelope(root, "run-a", "trend-suite", "/cases/trend-suite", "a".repeat(64), 0.2);
    writeRunEnvelope(root, "run-b", "trend-suite", "/cases/trend-suite", "b".repeat(64), 0.8);

    const result = spawnSync("bun", [TREND_SCRIPT, "--stash", root, "--suite", "trend-suite"], {
      encoding: "utf8",
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("mixed suite fingerprints");
  });

  test("trend fingerprint validation is scoped to the requested last-N window", () => {
    const root = tempDir();
    writeRunEnvelope(root, "run-a", "trend-suite", "/cases/trend-suite", "a".repeat(64), 0.2);
    writeRunEnvelope(root, "run-b", "trend-suite", "/cases/trend-suite", "b".repeat(64), 0.8);

    const result = spawnSync("bun", [TREND_SCRIPT, "--stash", root, "--suite", "trend-suite", "--limit", "1"], {
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("0.800");
    expect(result.stdout).not.toContain("0.200");
  });

  test("replay verifies and propagates the recorded suite fingerprint", () => {
    const root = tempDir();
    const { fingerprint } = writeRecordedReplay(root, "recorded");
    const result = spawnSync("bun", [REPLAY_SCRIPT, "recorded", "--stash", root, "--format", "json"], {
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    const replay = JSON.parse(result.stdout) as { schemaVersion: number; suiteFingerprint?: string };
    expect(replay).toMatchObject({ schemaVersion: 2, suiteFingerprint: fingerprint });
  });

  test("replay fails closed when current suite bytes do not match the recorded fingerprint", () => {
    const root = tempDir();
    writeRecordedReplay(root, "tampered", "0".repeat(64));
    const result = spawnSync("bun", [REPLAY_SCRIPT, "tampered", "--stash", root, "--format", "json"], {
      encoding: "utf8",
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("suite fingerprint mismatch");
  });
});
