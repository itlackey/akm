// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * A proposal an older akm recorded names files: `changes[].path/after`, `proposedTarget.root`,
 * `acceptedTarget.root/path` (§0.2 P5). The proposals repository reads it as the current record (refs, no files), says so
 * once per command, and never rewrites it on open; `akm migrate apply` rewrites it (`proposalRecords`), after which no
 * command warns. Opens the real state.db, so it lives under tests/integration/.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import {
  applyProposalRecordsMigration,
  inspectProposalRecordsMigration,
} from "../../../scripts/akm-migrate/proposal-records-migrate";
import { runMigration } from "../../../scripts/akm-migrate/run-migrate";
import { LEGACY_PROPOSAL_RECORDS_WARNING } from "../../../src/commands/proposal/legacy-records";
import { akmProposalAccept } from "../../../src/commands/proposal/proposal";
import { getProposal, listProposals } from "../../../src/commands/proposal/repository";
import { resetConfigCache } from "../../../src/core/config/config";
import { getStateDbPath, openStateDatabase } from "../../../src/core/state-db";
import { _resetWarnOnceForTests, _setWarnSinkForTests } from "../../../src/core/warn";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "../../_helpers/sandbox";
import { withSeam } from "../../_helpers/seams";

let storage: IsolatedAkmStorage;
let stash: string;

const NEW_ID = "00000000-0000-4000-8000-000000000011";
const DONE_ID = "00000000-0000-4000-8000-000000000012";
const DIR_ID = "00000000-0000-4000-8000-000000000013";
const NOTE = "---\ndescription: A new note\n---\n\n# New note\n\nBody.\n";
const HASH = `sha256:${"a".repeat(64)}`;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  stash = path.resolve(storage.stashDir);
  writeSandboxConfig({
    semanticSearchMode: "off",
    bundles: { work: { path: stash, writable: true } },
    defaultBundle: "work",
    defaultWriteTarget: "work",
  });
  resetConfigCache();
  _resetWarnOnceForTests();
  seed();
});

afterEach(() => {
  storage.cleanup();
  resetConfigCache();
  _resetWarnOnceForTests();
});

/** The rows as the release that wrote them left them. `DIR_ID` was made with `--dir`: it names the invented bundle `stash`. */
function seed(): void {
  const db = openStateDatabase(getStateDbPath());
  try {
    const insert = db.prepare(
      `INSERT INTO proposals
         (id, bundle_id, ref, status, source, created_at, updated_at, content, frontmatter_json, metadata_json)
       VALUES (?, ?, ?, ?, 'reflect', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', ?, NULL, ?)`,
    );
    insert.run(
      NEW_ID,
      "work",
      "work//knowledge/new-note",
      "pending",
      NOTE,
      JSON.stringify({
        changes: [{ path: "knowledge/new-note.md", op: "create" }],
        proposedTarget: { source: "work", root: stash },
      }),
    );
    insert.run(
      DONE_ID,
      "work",
      "work//knowledge/done",
      "accepted",
      NOTE,
      JSON.stringify({
        changes: [{ path: "knowledge/done.md", op: "update" }],
        proposedTarget: { source: "work", root: stash },
        acceptedTarget: {
          source: "work",
          root: stash,
          path: path.join(stash, "knowledge/done.md"),
          contentHash: HASH,
        },
      }),
    );
    insert.run(
      DIR_ID,
      "work",
      "work//knowledge/from-dir",
      "pending",
      NOTE,
      JSON.stringify({
        changes: [{ path: "knowledge/from-dir.md", op: "create" }],
        proposedTarget: { source: "stash", root: stash },
      }),
    );
  } finally {
    db.close();
  }
}

function rawMetadata(id: string): Record<string, unknown> {
  const db = openStateDatabase(getStateDbPath());
  try {
    const row = db.prepare("SELECT metadata_json FROM proposals WHERE id = ?").get(id) as { metadata_json: string };
    return JSON.parse(row.metadata_json) as Record<string, unknown>;
  } finally {
    db.close();
  }
}

async function warnings<T>(run: () => T | Promise<T>): Promise<{ result: T; warned: string[] }> {
  const warned: string[] = [];
  const result = await withSeam(
    _setWarnSinkForTests,
    (level, args) => {
      if (level === "warn") warned.push(args.map(String).join(" "));
    },
    run,
  );
  return { result, warned };
}

describe("a proposal recorded with files is read as the current record", () => {
  test("changes name refs, the target names the bundle, the accepted target names bundle and ref; one warning per command", async () => {
    const { result, warned } = await warnings(() => {
      const first = getProposal(stash, NEW_ID);
      const all = listProposals(stash, { includeArchive: true });
      return { first, all };
    });
    expect(result.first.changes).toEqual([{ ref: "work//knowledge/new-note", op: "create", content: NOTE }]);
    expect(result.first.proposedTarget).toEqual({ source: "work" });
    const done = result.all.find((p) => p.id === DONE_ID);
    expect(done?.changes).toEqual([{ ref: "work//knowledge/done", op: "update", content: NOTE }]);
    expect(done?.acceptedTarget).toEqual({ bundle: "work", ref: "work//knowledge/done", contentHash: HASH });
    expect(warned).toEqual([LEGACY_PROPOSAL_RECORDS_WARNING]);
  });

  test("a target that names the invented bundle `stash` is the bundle whose root it stored", () => {
    expect(getProposal(stash, DIR_ID).proposedTarget).toEqual({ source: "work" });
  });

  test("reading never rewrites the record, and opening state.db does not either", () => {
    const before = rawMetadata(NEW_ID);
    getProposal(stash, NEW_ID);
    listProposals(stash, { includeArchive: true });
    expect(rawMetadata(NEW_ID)).toEqual(before);
    expect(JSON.stringify(before)).toContain('"path":"knowledge/new-note.md"');
  });

  test("accepting it writes the asset and leaves the current record", async () => {
    const accepted = await akmProposalAccept({ stashDir: stash, id: NEW_ID });
    expect(fs.readFileSync(path.join(stash, "knowledge/new-note.md"), "utf8")).toContain("# New note");
    expect(accepted.proposal.acceptedTarget).toMatchObject({ bundle: "work", ref: "work//knowledge/new-note" });
    const stored = rawMetadata(NEW_ID);
    expect(JSON.stringify(stored)).not.toContain('"path"');
    expect(JSON.stringify(stored)).not.toContain('"root"');
    expect(stored.changes).toEqual([{ ref: "work//knowledge/new-note", op: "create" }]);
  });
});

describe("a proposal's findings and display paths name the bundle's file", () => {
  test("a task proposal's invalid source is reported at its bundle-relative file", async () => {
    const { validateProposal } = await import("../../../src/commands/proposal/validators/proposals");
    const proposal = {
      ...getProposal(stash, NEW_ID),
      ref: "work//tasks/newt",
      changes: [{ ref: "work//tasks/newt", op: "create" as const, content: "not: [valid" }],
      payload: { content: "not: [valid" },
    };
    const report = validateProposal(proposal);
    expect(report.findings.map((f) => f.message).join("\n")).toContain("tasks/newt.yml");
  });

  test("a proposal for a type its bundle's adapter does not write keeps its display path", async () => {
    const { diffLoadedProposal } = await import("../../../src/commands/proposal/repository");
    const { loadConfig } = await import("../../../src/core/config/config");
    writeSandboxConfig({
      bundles: {
        work: { path: stash, writable: true },
        dv: { path: path.join(storage.root, "dv"), adapter: "dotenv", writable: true },
      },
    });
    resetConfigCache();
    fs.mkdirSync(path.join(storage.root, "dv"), { recursive: true });
    const proposal = { ...getProposal(stash, NEW_ID), ref: "dv//knowledge/x", proposedTarget: { source: "dv" } };
    const diff = diffLoadedProposal(loadConfig(), proposal);
    const { createProposal } = await import("../../../src/commands/proposal/repository");
    const minted = createProposal(stash, {
      ref: "knowledge/x",
      source: "propose",
      target: { source: "dv", root: path.join(storage.root, "dv") },
      payload: { content: NOTE },
    });
    expect(minted.payload.content).toContain("type: knowledge");
    expect(diff.targetPath).toBe(path.join(storage.root, "dv", "knowledge", "x.md"));
  });
});

describe("akm migrate apply rewrites them (proposalRecords)", () => {
  test("a dry run counts the records and changes nothing", async () => {
    const before = rawMetadata(NEW_ID);
    const plan = await runMigration({ apply: false });
    expect(plan.proposalRecords).toMatchObject({ changed: 3, message: "proposal records: 3 to rewrite" });
    expect(plan.status).toBe("ready");
    expect(inspectProposalRecordsMigration().proposalRecords.changed).toBe(3);
    expect(rawMetadata(NEW_ID)).toEqual(before);
    expect(fs.existsSync(`${getStateDbPath()}.pre-proposal-records.bak`)).toBe(false);
  });

  test("apply rewrites every record in one go, after a copy of state.db; then no command warns", async () => {
    const result = applyProposalRecordsMigration();
    expect(result.status).toBe("current");
    expect(result.proposalRecords).toMatchObject({ changed: 3, applied: 3, message: "proposal records: 3 rewritten" });
    expect(fs.existsSync(`${getStateDbPath()}.pre-proposal-records.bak`)).toBe(true);
    expect(rawMetadata(NEW_ID).changes).toEqual([{ ref: "work//knowledge/new-note", op: "create" }]);
    expect(rawMetadata(NEW_ID).proposedTarget).toEqual({ source: "work" });
    expect(rawMetadata(DIR_ID).proposedTarget).toEqual({ source: "work" });
    expect(rawMetadata(DONE_ID).acceptedTarget).toEqual({
      bundle: "work",
      ref: "work//knowledge/done",
      contentHash: HASH,
    });

    const { warned } = await warnings(() => listProposals(stash, { includeArchive: true }));
    expect(warned).toEqual([]);
    expect(applyProposalRecordsMigration().proposalRecords).toMatchObject({ changed: 0 });
  });

  test("a read before and after the rewrite gives the same proposal", () => {
    const before = listProposals(stash, { includeArchive: true });
    applyProposalRecordsMigration();
    expect(listProposals(stash, { includeArchive: true })).toEqual(before);
  });
});

/**
 * A retire an older akm recorded: the accepted one names the archive directories it moved files into
 * (`retiredArchive.dirs`), the one caught mid-accept names the file it was moving (`retireAcceptIntent.assetPath`)
 * (§0.2 P5, P7). Both are read as the current record (`retiredArchive.retired`, an intent that names no file),
 * revert and accept work on them, and `akm migrate apply` rewrites them with the rest.
 */
describe("a retire recorded with files and directories", () => {
  const RETIRED_ID = "00000000-0000-4000-8000-000000000021";
  const MID_ID = "00000000-0000-4000-8000-000000000022";
  const ARCHIVE = ".akm/memory-cleanup/archive/2026-01-05T00-00-00-000Z-work-memories-old-note";
  const OLD = "---\ndescription: An old note\n---\n\nOld body.\n";

  function seedRetires(): void {
    fs.mkdirSync(path.join(stash, ARCHIVE, "memories"), { recursive: true });
    fs.writeFileSync(path.join(stash, ARCHIVE, "memories/old-note.md"), OLD);
    fs.writeFileSync(
      path.join(stash, ARCHIVE, "cleanup.md"),
      `---\nschemaVersion: 1\nkind: memory-cleanup-archive\nref: work//memories/old-note\nreason: manual\noriginalPath: memories/old-note.md\narchivedPath: ${ARCHIVE}/memories/old-note.md\n---\n\nArchived.\n`,
    );
    fs.mkdirSync(path.join(stash, "memories"), { recursive: true });
    fs.writeFileSync(path.join(stash, "memories/mid.md"), OLD);
    const db = openStateDatabase(getStateDbPath());
    try {
      const insert = db.prepare(
        `INSERT INTO proposals
           (id, bundle_id, ref, status, source, created_at, updated_at, content, frontmatter_json, metadata_json)
         VALUES (?, ?, ?, ?, 'consolidate', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '', NULL, ?)`,
      );
      insert.run(
        RETIRED_ID,
        "work",
        "work//memories/old-note",
        "accepted",
        JSON.stringify({
          changes: [{ path: "memories/old-note.md", op: "delete" }],
          proposedTarget: { source: "work", root: stash },
          backupContent: OLD,
          acceptedTarget: {
            source: "work",
            root: stash,
            path: path.join(stash, "memories/old-note.md"),
            contentHash: HASH,
          },
          retiredArchive: { dirs: [ARCHIVE] },
        }),
      );
      insert.run(
        MID_ID,
        "work",
        "work//memories/mid",
        "pending",
        JSON.stringify({
          changes: [{ path: "memories/mid.md", op: "delete" }],
          proposedTarget: { source: "work", root: stash },
          retireAcceptIntent: { assetPath: path.join(stash, "memories/mid.md"), backupContent: OLD },
        }),
      );
    } finally {
      db.close();
    }
  }

  beforeEach(seedRetires);

  test("the archive is a list of { ref, handle }, the intent names no file, and a command warns once", async () => {
    const { result, warned } = await warnings(() => ({
      done: getProposal(stash, RETIRED_ID),
      mid: getProposal(stash, MID_ID),
    }));
    expect(result.done.retiredArchive).toEqual({ retired: [{ ref: "work//memories/old-note", handle: ARCHIVE }] });
    expect(result.mid.retireAcceptIntent).toEqual({ backupContent: OLD });
    expect(warned).toEqual([LEGACY_PROPOSAL_RECORDS_WARNING]);
  });

  test("reverting the old record puts the file back from the archive it names", async () => {
    const { akmProposalRevert } = await import("../../../src/commands/proposal/proposal");
    await akmProposalRevert({ stashDir: stash, id: RETIRED_ID });
    expect(fs.readFileSync(path.join(stash, "memories/old-note.md"), "utf8")).toBe(OLD);
    expect(fs.existsSync(path.join(stash, ARCHIVE))).toBe(false);
    expect(getProposal(stash, RETIRED_ID).status).toBe("reverted");
  });

  test("an archive directory recorded with `\\` separators (an akm on Windows) is read as the same handle, and reverts", async () => {
    const db = openStateDatabase(getStateDbPath());
    try {
      const row = db.prepare("SELECT metadata_json FROM proposals WHERE id = ?").get(RETIRED_ID) as {
        metadata_json: string;
      };
      const meta = JSON.parse(row.metadata_json) as Record<string, unknown>;
      meta.retiredArchive = { dirs: [ARCHIVE.replaceAll("/", "\\")] };
      db.prepare("UPDATE proposals SET metadata_json = ? WHERE id = ?").run(JSON.stringify(meta), RETIRED_ID);
    } finally {
      db.close();
    }
    expect(getProposal(stash, RETIRED_ID).retiredArchive).toEqual({
      retired: [{ ref: "work//memories/old-note", handle: ARCHIVE }],
    });
    const { akmProposalRevert } = await import("../../../src/commands/proposal/proposal");
    await akmProposalRevert({ stashDir: stash, id: RETIRED_ID });
    expect(fs.readFileSync(path.join(stash, "memories/old-note.md"), "utf8")).toBe(OLD);
    expect(fs.existsSync(path.join(stash, ARCHIVE))).toBe(false);
  });

  test("accepting the one caught mid-accept finishes it and stores the current record", async () => {
    const accepted = await akmProposalAccept({ stashDir: stash, id: MID_ID });
    expect(accepted.proposal.status).toBe("accepted");
    expect(fs.existsSync(path.join(stash, "memories/mid.md"))).toBe(false);
    const stored = rawMetadata(MID_ID);
    expect(JSON.stringify(stored)).not.toContain("assetPath");
    expect(JSON.stringify(stored)).not.toContain('"dirs"');
    const archive = stored.retiredArchive as { retired: Array<{ ref: string; handle: string }> };
    expect(archive.retired).toHaveLength(1);
    expect(archive.retired[0]?.ref).toBe("work//memories/mid");
    expect(archive.retired[0]?.handle).toMatch(/-memories-mid$/); // a concept id, not `work-memories-mid` (N11)
  });

  test("a dry run counts them with the others, and apply rewrites them", () => {
    expect(inspectProposalRecordsMigration().proposalRecords.changed).toBe(5);
    const result = applyProposalRecordsMigration();
    expect(result.proposalRecords).toMatchObject({ changed: 5, applied: 5 });
    expect(rawMetadata(RETIRED_ID).retiredArchive).toEqual({
      retired: [{ ref: "work//memories/old-note", handle: ARCHIVE }],
    });
    expect(rawMetadata(MID_ID).retireAcceptIntent).toEqual({ backupContent: OLD });
    expect(inspectProposalRecordsMigration().proposalRecords.changed).toBe(0);
  });

  test("renaming the bundle renames the ref each retirement holds", async () => {
    const { renameProposalsBundleRef } = await import("../../../src/storage/repositories/proposals-repository");
    applyProposalRecordsMigration();
    const db = openStateDatabase(getStateDbPath());
    try {
      renameProposalsBundleRef(db, "work", "team");
    } finally {
      db.close();
    }
    expect(rawMetadata(RETIRED_ID).retiredArchive).toEqual({
      retired: [{ ref: "team//memories/old-note", handle: ARCHIVE }],
    });
  });
});
