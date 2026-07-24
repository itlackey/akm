// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { runRetrievalCase } from "../../scripts/akm-eval/src/runners/retrieval";
import { aggregateScores } from "../../scripts/akm-eval/src/scoring";
import {
  captureInstallationSnapshot,
  materializeInstallationSnapshot,
} from "../../scripts/akm-eval/src/sources/installation-snapshot";
import { compareTwinCaseResults } from "../../scripts/akm-eval/src/twin-run";
import { loadSuite } from "../../scripts/akm-eval/src/twin-run-private";
import type { EvalCase, EvalContext } from "../../scripts/akm-eval/src/types";
import { analyzeMemoryCleanup, applyMemoryCleanup } from "../../src/commands/improve/memory/memory-improve";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "../_helpers/sandbox";

const SUITE = "improve-effectiveness";
const SUITE_DIR = path.resolve("scripts", "akm-eval", "cases", SUITE);
const AKM_BIN = path.resolve("src", "cli.ts");
let storage: IsolatedAkmStorage | undefined;

afterEach(() => {
  storage?.cleanup();
  storage = undefined;
});

function byId(cases: EvalCase[], id: string): EvalCase {
  const evalCase = cases.find((candidate) => candidate.id === id);
  if (!evalCase) throw new Error(`missing eval case: ${id}`);
  return evalCase;
}

function childEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

function makePrivateTree(root: string): void {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const child = path.join(root, entry.name);
    if (entry.isDirectory()) makePrivateTree(child);
    else fs.chmodSync(child, 0o600);
  }
  fs.chmodSync(root, 0o700);
}

function indexFixture(env: Record<string, string> = childEnv()): void {
  const indexed = spawnSync(AKM_BIN, ["index", "--full"], {
    encoding: "utf8",
    env,
  });
  expect(indexed.status, indexed.stderr).toBe(0);
}

function context(overrides: Partial<Pick<EvalContext, "stashRoot" | "dataDir" | "env">> = {}): EvalContext {
  if (!storage) throw new Error("storage is not initialized");
  return {
    stashRoot: overrides.stashRoot ?? storage.stashDir,
    dataDir: overrides.dataDir ?? path.join(storage.dataDir, "akm"),
    akmBin: AKM_BIN,
    casesRoot: path.dirname(SUITE_DIR),
    outRoot: path.join(storage.root, "out"),
    keepSandbox: false,
    env: overrides.env ?? childEnv(),
  };
}

describe("akm-eval improve-effectiveness suite", () => {
  test("loads a deterministic non-judge suite with an automatic protected case", () => {
    const loaded = loadSuite(SUITE);

    expect(loaded.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(loaded.cases.map((evalCase) => evalCase.id).sort()).toEqual([
      "protected-anchor-retrieval",
      "target-retrieval-lift",
    ]);
    expect(new Set(loaded.cases.map((evalCase) => evalCase.id)).size).toBe(loaded.cases.length);
    for (const evalCase of loaded.cases) {
      expect(evalCase.suite).toBe(SUITE);
      expect(evalCase.type).toBe("retrieval");
      expect(evalCase.scoring?.deterministic).toBe(true);
      expect(evalCase.scoring?.llmJudge).toBeUndefined();
      expect(evalCase.requires).toBeUndefined();
    }
    expect(byId(loaded.cases, "protected-anchor-retrieval").tags).toContain("protected");
  });

  test("scores the frozen flaw below ceiling, measures lift, and keeps skips symmetric", async () => {
    storage = withIsolatedAkmStorage();
    const corpus = path.join(SUITE_DIR, "fixtures", "corpus", "knowledge");
    fs.copyFileSync(path.join(corpus, "eval-anchor.md"), path.join(storage.stashDir, "knowledge", "eval-anchor.md"));
    const memories = path.join(SUITE_DIR, "fixtures", "corpus", "memories");
    for (const file of fs.readdirSync(memories)) {
      fs.copyFileSync(path.join(memories, file), path.join(storage.stashDir, "memories", file));
    }
    writeSandboxConfig({
      semanticSearchMode: "off",
      defaultBundle: SUITE,
      bundles: {
        [SUITE]: { path: storage.stashDir, writable: true },
      },
    });

    const { cases } = loadSuite(SUITE);
    const target = byId(cases, "target-retrieval-lift");
    const anchor = byId(cases, "protected-anchor-retrieval");
    indexFixture();
    const dataDir = path.join(storage.dataDir, "akm");
    const snapshotDir = path.join(storage.root, "snapshot");
    for (const emptyType of ["agents", "commands", "lessons", "scripts", "skills"]) {
      fs.rmSync(path.join(storage.stashDir, emptyType), { recursive: true });
    }
    makePrivateTree(storage.stashDir);
    makePrivateTree(dataDir);
    makePrivateTree(path.join(storage.configDir, "akm"));
    captureInstallationSnapshot({
      destinationDir: snapshotDir,
      bundleRoots: { [SUITE]: storage.stashDir },
      defaultBundle: SUITE,
      configPath: path.join(storage.configDir, "akm", "config.json"),
      dataDir,
      producer: { version: "test", commit: null },
    });

    const control = await Promise.all([runRetrievalCase(target, context()), runRetrievalCase(anchor, context())]);

    const installation = materializeInstallationSnapshot(snapshotDir, path.join(storage.root, "materialized"));
    const treatmentStash = installation.bundleRoots[SUITE];
    if (!treatmentStash) throw new Error("materialized treatment bundle is missing");
    const treatmentEnv = { ...childEnv(), ...installation.env };
    const cleanup = analyzeMemoryCleanup(treatmentStash);
    const duplicateRef = ["memory", "database-restore-copy.derived"].join(":");
    const survivorRef = ["memory", "database-restore.derived"].join(":");
    expect(cleanup.pruneCandidates).toContainEqual({
      ref: duplicateRef,
      parentRef: "memories/database-restore",
      reason: "duplicate-derived",
      survivorRef,
    });
    const applied = applyMemoryCleanup(treatmentStash, cleanup);
    expect(applied.archived.map((record) => record.ref)).toContain(duplicateRef);
    indexFixture(treatmentEnv);
    const treatmentContext = context({
      stashRoot: treatmentStash,
      dataDir: installation.dataDir,
      env: treatmentEnv,
    });
    const treatment = await Promise.all([
      runRetrievalCase(target, treatmentContext),
      runRetrievalCase(anchor, treatmentContext),
    ]);

    expect(control.map(({ caseId, score, passed }) => ({ caseId, score, passed }))).toEqual([
      { caseId: "target-retrieval-lift", score: 0.3, passed: false },
      { caseId: "protected-anchor-retrieval", score: 1, passed: true },
    ]);
    expect(treatment.map(({ caseId, score, passed }) => ({ caseId, score, passed }))).toEqual([
      { caseId: "target-retrieval-lift", score: 1, passed: true },
      { caseId: "protected-anchor-retrieval", score: 1, passed: true },
    ]);
    expect(aggregateScores(control).deterministic).toBe(0.65);
    expect(aggregateScores(treatment).deterministic).toBe(1);
    expect(control.every((result) => result.skipped !== true)).toBe(true);
    expect(treatment.every((result) => result.skipped !== true)).toBe(true);

    const comparison = compareTwinCaseResults(control, treatment, new Set(["protected-anchor-retrieval"]), 0);
    expect(comparison.incompleteReasons).toEqual([]);
    expect(comparison.regressions).toEqual([]);
    expect(comparison.newlyPassingCaseIds).toEqual(["target-retrieval-lift"]);
  });
});
