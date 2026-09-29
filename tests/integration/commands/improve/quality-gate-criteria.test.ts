// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * JUDGE / R16 — `writeQualityRejection` records every distill quality-gate
 * outcome: the `distill_invoked` event (with per-criterion judge scores), the
 * improve-ledger row that keeps candidate selection from re-generating the
 * input, and — for `review_needed` — a pending proposal stamped for a human.
 * Reads state.db back — integration, not a pure unit test.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { writeQualityRejection } from "../../../../src/commands/improve/distill";
import { getProposal, listProposals } from "../../../../src/commands/proposal/repository";
import { readEvents } from "../../../../src/core/events";
import { openStateDatabase } from "../../../../src/core/state-db";
import { getImproveLedgerRow } from "../../../../src/storage/repositories/improve-ledger-repository";
import { makeSandboxDir } from "../../../_helpers/sandbox";

let stashDir: string;
let cleanup: () => void;

beforeEach(() => {
  const sandbox = makeSandboxDir("akm-quality-gate-criteria");
  stashDir = sandbox.dir;
  cleanup = sandbox.cleanup;
});

afterEach(() => cleanup());

function ledgerRow(ref: string) {
  const db = openStateDatabase();
  try {
    return getImproveLedgerRow(db, stashDir, ref, "distill");
  } finally {
    db.close();
  }
}

function lastDistillEvent(): Record<string, unknown> | undefined {
  const rows = readEvents().events.filter((e) => e.eventType === "distill_invoked");
  return rows[rows.length - 1]?.metadata as Record<string, unknown> | undefined;
}

describe("writeQualityRejection — quality_rejected lands in the improve ledger (R16)", () => {
  test("criteria reach the event and the envelope; the input gets the distill rejection window", () => {
    const criteria = { novelty: 2, actionability: 3, nonRedundancy: 2 };
    const result = writeQualityRejection({
      stash: stashDir,
      inputRef: "memories/source-ref",
      proposalRef: "lessons/proposed-ref",
      content: "proposed lesson body",
      score: (criteria.novelty + criteria.actionability + criteria.nonRedundancy) / 3,
      reason: "judge reason",
      meta: { criteria },
      ledgerRef: "stash//memories/source-ref",
    });

    expect(result.outcome).toBe("quality_rejected");
    expect((result as unknown as { criteria?: Record<string, number> }).criteria).toEqual(criteria);
    expect(result.proposalId).toBeUndefined();
    expect(lastDistillEvent()?.criteria).toEqual(criteria);

    const row = ledgerRow("stash//memories/source-ref");
    expect(row).toMatchObject({ outcome: "quality_rejected", detail: "judge reason" });
    expect(Date.parse(row?.nextEligibleAt ?? "") - Date.parse(row?.lastAttemptAt ?? "")).toBe(30 * 86_400_000);
    // Nothing is queued for a rejection.
    expect(listProposals(stashDir, { includeArchive: true })).toEqual([]);
  });

  test("no criteria supplied (structural/fidelity rejection) omits them", () => {
    const result = writeQualityRejection({
      stash: stashDir,
      inputRef: "memories/source-ref",
      proposalRef: "lessons/proposed-ref-no-criteria",
      content: "proposed lesson body",
      score: 2.0,
      reason: "structural finding",
    });
    expect((result as unknown as { criteria?: unknown }).criteria).toBeUndefined();
    expect(lastDistillEvent()?.criteria).toBeUndefined();
    expect(ledgerRow("memories/source-ref")).toMatchObject({ outcome: "quality_rejected" });
  });
});

describe("writeQualityRejection — REVIEW: review_needed mint is stamped for a human, not the judgment tier", () => {
  test("a review_needed mint carries a deferred/quality-gate gate decision and a review_needed ledger row", () => {
    const content =
      "---\ndescription: A lesson worth a human look\nwhen_to_use: Uncertain quality band\n---\n\nBody text.\n";
    const result = writeQualityRejection({
      stash: stashDir,
      inputRef: "memories/source-ref",
      proposalRef: "lessons/proposed-review-needed",
      content,
      score: 3.0,
      reason: "uncertain quality band",
      meta: { reviewNeeded: true },
    });

    expect(result.outcome).toBe("review_needed");
    const proposalId = (result as unknown as { proposalId?: string }).proposalId;
    expect(proposalId).toBeDefined();

    const proposal = getProposal(stashDir, proposalId as string);
    expect(proposal.status).toBe("pending");
    expect(proposal.gateDecision).toMatchObject({
      outcome: "deferred",
      reason: "quality-review",
      gate: "quality-gate",
    });
    expect(ledgerRow("memories/source-ref")).toMatchObject({ outcome: "review_needed", proposalId });
  });

  test("structurally-invalid review_needed content mints nothing, still records the ledger and event, and does not throw", () => {
    // No `description`/`when_to_use` frontmatter — the mint-time canonical
    // validator throws UsageError for a lesson. writeQualityRejection swallows
    // it: the ledger still records the attempt.
    const result = writeQualityRejection({
      stash: stashDir,
      inputRef: "memories/source-ref",
      proposalRef: "lessons/proposed-ref-invalid-structure",
      content: "body with no description or when_to_use frontmatter",
      score: 3.0,
      reason: "uncertain quality band",
      meta: { reviewNeeded: true },
    });

    expect(result.outcome).toBe("review_needed");
    expect((result as unknown as { proposalId?: string }).proposalId).toBeUndefined();
    expect(lastDistillEvent()?.outcome).toBe("review_needed");
    expect(ledgerRow("memories/source-ref")).toMatchObject({ outcome: "review_needed" });
  });
});
