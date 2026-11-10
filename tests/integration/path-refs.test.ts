import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { contentHash } from "../../src/commands/improve/content-hash";
import { collectEligibleRefs } from "../../src/commands/improve/eligibility";
import { resolveImproveStrategy, shouldSkipRef } from "../../src/commands/improve/improve-strategies";
import { akmProposalAccept, akmProposalRevert } from "../../src/commands/proposal/proposal";
import { createProposal, createRetireProposal, getProposal } from "../../src/commands/proposal/repository";
import { akmShowUnified } from "../../src/commands/read/show";
import { saveConfig } from "../../src/core/config/config";
import { _resetWarnOnceForTests, _setWarnSinkForTests } from "../../src/core/warn";
import { akmIndex } from "../../src/indexer/indexer";
import { resolveWriteAddress } from "../../src/indexer/lookup/adapter-concept-owner";
import { makeConfig } from "../_helpers/factories";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "../_helpers/sandbox";
import { withSeam } from "../_helpers/seams";

describe("path-refs-upgrade", () => {
  // Classification (tests/integration/ iff it opens a real database): opens index.db and state.db.

  /**
   * A file outside its type folder had the ref `<type folder>/<its path>` before refs became bundle-relative paths.
   * The runtime still resolves the old spelling (show, links authored with it); re-keying the history stored under it
   * is the migrator's job (tests/migrate/asset-content-refs.test.ts).
   */

  let storage: IsolatedAkmStorage;

  beforeEach(() => {
    storage = withIsolatedAkmStorage();
    writeSandboxConfig({ semanticSearchMode: "off" });
    _resetWarnOnceForTests();
  });

  afterEach(() => storage.cleanup());

  function write(rel: string, body: string): string {
    const file = path.join(storage.stashDir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `---\ndescription: ${body}\n---\n\n# ${body}\n`);
    return file;
  }

  describe("show resolves a loose file by its path", () => {
    test("the path ref shows it; the old spelling shows it too, and warns once that it is outdated", async () => {
      write("reports/x.md", "quarterly report");
      await akmIndex({ stashDir: storage.stashDir, full: true });

      const shown = await akmShowUnified({ ref: "reports/x", readOnly: true });
      expect(shown.ref).toBe("reports/x");
      expect(shown.type).toBe("knowledge");

      const warnings: string[] = [];
      await withSeam(
        _setWarnSinkForTests,
        (level, args) => {
          if (level === "warn") warnings.push(args.map(String).join(" "));
        },
        async () => {
          const old = await akmShowUnified({ ref: "knowledge/reports/x", readOnly: true });
          expect(old.path).toBe(shown.path);
          await akmShowUnified({ ref: "knowledge/reports/x", readOnly: true });
        },
      );
      expect(warnings.filter((w) => /outdated/.test(w))).toHaveLength(1);
    });
  });

  describe("links authored with the old spelling", () => {
    test("resolve to the loose file in both directions", async () => {
      write("reports/x.md", "quarterly report");
      const citer = path.join(storage.stashDir, "memories", "citer.md");
      fs.mkdirSync(path.dirname(citer), { recursive: true });
      fs.writeFileSync(citer, "---\ndescription: cites a report\nxrefs:\n  - knowledge/reports/x\n---\n\n# Cites\n");
      await akmIndex({ stashDir: storage.stashDir, full: true });

      const outgoing = await akmShowUnified({ ref: "memories/citer", readOnly: true });
      expect(outgoing.links).toEqual({ outgoing: { xref: { total: 1, refs: ["reports/x"] } } });
      const incoming = await akmShowUnified({ ref: "reports/x", readOnly: true });
      expect(incoming.links).toEqual({ incoming: { xref: { total: 1, refs: ["memories/citer"] } } });
    });
  });
});

describe("path-refs-writes", () => {
  /**
   * #1432: an existing asset is written through its ref, the path, and its type
   * comes from its file, wherever it sits. Improve plans it, a proposal updates
   * or retires that file (no skip, no refusal, no second file), and revert puts
   * it back. Placement under a type folder is only for a new asset.
   */

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
});
