// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { showLocal } from "../../../src/commands/read/show";
import { opencodeAdapter } from "../../../src/core/adapter/adapters";
import { parseBundleRef } from "../../../src/core/asset/asset-ref";
import { resetConfigCache } from "../../../src/core/config/config";
import { getDbPath } from "../../../src/core/paths";
import { getStateDbPath, withStateDb } from "../../../src/core/state-db";
import { akmIndex, lookupBundleRef, lookupBundleRefWithResolution } from "../../../src/indexer/indexer";
import { closeDatabase, openExistingDatabase } from "../../../src/storage/repositories/index-connection";
import { getWorkflowTemplate } from "../../../src/workflows/authoring/authoring";
import { runWorkflowSteps } from "../../../src/workflows/exec/run-workflow";
import { listWorkflowRuns, startWorkflowRun } from "../../../src/workflows/runtime/runs";
import { loadWorkflowAsset } from "../../../src/workflows/runtime/workflow-asset-loader";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "../../_helpers/sandbox";

type AdapterId =
  | "agent-skills"
  | "akm"
  | "akm-task"
  | "akm-workflow"
  | "claude"
  | "dotenv"
  | "generic-files"
  | "okf"
  | "opencode";

interface Fixture {
  root: string;
  adapter: AdapterId;
}

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
});

afterEach(() => storage.cleanup());

function fixture(name: string, adapter: AdapterId): Fixture {
  const root = path.join(storage.root, name);
  fs.mkdirSync(root, { recursive: true });
  return { root, adapter };
}

function write(root: string, relativePath: string, content: string): string {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf8");
  return target;
}

function skill(name: string): string {
  return `---\nname: ${name}\ndescription: ${name} owner\n---\n\n# ${name}\n`;
}

function configure(early: Fixture, later: Fixture): void {
  writeSandboxConfig({
    semanticSearchMode: "off",
    defaultBundle: "early",
    bundles: {
      early: { path: early.root, adapter: early.adapter, writable: true },
      later: { path: later.root, adapter: later.adapter, writable: true },
    },
  });
  resetConfigCache();
}

function mutateEntry(itemRef: string, state: "complete" | "missing" | "stale", stalePath: string): void {
  if (state === "complete") return;
  const db = openExistingDatabase(getDbPath());
  try {
    if (state === "missing") db.prepare("DELETE FROM entries WHERE item_ref = ?").run(itemRef);
    if (state === "stale") db.prepare("UPDATE entries SET file_path = ? WHERE item_ref = ?").run(stalePath, itemRef);
  } finally {
    closeDatabase(db);
  }
}

/**
 * Snapshot state.db for a durable-no-mutation assertion.
 *
 * A plain `fs.readFileSync(getStateDbPath())` is racy under WAL mode: SQLite
 * may rewrite the file's raw bytes (checkpoint timing, change-counter bumps)
 * with no logical row change, so two byte-identical-looking no-op operations
 * can produce different file contents depending on when a checkpoint lands.
 * Forcing a `TRUNCATE` checkpoint before every snapshot collapses the WAL
 * back into the main file deterministically, so the byte comparison reflects
 * only genuine durable mutations — the thing this assertion is meant to
 * catch — not checkpoint scheduling.
 */
function stateDbSnapshot(): Buffer {
  withStateDb((db) => db.exec("PRAGMA wal_checkpoint(TRUNCATE)"));
  return fs.readFileSync(getStateDbPath());
}

function denyAssetRead(assetPath: string): ReturnType<typeof spyOn> {
  const original = fs.readFileSync;
  return spyOn(fs, "readFileSync").mockImplementation(((candidate, options) => {
    if (path.resolve(String(candidate)) === path.resolve(assetPath)) {
      throw new Error(`ownership arbitration must not read ${assetPath}`);
    }
    return original(candidate, options as never);
  }) as typeof fs.readFileSync);
}

const toolDirShapes = [
  ["claude", "commands/deploy", "commands/deploy.md", "# deploy"],
  ["claude", "agents/reviewer", "agents/reviewer.md", "# reviewer"],
  ["claude", "skills/audit", "skills/audit/SKILL.md", skill("audit")],
  ["claude", "CLAUDE", "CLAUDE.md", "# instructions"],
  ["opencode", "commands/deploy", "commands/deploy.md", "# deploy"],
  ["opencode", "agents/reviewer", "agents/reviewer.md", "# reviewer"],
  ["opencode", "skills/audit", "skills/audit/SKILL.md", skill("audit")],
  ["opencode", "AGENTS", "AGENTS.md", "# instructions"],
] as const;

const nonExtensionHintShapes = [
  ["akm", "skills/native-skill", "skills/native-skill/SKILL.md", skill("native-skill")],
  ["akm", "secrets/signing.key", "secrets/signing.key", "opaque-secret"],
  ["akm", "secrets/token", "secrets/token", "opaque-secret"],
  ["akm", "env/default", "env/.env", "TOKEN=hidden\n"],
  ["agent-skills", "portable-skill", "portable-skill/SKILL.md", skill("portable-skill")],
] as const;

describe("shared adapter physical-owner authority", () => {
  test.each([
    "complete",
    "missing",
    "stale",
  ] as const)("loose AKM smart-Markdown preserves the first owner with a %s row; show serves its file", async (state) => {
    const early = fixture(`early-loose-command-${state}`, "akm");
    const later = fixture(`later-loose-command-${state}`, "akm-workflow");
    const earlyPath = write(early.root, "same.md", "Use $ARGUMENTS exactly.\n");
    const laterPath = write(later.root, "commands/same.md", getWorkflowTemplate());
    configure(early, later);
    await akmIndex({ stashDir: early.root, full: true });
    mutateEntry("early//same", state, path.join(early.root, "stale", "same.md"));

    const found = await lookupBundleRef(parseBundleRef("same"));
    if (state === "complete") expect(found).toMatchObject({ filePath: earlyPath, conceptId: "same" });
    else expect(found).toBeNull();
    // Show resolves from the files: the first owner's file is served whatever its row says.
    expect((await showLocal({ ref: "same" })).path).toBe(earlyPath);
    expect(await lookupBundleRef(parseBundleRef("later//commands/same"))).toMatchObject({ filePath: laterPath });
  });

  test("a stale indexed identity for a workflow falls back to the physical owner instead of aborting", async () => {
    const early = fixture("early-workflow-stale", "akm-workflow");
    const later = fixture("later-workflow-stale", "akm");
    const workflowPath = write(early.root, "collision.md", getWorkflowTemplate());
    configure(early, later);
    await akmIndex({ stashDir: early.root, full: true });
    mutateEntry("early//collision", "stale", path.join(early.root, "stale", "collision.md"));

    const found = await lookupBundleRef(parseBundleRef("early//collision"));
    expect(found).toBeNull();

    const resolution = await lookupBundleRefWithResolution(parseBundleRef("early//collision"));
    expect(resolution.entry).toBeNull();
    expect(resolution.asset?.entry.file).toBe(workflowPath);
  });

  test.each([
    "missing",
    "stale",
  ] as const)("an earlier physical owner with a %s row blocks a lower unsupported-script diagnostic", async (state) => {
    const early = fixture(`early-script-diagnostic-${state}`, "okf");
    const later = fixture(`later-script-diagnostic-${state}`, "akm");
    const earlyPath = write(early.root, "scripts/readme.txt.md", "# EARLY_OWNER\n");
    write(later.root, "scripts/readme.txt", "LATE_UNSUPPORTED_SECRET\n");
    configure(early, later);
    await akmIndex({ stashDir: early.root, full: true });
    mutateEntry("early//scripts/readme.txt", state, path.join(early.root, "stale", "scripts", "readme.txt.md"));

    const shown = await showLocal({ ref: "scripts/readme.txt" });
    expect(shown.path).toBe(earlyPath);
    expect(JSON.stringify(shown)).not.toContain("LATE_UNSUPPORTED_SECRET");
  });

  test("show serves a missing index row from its file after one physical-owner probe", async () => {
    const early = fixture("early-single-owner-pass", "opencode");
    const later = fixture("later-single-owner-pass", "akm-workflow");
    const earlyPath = write(early.root, "skills/once/SKILL.md", skill("once"));
    write(later.root, "skills/once.md", getWorkflowTemplate());
    configure(early, later);
    await akmIndex({ stashDir: early.root, full: true });
    mutateEntry("early//skills/once", "missing", "");

    const candidateSpy = spyOn(opencodeAdapter as unknown as { readCandidates(): unknown }, "readCandidates");
    try {
      expect((await showLocal({ ref: "skills/once" })).path).toBe(earlyPath);
      expect(candidateSpy).toHaveBeenCalledTimes(1);
    } finally {
      candidateSpy.mockRestore();
    }
  });

  const looseOwnerCases: ReadonlyArray<
    readonly [surface: "load" | "start" | "run", state: "complete" | "missing" | "stale"]
  > = [
    ["load", "complete"],
    ["run", "stale"],
    ["load", "stale"],
  ];
  test.each(
    looseOwnerCases,
  )("%s rejects a loose AKM command owner with a %s row before mutation", async (surface, state) => {
    const early = fixture(`early-loose-runtime-${surface}-${state}`, "akm");
    const later = fixture(`later-loose-runtime-${surface}-${state}`, "akm-workflow");
    write(early.root, "same.md", "Use $ARGUMENTS exactly.\n");
    const laterPath = write(later.root, "commands/same.md", getWorkflowTemplate());
    configure(early, later);
    await akmIndex({ stashDir: early.root, full: true });
    mutateEntry("early//same", state, path.join(early.root, "stale", "same.md"));
    await listWorkflowRuns();
    const stateBefore = stateDbSnapshot();
    let dispatches = 0;

    // The loose file's type is the one thing read about it: that is how it is told from a workflow.
    const operation =
      surface === "load"
        ? loadWorkflowAsset("same")
        : surface === "start"
          ? startWorkflowRun("same")
          : runWorkflowSteps({
              target: "same",
              summaryJudge: null,
              dispatcher: async () => {
                dispatches++;
                return { ok: true as const, text: "unexpected" };
              },
            });
    await expect(operation).rejects.toThrow(/not a native workflow/i);
    expect(dispatches).toBe(0);
    expect(stateDbSnapshot()).toEqual(stateBefore);
    expect((await listWorkflowRuns()).runs).toHaveLength(0);
    expect((await loadWorkflowAsset("later//commands/same")).path).toBe(laterPath);
  });

  test.each([
    ".md",
    ".markdown",
    ".txt",
    ".text",
    ".MD",
    ".MARKDOWN",
    ".TXT",
    ".TEXT",
  ])("generic-files canonical document owner covers %s with a missing row; show serves its file", async (extension) => {
    const early = fixture(`early-generic-${extension.slice(1)}`, "generic-files");
    const later = fixture(`later-generic-${extension.slice(1)}`, "akm-workflow");
    const earlyPath = write(early.root, `docs/format${extension}`, "# generic document\n");
    const laterPath = write(later.root, "docs/format.md", getWorkflowTemplate());
    configure(early, later);
    await akmIndex({ stashDir: early.root, full: true });
    mutateEntry("early//docs/format", "missing", "");

    expect(await lookupBundleRef(parseBundleRef("docs/format"))).toBeNull();
    expect((await showLocal({ ref: "docs/format" })).path).toBe(earlyPath);
    expect(await lookupBundleRef(parseBundleRef("later//docs/format"))).toMatchObject({ filePath: laterPath });
  });

  test.each([
    "complete",
    "missing",
    "stale",
  ] as const)("dotenv env/.env is canonically env/default with a %s row", async (state) => {
    const early = fixture(`early-dotenv-default-${state}`, "dotenv");
    const later = fixture(`later-dotenv-default-${state}`, "akm-workflow");
    const earlyPath = write(early.root, "env/.env", "TOKEN=hidden\n");
    write(later.root, "env/default.md", getWorkflowTemplate());
    configure(early, later);
    await akmIndex({ stashDir: early.root, full: true });
    mutateEntry("early//env/default", state, path.join(early.root, "stale", ".env"));

    const found = await lookupBundleRef(parseBundleRef("env/default"));
    if (state === "complete") expect(found).toMatchObject({ filePath: earlyPath, conceptId: "env/default" });
    else expect(found).toBeNull();
    expect((await showLocal({ ref: "env/default" })).path).toBe(earlyPath);
  });

  test("a nested tool skill manifest cannot claim a deeper queried concept", async () => {
    const early = fixture("early-nested-tool-skill", "opencode");
    const later = fixture("later-nested-tool-skill", "akm-workflow");
    write(early.root, "skills/pkg/nested/SKILL.md", skill("nested"));
    const laterPath = write(later.root, "skills/pkg/nested.md", getWorkflowTemplate());
    configure(early, later);
    await akmIndex({ stashDir: early.root, full: true });

    expect(await lookupBundleRef(parseBundleRef("skills/pkg/nested"))).toMatchObject({ filePath: laterPath });
    expect((await showLocal({ ref: "skills/pkg/nested" })).path).toBe(laterPath);
    expect((await loadWorkflowAsset("skills/pkg/nested")).path).toBe(laterPath);
  });

  test("generic document collisions: the winner is no workflow, so runtime is refused without state, runs, or dispatch", async () => {
    const early = fixture("early-generic-collision", "generic-files");
    const later = fixture("later-generic-collision", "akm-workflow");
    write(early.root, "collision.md", "# markdown owner\n");
    write(early.root, "collision.txt", "text owner\n");
    const laterPath = write(later.root, "collision.md", getWorkflowTemplate());
    configure(early, later);
    await akmIndex({ stashDir: early.root, full: true });
    expect((await loadWorkflowAsset("later//collision")).path).toBe(laterPath);
    await listWorkflowRuns();
    const stateBefore = stateDbSnapshot();
    let dispatches = 0;

    await expect(loadWorkflowAsset("collision")).rejects.toThrow(/not a native workflow/i);
    await expect(startWorkflowRun("collision")).rejects.toThrow(/not a native workflow/i);
    await expect(
      runWorkflowSteps({
        target: "collision",
        summaryJudge: null,
        dispatcher: async () => {
          dispatches++;
          return { ok: true as const, text: "unexpected" };
        },
      }),
    ).rejects.toThrow(/not a native workflow/i);
    expect(dispatches).toBe(0);
    expect(stateDbSnapshot()).toEqual(stateBefore);
    expect((await listWorkflowRuns()).runs).toHaveLength(0);
  });

  test.each(
    toolDirShapes,
  )("physical-owner lookup honors %s read placement %s; show serves its file", async (adapter, conceptId, relativePath, content) => {
    const early = fixture(`early-${adapter}-${conceptId.replaceAll("/", "-")}`, adapter);
    const later = fixture(`later-${adapter}-${conceptId.replaceAll("/", "-")}`, adapter);
    const earlyPath = write(early.root, relativePath, content);
    const laterPath = write(later.root, relativePath, content.replaceAll("legacy", "later"));
    configure(early, later);
    await akmIndex({ stashDir: early.root, full: true });
    mutateEntry(`early//${conceptId}`, "missing", "");

    const readSpy = denyAssetRead(earlyPath);
    try {
      expect(await lookupBundleRef(parseBundleRef(conceptId))).toBeNull();
    } finally {
      readSpy.mockRestore();
    }
    expect((await showLocal({ ref: conceptId })).path).toBe(earlyPath);
    expect(await lookupBundleRef(parseBundleRef(`later//${conceptId}`))).toMatchObject({ filePath: laterPath });
  });

  test.each(
    nonExtensionHintShapes,
  )("physical-owner lookup honors %s authoritative placement %s; show serves its file", async (adapter, conceptId, relativePath, content) => {
    const early = fixture(`early-${adapter}-${conceptId.replaceAll("/", "-")}`, adapter);
    const later = fixture(`later-${adapter}-${conceptId.replaceAll("/", "-")}`, "akm-workflow");
    const earlyPath = write(early.root, relativePath, content);
    const laterPath = write(later.root, `${conceptId}.md`, getWorkflowTemplate());
    configure(early, later);
    await akmIndex({ stashDir: early.root, full: true });
    mutateEntry(`early//${conceptId}`, "missing", "");

    const readSpy = denyAssetRead(earlyPath);
    try {
      expect(await lookupBundleRef(parseBundleRef(conceptId))).toBeNull();
    } finally {
      readSpy.mockRestore();
    }
    expect((await showLocal({ ref: conceptId })).path).toBe(earlyPath);
    expect(await lookupBundleRef(parseBundleRef(`later//${conceptId}`))).toMatchObject({ filePath: laterPath });
  });

  test.each([
    "complete",
    "missing",
    "stale",
  ] as const)("complete/missing/stale first rows preserve the canonical owner and show serves its file: %s", async (state) => {
    const early = fixture(`early-row-${state}`, "opencode");
    const later = fixture(`later-row-${state}`, "opencode");
    const earlyPath = write(early.root, "skills/row-owner/SKILL.md", skill("row-owner"));
    write(later.root, "skills/row-owner/SKILL.md", skill("row-owner"));
    configure(early, later);
    await akmIndex({ stashDir: early.root, full: true });
    mutateEntry("early//skills/row-owner", state, path.join(early.root, "stale", "SKILL.md"));

    const found = await lookupBundleRef(parseBundleRef("skills/row-owner"));
    if (state === "complete") expect(found).toMatchObject({ filePath: earlyPath });
    else expect(found).toBeNull();
    expect((await showLocal({ ref: "skills/row-owner" })).path).toBe(earlyPath);
  });

  test.each([
    ["akm-task", "near", "near.yaml", "schedule: '* * * * *'\nprompt: nope\n"],
  ] as const)("path-level abstention in %s falls through consistently", async (adapter, conceptId, relativePath, content) => {
    const early = fixture(`early-abstain-${adapter}`, adapter);
    const later = fixture(`later-abstain-${adapter}`, "akm-workflow");
    write(early.root, relativePath, content);
    const laterPath = write(later.root, `${conceptId}.md`, getWorkflowTemplate());
    configure(early, later);
    await akmIndex({ stashDir: early.root, full: true });

    expect(await lookupBundleRef(parseBundleRef(conceptId))).toMatchObject({ filePath: laterPath });
    expect((await showLocal({ ref: conceptId })).path).toBe(laterPath);
    expect((await loadWorkflowAsset(conceptId)).path).toBe(laterPath);
  });

  test("a sensitive env file keeps its ref: a later bundle's asset does not take it over", async () => {
    const early = fixture("early-sensitive-dotenv", "dotenv");
    const later = fixture("later-sensitive-dotenv", "akm-workflow");
    write(early.root, "env/prod.env", "TOKEN=hidden\n");
    write(early.root, "env/prod.sensitive", "");
    write(later.root, "env/prod.md", getWorkflowTemplate());
    configure(early, later);
    await akmIndex({ stashDir: early.root, full: true });

    expect(await lookupBundleRef(parseBundleRef("env/prod"))).toBeNull();
  });

  test.each([
    ["load", "complete"],
    ["load", "stale"],
    ["start", "missing"],
    ["run", "stale"],
  ] as const)("%s rejects the first non-native canonical owner with a %s row before mutation", async (surface, state) => {
    const early = fixture(`early-runtime-${surface}-${state}`, "opencode");
    const later = fixture(`later-runtime-${surface}-${state}`, "akm-workflow");
    const earlyPath = write(early.root, "skills/runtime-owner/SKILL.md", skill("runtime-owner"));
    const laterPath = write(later.root, "skills/runtime-owner.md", getWorkflowTemplate());
    configure(early, later);
    await akmIndex({ stashDir: early.root, full: true });
    mutateEntry("early//skills/runtime-owner", state, path.join(early.root, "stale", "SKILL.md"));
    await listWorkflowRuns();
    const stateBefore = stateDbSnapshot();
    let dispatches = 0;

    const readSpy = denyAssetRead(earlyPath);
    try {
      const operation =
        surface === "load"
          ? loadWorkflowAsset("skills/runtime-owner")
          : surface === "start"
            ? startWorkflowRun("skills/runtime-owner")
            : runWorkflowSteps({
                target: "skills/runtime-owner",
                summaryJudge: null,
                dispatcher: async () => {
                  dispatches++;
                  return { ok: true as const, text: "unexpected" };
                },
              });
      await expect(operation).rejects.toThrow(/not a native workflow/i);
    } finally {
      readSpy.mockRestore();
    }
    expect(dispatches).toBe(0);
    expect(stateDbSnapshot()).toEqual(stateBefore);
    expect((await listWorkflowRuns()).runs).toHaveLength(0);
    expect((await loadWorkflowAsset("later//skills/runtime-owner")).path).toBe(laterPath);
  });
});
