// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * A pending proposal recorded before concept IDs (#1513): its `ref` is the
 * retired `<type>:<name>` grammar and its metadata has no `changes` or
 * `proposedTarget`. The supported commands read it as written, `reject`
 * archives it with its content, ref and decision kept, and `accept` and the
 * drain never apply it. Opens the real state.db, so it lives under
 * tests/integration/.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { drainProposals } from "../../../src/commands/proposal/drain";
import {
  akmProposalAccept,
  akmProposalReject,
  akmProposalShow,
  type ProposalAcceptResult,
  type ProposalRejectResult,
} from "../../../src/commands/proposal/proposal";
import { createProposal, getProposal, listProposals, type Proposal } from "../../../src/commands/proposal/repository";
import { AkmError } from "../../../src/core/errors";
import { readEvents } from "../../../src/core/events";
import { getStateDbPath, openStateDatabase } from "../../../src/core/state-db";
import { _resetWarnOnceForTests, _setWarnSinkForTests } from "../../../src/core/warn";
import type { ProposalRow } from "../../../src/storage/repositories/proposals-repository";
import { makeConfig } from "../../_helpers/factories";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../../_helpers/sandbox";
import { withSeam } from "../../_helpers/seams";

let storage: IsolatedAkmStorage;
let stash: string;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  stash = path.resolve(storage.stashDir);
  _resetWarnOnceForTests();
});

afterEach(() => {
  storage.cleanup();
  _resetWarnOnceForTests();
});

const LEGACY_ID = "00000000-0000-4000-8000-000000000001";
const LEGACY_REF = "lesson:example-legacy-note";
const LEGACY_CONTENT = "Synthetic legacy content; no private source text.";
const VALID_LESSON = `---\ndescription: Use ripgrep before grep\nwhen_to_use: Searching large repos for patterns\n---\n\nPrefer rg over grep when scanning large code repos.\n`;

/** The row from the issue, inserted the way the release that wrote it left it: no current envelope at all. */
function seedLegacyRow(): void {
  const file = getStateDbPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = openStateDatabase(file);
  try {
    db.prepare(
      `INSERT INTO proposals
         (id, stash_dir, ref, status, source, created_at, updated_at, content, frontmatter_json, metadata_json)
       VALUES (?, ?, ?, 'pending', 'distill', ?, ?, ?, NULL, '{}')`,
    ).run(LEGACY_ID, stash, LEGACY_REF, "2026-07-05T03:03:28.486Z", "2026-07-05T03:03:28.486Z", LEGACY_CONTENT);
  } finally {
    db.close();
  }
}

function seedCurrentProposal(): Proposal {
  return createProposal(stash, {
    ref: "lessons/rg-over-grep",
    source: "distill",
    sourceRun: "run-1",
    target: { source: "stash", root: stash },
    payload: { content: VALID_LESSON },
  });
}

function rawRow(id: string): ProposalRow {
  const db = openStateDatabase(getStateDbPath());
  try {
    return db.prepare("SELECT * FROM proposals WHERE id = ?").get(id) as ProposalRow;
  } finally {
    db.close();
  }
}

async function collectWarnings<T>(run: () => T): Promise<{ result: T; warnings: string[] }> {
  const warnings: string[] = [];
  const result = await withSeam(
    _setWarnSinkForTests,
    (level, args) => {
      if (level === "warn") warnings.push(args.map(String).join(" "));
    },
    run,
  );
  return { result, warnings };
}

describe("a pending proposal with a pre-concept-ID `<type>:<name>` ref (#1513)", () => {
  test("show reads it as written, names what it lacks, warns about nothing, and reads the same twice", async () => {
    seedLegacyRow();
    const current = seedCurrentProposal();
    const before = rawRow(LEGACY_ID);

    const { result: first, warnings } = await collectWarnings(() =>
      akmProposalShow({ stashDir: stash, id: LEGACY_ID }),
    );
    expect(warnings).toEqual([]);
    expect(first.proposal.ref).toBe(LEGACY_REF);
    expect(first.proposal.status).toBe("pending");
    expect(first.proposal.payload.content).toBe(LEGACY_CONTENT);
    expect(first.proposal.changes).toEqual([]);
    expect(first.proposal.proposedTarget).toBeUndefined();
    expect(first.validation.ok).toBe(false);
    expect(first.validation.findings.map((f) => f.kind)).toEqual(["legacy-ref"]);
    const message = first.validation.findings[0]?.message ?? "";
    expect(message).toContain(`"${LEGACY_REF}"`);
    expect(message).toContain("changes");
    expect(message).toContain("proposedTarget");
    expect(message).toContain(`akm proposal reject ${LEGACY_ID}`);

    // Inspection is idempotent and writes nothing.
    expect(akmProposalShow({ stashDir: stash, id: LEGACY_ID })).toEqual(first);
    expect(rawRow(LEGACY_ID)).toEqual(before);

    // The row is in the pending queue beside a current proposal, not skipped.
    const { result: pending, warnings: listWarnings } = await collectWarnings(() =>
      listProposals(stash, { status: "pending" }),
    );
    expect(listWarnings).toEqual([]);
    expect(pending.map((p) => p.id).sort()).toEqual([LEGACY_ID, current.id].sort());
  });

  test("accept refuses it with the reason and leaves the row as it was", async () => {
    seedLegacyRow();
    const before = rawRow(LEGACY_ID);

    let error: unknown;
    try {
      await akmProposalAccept({ stashDir: stash, id: LEGACY_ID, config: makeConfig(stash) });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(AkmError);
    expect((error as AkmError).code).toBe("INVALID_PROPOSAL");
    expect((error as AkmError).message).toContain(`"${LEGACY_REF}"`);
    expect((error as AkmError).message).toContain("cannot be applied");

    expect(rawRow(LEGACY_ID)).toEqual(before);
    expect(readEvents({ type: "promoted" }).events).toEqual([]);
    expect(fs.existsSync(path.join(stash, "lessons", "example-legacy-note.md"))).toBe(false);
  });

  test("reject archives it with its content, ref and decision kept; the other proposal is untouched", async () => {
    seedLegacyRow();
    const current = seedCurrentProposal();
    const currentBefore = rawRow(current.id);

    const result = await akmProposalReject({ stashDir: stash, id: LEGACY_ID, reason: "predates concept IDs" });
    expect(result.ok).toBe(true);
    expect(result.ref).toBe(LEGACY_REF);
    expect(result.proposal.status).toBe("rejected");
    expect(result.proposal.review).toMatchObject({
      outcome: "rejected",
      reason: "predates concept IDs",
      decidedBy: "human",
    });

    const row = rawRow(LEGACY_ID);
    expect(row.ref).toBe(LEGACY_REF);
    expect(row.content).toBe(LEGACY_CONTENT);
    expect(row.created_at).toBe("2026-07-05T03:03:28.486Z");
    expect(row.status).toBe("rejected");
    const metadata = JSON.parse(row.metadata_json) as Record<string, unknown>;
    expect(metadata.review).toMatchObject({ outcome: "rejected", reason: "predates concept IDs", decidedBy: "human" });
    // No envelope is fabricated for the archived row.
    expect(metadata.changes).toBeUndefined();
    expect(metadata.proposedTarget).toBeUndefined();

    // The archived row stays readable through the supported readers.
    expect(getProposal(stash, LEGACY_ID).status).toBe("rejected");
    expect(listProposals(stash, { status: "rejected", includeArchive: true }).map((p) => p.id)).toEqual([LEGACY_ID]);
    expect(listProposals(stash, { status: "pending" }).map((p) => p.id)).toEqual([current.id]);
    const rejected = readEvents({ type: "rejected" }).events;
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.ref).toBe(LEGACY_REF);
    expect((rejected[0]?.metadata as Record<string, unknown>).proposalId).toBe(LEGACY_ID);

    expect(rawRow(current.id)).toEqual(currentBefore);
  });

  test("the drain leaves it for a person", async () => {
    seedLegacyRow();
    const current = seedCurrentProposal();
    const before = rawRow(LEGACY_ID);
    const promoteFn = mock(async (opts: { id: string }): Promise<ProposalAcceptResult> => {
      throw new Error(`unexpected promote of ${opts.id}`);
    });
    const rejectFn = mock(async (opts: { id: string }): Promise<ProposalRejectResult> => {
      throw new Error(`unexpected reject of ${opts.id}`);
    });

    const result = await drainProposals(
      { stashDir: stash, applyMode: "promote", maxAccepts: 25, dryRun: false },
      promoteFn,
      rejectFn,
    );

    expect(promoteFn).not.toHaveBeenCalled();
    expect(rejectFn).not.toHaveBeenCalled();
    expect(result.failed).toEqual([]);
    expect(result.deferred).toEqual([{ id: current.id, reason: "needs-judgment" }]);
    expect(rawRow(LEGACY_ID)).toEqual(before);
  });
});
