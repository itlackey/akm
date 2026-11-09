// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * #1432: an existing asset is written through its ref, the path, and its type
 * comes from its file, wherever it sits. Improve plans it, a proposal updates
 * or retires that file (no skip, no refusal, no second file), and revert puts
 * it back. Placement under a type folder is only for a new asset.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { contentHash } from "../../src/commands/improve/content-hash";
import { collectEligibleRefs } from "../../src/commands/improve/eligibility";
import { resolveImproveStrategy, shouldSkipRef } from "../../src/commands/improve/improve-strategies";
import { akmProposalAccept, akmProposalRevert } from "../../src/commands/proposal/proposal";
import { createProposal, createRetireProposal, getProposal } from "../../src/commands/proposal/repository";
import { saveConfig } from "../../src/core/config/config";
import { akmIndex } from "../../src/indexer/indexer";
import { resolveWriteAddress } from "../../src/indexer/lookup/adapter-concept-owner";
import { makeConfig } from "../_helpers/factories";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../_helpers/sandbox";

let storage: IsolatedAkmStorage;
let stash = "";

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  stash = storage.stashDir;
});

afterEach(() => storage.cleanup());

function write(rel: string, content: string): string {
  const file = path.join(stash, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

/** Every file in the bundle outside akm's own dot folders: a second copy of an asset would show here. */
function assetFiles(): string[] {
  return fs
    .readdirSync(stash, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(stash, path.join(entry.parentPath, entry.name)))
    .filter((rel) => !rel.split(path.sep).some((segment) => segment.startsWith(".")))
    .sort();
}

async function index(): Promise<void> {
  saveConfig({
    semanticSearchMode: "off",
    bundles: { stash: { path: stash, writable: true } },
    defaultBundle: "stash",
  });
  await akmIndex({ stashDir: stash, full: true });
}

const NOTE = "---\ndescription: Release notes for the deploy\n---\n# Release\n\nDeploys run at noon.\n";
const UPDATED = "---\ndescription: Release notes for the deploy\n---\n# Release\n\nDeploys run at one.\n";

// A loose note, a knowledge README in a task folder, and a note at the bundle root.
const LOOSE: Array<[rel: string, ref: string]> = [
  ["reports/release.md", "reports/release"],
  ["tasks/README.md", "tasks/README"],
  ["release.md", "release"],
];

describe("the write address of an existing asset", () => {
  test.each(LOOSE)("%s is written at its own file, with the type its file is recognized as", async (rel, ref) => {
    const file = write(rel, NOTE);
    expect(resolveWriteAddress(stash, ref)).toMatchObject({ type: "knowledge", conceptId: ref, path: file });
  });

  test("its ref in the outdated type-folder spelling writes the same file", () => {
    const file = write("reports/release.md", NOTE);
    expect(resolveWriteAddress(stash, "knowledge/reports/release")).toMatchObject({
      type: "knowledge",
      conceptId: "reports/release",
      path: file,
    });
  });

  test("a new asset is placed in its ref's type folder", () => {
    expect(resolveWriteAddress(stash, "lessons/new-one")).toMatchObject({
      type: "lesson",
      conceptId: "lessons/new-one",
      path: path.join(stash, "lessons", "new-one.md"),
    });
  });
});

describe("improve plans a loose asset with its indexed type", () => {
  test.each(LOOSE)("%s is planned as knowledge and reflect does not skip it", async (rel, ref) => {
    write(rel, NOTE);
    await index();
    const { plannedRefs } = await collectEligibleRefs({ mode: "all" }, stash, {});
    const planned = plannedRefs.find((entry) => entry.ref === ref);
    expect(planned).toMatchObject({ ref, type: "knowledge", filePath: path.join(stash, rel) });
    const strategy = resolveImproveStrategy(undefined, makeConfig(stash)).config;
    expect(shouldSkipRef(planned!, "reflect", strategy).skip).toBe(false);
  });
});

describe("a proposal for a loose asset", () => {
  test.each(LOOSE)("%s: propose updates its file, accept writes it, revert restores it", async (rel, ref) => {
    const file = write(rel, NOTE);
    await index();
    const proposal = createProposal(stash, { ref, source: "reflect", payload: { content: UPDATED } });
    expect(proposal.ref).toBe(`stash//${ref}`);
    expect(proposal.changes).toEqual([expect.objectContaining({ path: rel, op: "update" })]);

    const config = makeConfig(stash);
    const before = assetFiles();
    await akmProposalAccept({ stashDir: stash, id: proposal.id, config });
    expect(fs.readFileSync(file, "utf8")).toContain("Deploys run at one.");
    expect(assetFiles()).toEqual(before);

    await akmProposalRevert({ stashDir: stash, id: proposal.id, config });
    expect(fs.readFileSync(file, "utf8")).toBe(NOTE);
  });

  test("retire archives the loose file, and revert brings it back", async () => {
    const retired = write("reports/old.md", NOTE);
    const successor = write("reports/new.md", UPDATED);
    await index();
    const proposal = createRetireProposal(stash, {
      ref: "reports/old",
      source: "consolidate-pair",
      retirement: {
        retiredRef: "reports/old",
        successorRef: "reports/new",
        cosine: 0.94,
        judgeLabel: "duplicate",
        judgeReason: "Same facts.",
        judgedScope: {},
        retiredContentHash: contentHash(fs.readFileSync(retired, "utf8"), "body"),
        successorContentHash: contentHash(fs.readFileSync(successor, "utf8"), "body"),
        reason: "duplicate",
      },
    });
    expect(proposal.changes).toEqual([{ path: "reports/old.md", op: "delete" }]);

    const config = makeConfig(stash);
    await akmProposalAccept({ stashDir: stash, id: proposal.id, config });
    expect(fs.existsSync(retired)).toBe(false);
    expect(getProposal(stash, proposal.id).retiredArchive?.dirs).toHaveLength(1);

    await akmProposalRevert({ stashDir: stash, id: proposal.id, config });
    expect(fs.readFileSync(retired, "utf8")).toBe(NOTE);
  });
});
