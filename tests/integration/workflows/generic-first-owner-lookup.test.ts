// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmShowUnified, showByRef, showLocal } from "../../../src/commands/read/show";
import { parseBundleRef } from "../../../src/core/asset/asset-ref";
import { resetConfigCache } from "../../../src/core/config/config";
import { getDbPath } from "../../../src/core/paths";
import { getStateDbPath } from "../../../src/core/state-db";
import { akmIndex, lookupBundleRef } from "../../../src/indexer/indexer";
import { closeDatabase, openExistingDatabase } from "../../../src/storage/repositories/index-connection";
import { getWorkflowTemplate } from "../../../src/workflows/authoring/authoring";
import { startWorkflowRun } from "../../../src/workflows/runtime/runs";
import { loadWorkflowAsset } from "../../../src/workflows/runtime/workflow-asset-loader";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "../../_helpers/sandbox";

interface BundleFixture {
  root: string;
  adapter: "agent-skills" | "akm" | "akm-workflow" | "okf";
}

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
});

afterEach(() => storage.cleanup());

function write(root: string, relativePath: string, content: string): string {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf8");
  return target;
}

function genericDocument(marker: string): string {
  return `---\ntype: knowledge\ntitle: ${marker}\n---\n\n# ${marker}\n\n${marker}\n`;
}

function skillDocument(name: string, marker: string): string {
  return `---\nname: ${name}\ndescription: ${marker}\n---\n\n# ${marker}\n`;
}

function configure(early: BundleFixture, later: BundleFixture): void {
  writeSandboxConfig({
    semanticSearchMode: "off",
    defaultBundle: "early",
    bundles: {
      early: {
        path: early.root,
        components: { main: { root: ".", adapter: early.adapter, writable: true } },
      },
      later: {
        path: later.root,
        components: { main: { root: ".", adapter: later.adapter, writable: true } },
      },
    },
  });
  resetConfigCache();
}

function fixture(name: string, adapter: BundleFixture["adapter"]): BundleFixture {
  const root = path.join(storage.root, name);
  fs.mkdirSync(root, { recursive: true });
  return { root, adapter };
}

function deleteIndexEntry(itemRef: string): void {
  const db = openExistingDatabase(getDbPath());
  try {
    db.prepare("DELETE FROM entries WHERE item_ref = ?").run(itemRef);
  } finally {
    closeDatabase(db);
  }
}

describe("generic lookup/show installation-priority ownership", () => {
  test.each([
    {
      label: "an AKM skill package directory",
      adapter: "akm" as const,
      conceptId: "skills/physical-owner",
      relativePath: "skills/physical-owner/SKILL.md",
      content: skillDocument("physical-owner", "EARLY_AKM_SKILL"),
    },
    {
      label: "an AKM secret with an unlisted extension",
      adapter: "akm" as const,
      conceptId: "secrets/physical-owner.key",
      relativePath: "secrets/physical-owner.key",
      content: "EARLY_AKM_KEY_SECRET",
    },
    {
      label: "an AKM extensionless secret",
      adapter: "akm" as const,
      conceptId: "secrets/physical-owner",
      relativePath: "secrets/physical-owner",
      content: "EARLY_AKM_EXTENSIONLESS_SECRET",
    },
    {
      label: "the AKM default environment alias",
      adapter: "akm" as const,
      conceptId: "env/default",
      relativePath: "env/.env",
      content: "PHYSICAL_OWNER_ENV=early",
    },
    {
      label: "an Agent Skills package directory",
      adapter: "agent-skills" as const,
      conceptId: "physical-owner",
      relativePath: "physical-owner/SKILL.md",
      content: skillDocument("physical-owner", "EARLY_AGENT_SKILL"),
    },
  ])("a missing first index row still stops at $label without rendering its physical file", async (shape) => {
    const early = fixture(`early-${shape.adapter}-${shape.conceptId.replaceAll("/", "-")}`, shape.adapter);
    const later = fixture(`later-${shape.adapter}-${shape.conceptId.replaceAll("/", "-")}`, shape.adapter);
    const earlyPath = write(early.root, shape.relativePath, shape.content);
    const laterPath = write(later.root, shape.relativePath, shape.content.replaceAll("EARLY", "LATER"));
    configure(early, later);
    await akmIndex({ stashDir: early.root, full: true });

    expect(await lookupBundleRef(parseBundleRef(shape.conceptId))).toMatchObject({
      filePath: earlyPath,
      adapterId: shape.adapter,
    });
    deleteIndexEntry(`early//${shape.conceptId}`);

    const originalReadFileSync = fs.readFileSync;
    const readSpy = spyOn(fs, "readFileSync").mockImplementation(((candidate, options) => {
      if (path.resolve(String(candidate)) === path.resolve(earlyPath)) {
        throw new Error(`physical ownership must not read ${earlyPath}`);
      }
      return originalReadFileSync(candidate, options as never);
    }) as typeof fs.readFileSync);
    try {
      expect(await lookupBundleRef(parseBundleRef(shape.conceptId))).toBeNull();
    } finally {
      readSpy.mockRestore();
    }
    await expect(showByRef(shape.conceptId)).rejects.toThrow(/not found/i);
    await expect(showLocal({ ref: shape.conceptId })).rejects.toThrow(/not found/i);
    expect(await lookupBundleRef(parseBundleRef(`later//${shape.conceptId}`))).toMatchObject({
      filePath: laterPath,
      adapterId: shape.adapter,
    });
  });

  test.each([
    ["commands/read-free", "commands/read-free.md", genericDocument("EARLY_COMMAND")],
    ["agents/read-free", "agents/read-free.md", genericDocument("EARLY_AGENT")],
    ["env/prod", "env/prod.env", "READ_FREE_ENV=early"],
  ])("physical-owner arbitration for %s does not read or parse asset bytes", async (conceptId, relativePath, content) => {
    const early = fixture(`early-${conceptId.replaceAll("/", "-")}`, "akm");
    const later = fixture(`later-${conceptId.replaceAll("/", "-")}`, "akm");
    const earlyPath = write(early.root, relativePath, content);
    write(later.root, relativePath, content.replaceAll("early", "later").replaceAll("EARLY", "LATER"));
    configure(early, later);
    await akmIndex({ stashDir: early.root, full: true });
    deleteIndexEntry(`early//${conceptId}`);

    const originalReadFileSync = fs.readFileSync;
    const readSpy = spyOn(fs, "readFileSync").mockImplementation(((candidate, options) => {
      if (path.resolve(String(candidate)) === path.resolve(earlyPath)) {
        throw new Error(`physical ownership must not read ${earlyPath}`);
      }
      return originalReadFileSync(candidate, options as never);
    }) as typeof fs.readFileSync);
    try {
      expect(await lookupBundleRef(parseBundleRef(conceptId))).toBeNull();
    } finally {
      readSpy.mockRestore();
    }
  });

  test("an earlier bundle's symlinked placement owns the ref and is indexed (#1237)", async () => {
    const early = fixture("early-linked-skill", "akm");
    const later = fixture("later-after-linked-skill", "akm");
    const outsidePath = write(storage.root, "outside/SKILL.md", skillDocument("linked", "OUTSIDE_BYTES"));
    const authoredPath = path.join(early.root, "skills", "linked", "SKILL.md");
    fs.mkdirSync(path.dirname(authoredPath), { recursive: true });
    fs.symlinkSync(outsidePath, authoredPath);
    write(later.root, "skills/linked/SKILL.md", skillDocument("linked", "LATER_OWNER"));
    configure(early, later);
    await akmIndex({ stashDir: early.root, full: true });

    // Installation priority decides, as for any other file: the earlier bundle's
    // symlink owns the ref, and it is indexed rather than hiding the later copy.
    expect(await lookupBundleRef(parseBundleRef("skills/linked"))).toMatchObject({ filePath: authoredPath });
  });

  test("an AKM reserved index.md abstains and allows a later owner", async () => {
    const early = fixture("early-akm-reserved", "akm");
    const later = fixture("later-standalone-index", "akm-workflow");
    write(early.root, "knowledge/index.md", "# Reserved structural index\n");
    const laterPath = write(later.root, "knowledge/index.md", getWorkflowTemplate());
    configure(early, later);
    await akmIndex({ stashDir: early.root, full: true });

    expect(await lookupBundleRef(parseBundleRef("knowledge/index"))).toMatchObject({ filePath: laterPath });
  });

  test("an unqualified generic read keeps the first OKF owner while runtime rejects it and qualified native remains valid", async () => {
    const early = fixture("early-okf", "okf");
    const later = fixture("later-native", "akm");
    const earlyPath = write(early.root, "workflows/same.md", genericDocument("EARLY_OKF_OWNER"));
    const laterPath = write(later.root, "workflows/same.md", getWorkflowTemplate());
    configure(early, later);
    await akmIndex({ stashDir: early.root, full: true });

    const indexed = await lookupBundleRef(parseBundleRef("workflows/same"));
    expect(indexed).toMatchObject({ filePath: earlyPath, adapterId: "okf", itemRef: "early//workflows/same" });

    const shown = await akmShowUnified({ ref: "workflows/same", skipLogging: true });
    expect(shown).toMatchObject({ path: earlyPath, ref: "workflows/same" });
    expect(shown.content).toContain("EARLY_OKF_OWNER");
    expect(await showByRef("workflows/same")).toMatchObject({ filePath: earlyPath });

    deleteIndexEntry("early//workflows/same");
    expect(await lookupBundleRef(parseBundleRef("workflows/same"))).toBeNull();
    await expect(showLocal({ ref: "workflows/same" })).rejects.toThrow(/not found/i);

    const stateBeforeRuntimeRejection = fs.readFileSync(getStateDbPath());
    await expect(loadWorkflowAsset("workflows/same")).rejects.toThrow(
      /adapter "okf".*does not support native workflow execution/i,
    );
    await expect(startWorkflowRun("workflows/same")).rejects.toThrow(
      /adapter "okf".*does not support native workflow execution/i,
    );
    expect(fs.readFileSync(getStateDbPath())).toEqual(stateBeforeRuntimeRejection);

    expect(await lookupBundleRef(parseBundleRef("later//workflows/same"))).toMatchObject({
      filePath: laterPath,
      adapterId: "akm",
    });
    expect((await akmShowUnified({ ref: "later//workflows/same", skipLogging: true })).path).toBe(laterPath);
    expect((await loadWorkflowAsset("later//workflows/same")).path).toBe(laterPath);
  });

  test("an established earlier OKF owner is insulated from a lower bundle's own resolvable .md/.yml domain", async () => {
    const early = fixture("early-okf-collision", "okf");
    const later = fixture("later-native-collision", "akm");
    const earlyPath = write(early.root, "workflows/same.md", genericDocument("EARLY_INSULATED_OWNER"));
    const laterPath = write(later.root, "workflows/same.md", getWorkflowTemplate());
    write(
      later.root,
      "workflows/same.yml",
      "name: lower-collision\non: { workflow_dispatch: null }\njobs: { main: { runs-on: [self-hosted], steps: [] } }\n",
    );
    configure(early, later);
    await akmIndex({ stashDir: early.root, full: true });

    expect(await lookupBundleRef(parseBundleRef("workflows/same"))).toMatchObject({
      filePath: earlyPath,
      adapterId: "okf",
    });
    expect((await showLocal({ ref: "workflows/same" })).content).toContain("EARLY_INSULATED_OWNER");
    deleteIndexEntry("early//workflows/same");
    expect(await lookupBundleRef(parseBundleRef("workflows/same"))).toBeNull();
    await expect(showLocal({ ref: "workflows/same" })).rejects.toThrow(/not found/i);
    const stateBeforeRuntimeRejection = fs.readFileSync(getStateDbPath());
    await expect(loadWorkflowAsset("workflows/same")).rejects.toThrow(/adapter "okf"/i);
    expect(fs.readFileSync(getStateDbPath())).toEqual(stateBeforeRuntimeRejection);

    expect(await lookupBundleRef(parseBundleRef("later//workflows/same"))).toMatchObject({
      filePath: laterPath,
      adapterId: "akm",
    });
    expect((await showLocal({ ref: "later//workflows/same" })).path).toBe(laterPath);
  });

  test("an absent or reserved earlier OKF concept allows fallback to the later native owner", async () => {
    const early = fixture("early-okf-fallback", "okf");
    const later = fixture("later-standalone-fallback", "akm-workflow");
    write(early.root, "index.md", "# Reserved structural index\n");
    const absentPath = write(later.root, "absent.md", getWorkflowTemplate());
    const indexPath = write(later.root, "index.md", getWorkflowTemplate());
    configure(early, later);
    await akmIndex({ stashDir: early.root, full: true });

    expect(await lookupBundleRef(parseBundleRef("absent"))).toMatchObject({
      filePath: absentPath,
      adapterId: "akm-workflow",
    });
    expect((await showLocal({ ref: "absent" })).path).toBe(absentPath);
    expect((await loadWorkflowAsset("absent")).path).toBe(absentPath);

    expect(await lookupBundleRef(parseBundleRef("index"))).toMatchObject({
      filePath: indexPath,
      adapterId: "akm-workflow",
    });
    expect((await showLocal({ ref: "index" })).path).toBe(indexPath);
    expect((await loadWorkflowAsset("index")).path).toBe(indexPath);
  });

  test("a missing first-native index row cannot retarget lookup to a lower indexed owner or render an unindexed file", async () => {
    const early = fixture("early-native-stale-index", "akm");
    const later = fixture("later-native-stale-index", "akm");
    write(early.root, "workflows/stale.md", getWorkflowTemplate());
    write(later.root, "workflows/stale.md", getWorkflowTemplate());
    configure(early, later);
    await akmIndex({ stashDir: early.root, full: true });

    deleteIndexEntry("early//workflows/stale");

    expect(await lookupBundleRef(parseBundleRef("workflows/stale"))).toBeNull();
    await expect(showByRef("workflows/stale")).rejects.toThrow(/not found/i);
    await expect(showLocal({ ref: "workflows/stale" })).rejects.toThrow(/not found/i);
  });
});
