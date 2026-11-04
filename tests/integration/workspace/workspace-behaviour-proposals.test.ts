// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The proposal decisions of `src/workspace/proposals.ts` against a real sandbox stash (integration: state.db, index.db
 * and git). Ported from the retired `akm ui` server tests with the HTTP layer removed: each decision is called
 * directly, and a refusal is the `AkmError` the transport used to map to a status (usage 400, not-found 404, conflict
 * code 409).
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmProposalAccept } from "../../../src/commands/proposal/proposal";
import { openStateDatabase } from "../../../src/core/state-db";
import { acquireAssetMutationLease } from "../../../src/indexer/index-writer-lock";
import { proposals } from "../../../src/workspace";
import { git } from "../../_helpers/git";
import {
  commitCount,
  ctx,
  expectAkmError,
  expectConflict,
  expectUsage,
  type Json,
  lastSubject,
  lessonFile,
  NOTES_REWRITE,
  out,
  propose,
  seed,
  sha1,
  useSandbox,
} from "./workspace-behaviour-helpers";

useSandbox();

describe("proposal writes", () => {
  test("accept writes the asset and makes exactly one commit", async () => {
    await seed();
    const id = propose("lessons/rg");
    const before = commitCount();

    const result = await out(proposals.accept({ id }));
    expect(result).toMatchObject({ ok: true, id, ref: "stash//lessons/rg" });
    expect(result.proposal).toMatchObject({ id, status: "accepted" });
    expect(result.proposal.backupContent).toBeUndefined();
    expect(fs.readFileSync(lessonFile("rg"), "utf8")).toContain("Prefer rg over grep.");

    expect(commitCount()).toBe(before + 1);
    expect(lastSubject()).toBe(`akm accept: reflect ${id.slice(0, 8)} stash//lessons/rg`);
    expect(result.commit).toMatchObject({ subject: lastSubject() });
    expect(result.commit.sha).toBe(git(ctx.storage.stashDir, ["rev-parse", "HEAD"]).trim());

    expect((await out(proposals.get({ id }))).proposal.status).toBe("accepted");
    expect((await out(proposals.list({ status: "pending" }))).totalCount).toBe(0);
  });

  test("a decision through the workspace is recorded exactly like the CLI's", async () => {
    await seed();
    const viaCli = propose("lessons/cli");
    const viaWorkspace = propose("lessons/ui");
    await akmProposalAccept({ id: viaCli });
    await proposals.accept({ id: viaWorkspace });

    const recorded = async (name: string, id: string) => {
      const db = openStateDatabase();
      try {
        const events = db
          .prepare("SELECT event_type, metadata_json FROM events WHERE ref = ? ORDER BY id")
          .all(`stash//lessons/${name}`) as Array<{ event_type: string; metadata_json: string }>;
        return {
          events: events.map((e) => [e.event_type, Object.keys(JSON.parse(e.metadata_json)).sort()]),
          review: (await out(proposals.get({ id }))).proposal.review.outcome,
        };
      } finally {
        db.close();
      }
    };
    const cli = await recorded("cli", viaCli);
    expect(cli.events.length).toBeGreaterThan(0);
    expect(await recorded("ui", viaWorkspace)).toEqual(cli);
  });

  test("batch accept of three makes one commit and reports each id, including one that fails", async () => {
    await seed();
    const ids = [propose("lessons/a"), propose("lessons/b"), propose("lessons/c")];
    const missing = "00000000-0000-4000-8000-000000000000";
    const before = commitCount();

    const result = await out(proposals.acceptMany({ ids: [ids[0]!, missing, ids[1]!, ids[2]!, ids[0]!] }));
    expect(result).toMatchObject({ accepted: 3, failed: 1 });
    expect(result.results.map((r: Json) => [r.id, r.ok])).toEqual([
      [ids[0], true],
      [missing, false],
      [ids[1], true],
      [ids[2], true],
    ]);
    expect(result.results[1]).toMatchObject({ ok: false, code: "PROPOSAL_NOT_FOUND" });
    expect(result.results[1].error).toContain("not found");
    for (const name of ["a", "b", "c"]) expect(fs.existsSync(lessonFile(name))).toBe(true);

    expect(commitCount()).toBe(before + 1);
    expect(lastSubject()).toBe("akm proposal accept: 3 accepted (reflect 3)");
    expect(result.commit).toMatchObject({ subject: lastSubject() });
    expect((await out(proposals.list({ status: "pending" }))).totalCount).toBe(0);
  });

  test("batch input is bounded: 1 to 200 ids, strings only", async () => {
    await seed();
    const accept = (ids: unknown) => proposals.acceptMany({ ids } as never);
    for (const ids of [undefined, [], "x", [1], [""], ["x".repeat(201)]]) {
      await expectUsage(() => accept(ids));
    }
    await expectUsage(() => accept(Array.from({ length: 201 }, (_, i) => `id-${i}`)));
    const full = await out(accept(Array.from({ length: 200 }, (_, i) => `id-${i}`)));
    expect(full).toMatchObject({ accepted: 0, failed: 200, commit: null });
  });

  test("reject records the reason and leaves the asset and the repository alone", async () => {
    await seed();
    const notes = path.join(ctx.storage.stashDir, "knowledge", "notes.md");
    const id = propose("knowledge/notes", NOTES_REWRITE);
    const hash = sha1(notes);
    const before = commitCount();

    const result = await out(proposals.reject({ id, reason: "  Not what the page needs.  " }));
    expect(result).toMatchObject({ ok: true, id, reason: "Not what the page needs." });
    expect(result.proposal.status).toBe("rejected");

    expect(sha1(notes)).toBe(hash);
    expect(commitCount()).toBe(before);
    const detail = await out(proposals.get({ id }));
    expect(detail.proposal.status).toBe("rejected");
    expect(detail.proposal.review).toMatchObject({ outcome: "rejected", reason: "Not what the page needs." });
    expect((await out(proposals.list({ status: "recent" }))).proposals[0]).toMatchObject({ id, status: "rejected" });
  });

  test("revert restores the asset from the accept backup, and reopen returns a rejection to the queue", async () => {
    await seed();
    const notes = path.join(ctx.storage.stashDir, "knowledge", "notes.md");
    const original = fs.readFileSync(notes, "utf8");
    const edit = propose("knowledge/notes", NOTES_REWRITE);

    await proposals.accept({ id: edit });
    expect(fs.readFileSync(notes, "utf8")).not.toBe(original);
    // An accepted edit says it can be undone, and who decided is carried on the summary.
    const recent = (await out(proposals.list({ status: "recent" }))).proposals.find((p: Json) => p.id === edit);
    expect(recent).toMatchObject({ status: "accepted", revertable: true });
    const reverted = await out(proposals.revert({ id: edit }));
    expect(reverted.proposal.status).toBe("reverted");
    expect(fs.readFileSync(notes, "utf8")).toBe(original);

    const other = propose("lessons/rg");
    await proposals.reject({ id: other, reason: "later" });
    const reopened = await out(proposals.reopen({ id: other }));
    expect(reopened.proposal.status).toBe("pending");
    // Reopening a proposal that is still pending is refused, not applied twice.
    await expectUsage(() => proposals.reopen({ id: other }));
  });

  test("batch reject records one reason for each proposal and reports each outcome", async () => {
    await seed();
    const first = propose("lessons/one");
    const second = propose("lessons/two");
    const result = await out(proposals.rejectMany({ ids: [first, second, "missing-id"], reason: "Out of date." }));
    expect(result).toMatchObject({ rejected: 2, failed: 1 });
    expect(result.results.map((r: { ok: boolean }) => r.ok)).toEqual([true, true, false]);
    expect((await out(proposals.get({ id: first }))).proposal.review).toMatchObject({
      outcome: "rejected",
      reason: "Out of date.",
    });
    await expectUsage(() => proposals.rejectMany({ ids: [first] } as never));
    await expectUsage(() => proposals.rejectMany({ reason: "x" } as never));
  });

  test("a rejection needs a reason of 1 to 2000 characters", async () => {
    await seed();
    const id = propose("lessons/rg");
    for (const reason of [undefined, "", "   \n ", 5, "x".repeat(2001)]) {
      await expectUsage(() => proposals.reject({ id, reason } as never));
    }
    expect((await out(proposals.get({ id }))).proposal.status).toBe("pending");
    await proposals.reject({ id, reason: "x".repeat(2000) });
  });

  test("a stale target is a PROPOSAL_STALE conflict and nothing is written", async () => {
    await seed();
    const notes = path.join(ctx.storage.stashDir, "knowledge", "notes.md");
    const id = propose("knowledge/notes", NOTES_REWRITE);
    fs.writeFileSync(notes, "---\ndescription: Edited since\n---\n# Notes\nEdited by hand.\n");
    const edited = sha1(notes);
    const before = commitCount();

    const error = await expectConflict(proposals.accept({ id }), "PROPOSAL_STALE");
    expect(error.message).toContain("target changed after proposal");
    expect(sha1(notes)).toBe(edited);
    expect(commitCount()).toBe(before);
    expect((await out(proposals.get({ id }))).proposal.status).toBe("pending");

    // Inside a batch the same failure is reported per id.
    const batch = await out(proposals.acceptMany({ ids: [id] }));
    expect(batch.results[0]).toMatchObject({ ok: false, code: "PROPOSAL_STALE" });
  });

  test("unknown ids are not found, decided proposals are conflicts, a held lease is a conflict", async () => {
    await seed();
    const id = propose("lessons/rg");
    const other = propose("lessons/other");
    const missing = "00000000-0000-4000-8000-000000000000";

    await expectAkmError(proposals.accept({ id: missing }), { kind: "not-found", code: "PROPOSAL_NOT_FOUND" });
    await expectAkmError(proposals.reject({ id: missing, reason: "gone" }), {
      kind: "not-found",
      code: "PROPOSAL_NOT_FOUND",
    });

    await proposals.reject({ id, reason: "no" });
    await expectConflict(proposals.accept({ id }), "PROPOSAL_NOT_PENDING");
    await proposals.accept({ id: other });
    await expectConflict(proposals.reject({ id: other, reason: "late" }), "PROPOSAL_NOT_PENDING");

    const third = propose("lessons/third");
    const lease = await acquireAssetMutationLease({ purpose: "test-holder", mode: "try" });
    expect(lease).toBeDefined();
    try {
      await expectConflict(proposals.accept({ id: third }), "ASSET_MUTATION_LEASE_HELD");
    } finally {
      lease?.release();
    }
    await proposals.accept({ id: third });
  });
});
