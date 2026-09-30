// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Integration (ORG-03): opens real SQLite files through openStateDatabase /
// the migration runner to exercise migration 028's backfill.

import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { STATE_MIGRATIONS } from "../../../src/core/state/migrations";
import { openStateDatabase } from "../../../src/core/state-db";
import { openDatabase } from "../../../src/storage/database";
import {
  forgetImproveLedgerDecision,
  getImproveLedgerRow,
  isContentDrivenRow,
  isLedgerBlocked,
  listImproveLedgerRows,
  nextEligibleAt,
  recordImproveLedger,
  recordImproveLedgerDecision,
  reopenImproveLedgerDecision,
} from "../../../src/storage/repositories/improve-ledger-repository";
import { runMigrations } from "../../../src/storage/sqlite-migrations";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function statePath(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akm-improve-ledger-"));
  roots.push(root);
  return path.join(root, "state.db");
}

const T0 = "2026-09-01T00:00:00.000Z";
const DAY = 86_400_000;
const plusDays = (iso: string, days: number): string => new Date(Date.parse(iso) + days * DAY).toISOString();

describe("nextEligibleAt — the one cadence function", () => {
  test("rejections wait per source: reflect 14 d, distill 30 d, anything else 7 d", () => {
    expect(nextEligibleAt("reflect", "rejected", T0)).toBe(plusDays(T0, 14));
    expect(nextEligibleAt("distill", "rejected", T0)).toBe(plusDays(T0, 30));
    expect(nextEligibleAt("consolidate", "rejected", T0)).toBe(plusDays(T0, 7));
    expect(nextEligibleAt("reflect", "quality_rejected", T0)).toBe(plusDays(T0, 14));
    expect(nextEligibleAt("distill", "quality_rejected", T0)).toBe(plusDays(T0, 30));
  });

  test("expiry is a short grace, revisits are the 7-day cadence, accepted and failed are immediate", () => {
    expect(nextEligibleAt("distill", "expired", T0)).toBe(plusDays(T0, 1));
    for (const outcome of ["unchanged", "judged_no_action", "proposed", "review_needed"] as const) {
      expect(nextEligibleAt("consolidate", outcome, T0)).toBe(plusDays(T0, 7));
    }
    expect(nextEligibleAt("reflect", "accepted", T0)).toBeNull();
    expect(nextEligibleAt("reflect", "failed", T0)).toBeNull();
    expect(nextEligibleAt("reflect", "rejected", "not-a-date")).toBeNull();
  });

  test("the consolidate pair pass's own source carries no timer, for any outcome", () => {
    // S1 (post-review): the pair pass's eligibility is entirely
    // content-driven (selectInitiators compares content_hash, never reads
    // next_eligible_at) — every row it writes is "eligible now" regardless
    // of outcome, unlike every other source's outcome-driven cadence.
    for (const outcome of ["proposed", "judged_no_action", "accepted", "rejected", "failed"] as const) {
      expect(nextEligibleAt("consolidate-pair", outcome, T0)).toBeNull();
    }
    // The promote pass's own "consolidate" source keeps its ordinary 7-day
    // revisit cadence for judged_no_action — only the pair pass's distinct
    // "consolidate-pair" source is exempted.
    expect(nextEligibleAt("consolidate", "judged_no_action", T0)).toBe(plusDays(T0, 7));
  });

  test("a decided consolidate promotion recorded with its body hash starts no clock (#998); without one it keeps the old window", () => {
    // The hash is the whole eligibility test for such a row (the pool compares
    // it with the memory's current body), so accepted and rejected are the
    // same: eligible again when the text changes, never because time passed.
    expect(nextEligibleAt("consolidate", "rejected", T0, "body-hash")).toBeNull();
    expect(nextEligibleAt("consolidate", "accepted", T0, "body-hash")).toBeNull();
    // Nothing to compare against (a decision recorded before the hash existed): the clock stays.
    expect(nextEligibleAt("consolidate", "rejected", T0)).toBe(plusDays(T0, 7));
    expect(nextEligibleAt("consolidate", "rejected", T0, null)).toBe(plusDays(T0, 7));
    expect(nextEligibleAt("consolidate", "accepted", T0)).toBeNull();
  });

  test("a hash changes nothing for the outcomes and sources that are not content-driven", () => {
    expect(nextEligibleAt("consolidate", "expired", T0, "h")).toBe(plusDays(T0, 1));
    expect(nextEligibleAt("consolidate", "judged_no_action", T0, "h")).toBe(plusDays(T0, 7));
    expect(nextEligibleAt("consolidate", "proposed", T0, "h")).toBe(plusDays(T0, 7));
    expect(nextEligibleAt("reflect", "rejected", T0, "h")).toBe(plusDays(T0, 14));
    expect(nextEligibleAt("distill", "rejected", T0, "h")).toBe(plusDays(T0, 30));
    expect(nextEligibleAt("distill", "expired", T0, "h")).toBe(plusDays(T0, 1));
  });
});

describe("isContentDrivenRow", () => {
  const row = (
    source: string,
    outcome: "accepted" | "rejected" | "judged_no_action" | "expired",
    hash: string | null,
  ) => ({
    source,
    outcome,
    contentHash: hash,
  });

  test("only a decided consolidate promotion that recorded a hash is held by content", () => {
    expect(isContentDrivenRow(row("consolidate", "rejected", "h"))).toBe(true);
    expect(isContentDrivenRow(row("consolidate", "accepted", "h"))).toBe(true);
    expect(isContentDrivenRow(row("consolidate", "rejected", null))).toBe(false);
    expect(isContentDrivenRow(row("consolidate", "judged_no_action", "h"))).toBe(false);
    expect(isContentDrivenRow(row("consolidate", "expired", "h"))).toBe(false);
    // The pair pass has its own content test (selectInitiators) and never a decided outcome.
    expect(isContentDrivenRow(row("consolidate-pair", "judged_no_action", "h"))).toBe(false);
    expect(isContentDrivenRow(row("reflect", "rejected", "h"))).toBe(false);
  });
});

describe("isLedgerBlocked", () => {
  const row = (outcome: "rejected" | "unchanged", at = T0) => ({
    stashDir: "/s",
    ref: "skills/a",
    source: "reflect",
    lastAttemptAt: at,
    outcome,
    nextEligibleAt: nextEligibleAt("reflect", outcome, at),
    proposalId: null,
    detail: null,
    contentHash: null,
  });

  test("a missing row or an elapsed window never blocks", () => {
    expect(isLedgerBlocked(undefined, T0)).toBe(false);
    expect(isLedgerBlocked(row("rejected"), plusDays(T0, 14))).toBe(false);
    expect(isLedgerBlocked(row("unchanged"), plusDays(T0, 7))).toBe(false);
  });

  test("a rejection is a hard window: fresh feedback does not lift it", () => {
    expect(isLedgerBlocked(row("rejected"), plusDays(T0, 1))).toBe(true);
    expect(isLedgerBlocked(row("rejected"), plusDays(T0, 1), plusDays(T0, 0.5))).toBe(true);
  });

  test("a revisit window is soft: a signal newer than the attempt lifts it, an older one does not", () => {
    expect(isLedgerBlocked(row("unchanged"), plusDays(T0, 1))).toBe(true);
    expect(isLedgerBlocked(row("unchanged"), plusDays(T0, 1), plusDays(T0, 0.5))).toBe(false);
    expect(isLedgerBlocked(row("unchanged"), plusDays(T0, 1), plusDays(T0, -1))).toBe(true);
  });

  test("a consolidate-pair row is never blocked, whatever its outcome — nextEligibleAt is always null for that source", () => {
    const pairRow = (outcome: "proposed" | "judged_no_action") => ({
      stashDir: "/s",
      ref: "memories/a",
      source: "consolidate-pair",
      lastAttemptAt: T0,
      outcome,
      nextEligibleAt: nextEligibleAt("consolidate-pair", outcome, T0),
      proposalId: null,
      detail: null,
      contentHash: "deadbeef",
    });
    // Not even a long time later — this source's eligibility is decided by
    // comparing content_hash directly (selectInitiators), never by this
    // function; isLedgerBlocked returning false here is just confirmation
    // that nextEligibleAt never gives it a window to be blocked by.
    expect(isLedgerBlocked(pairRow("judged_no_action"), plusDays(T0, 1))).toBe(false);
    expect(isLedgerBlocked(pairRow("proposed"), plusDays(T0, 30))).toBe(false);
  });
});

describe("recordImproveLedger / recordImproveLedgerDecision", () => {
  test("upsert keeps one row per (stash, ref, source) and a decision finds it by proposal id", () => {
    const db = openStateDatabase(statePath());
    try {
      recordImproveLedger(db, {
        stashDir: "/s",
        ref: "personal//memories/foo",
        source: "distill",
        outcome: "proposed",
        at: T0,
        proposalId: "p1",
      });
      recordImproveLedger(db, {
        stashDir: "/s",
        ref: "personal//memories/foo",
        source: "distill",
        outcome: "proposed",
        at: plusDays(T0, 1),
        proposalId: "p2",
      });
      expect(listImproveLedgerRows(db, "/s")).toHaveLength(1);

      // The distill proposal itself is keyed by the derived lesson ref; the
      // decision still lands on the input-keyed row through the proposal id.
      recordImproveLedgerDecision(db, {
        proposalId: "p2",
        stashDir: "/s",
        ref: "personal//lessons/foo",
        source: "distill",
        outcome: "rejected",
        at: plusDays(T0, 2),
        detail: "not novel",
      });
      const row = getImproveLedgerRow(db, "/s", "personal//memories/foo", "distill");
      expect(row).toMatchObject({
        outcome: "rejected",
        lastAttemptAt: plusDays(T0, 1),
        nextEligibleAt: plusDays(T0, 32),
        proposalId: "p2",
        detail: "not novel",
      });
      expect(getImproveLedgerRow(db, "/s", "personal//lessons/foo", "distill")).toBeUndefined();
    } finally {
      db.close();
    }
  });

  test("content_hash round-trips through recordImproveLedger and is preserved by a decision update (migration 029)", () => {
    const db = openStateDatabase(statePath());
    try {
      recordImproveLedger(db, {
        stashDir: "/s",
        ref: "memories/a",
        source: "consolidate-pair",
        outcome: "judged_no_action",
        at: T0,
        contentHash: "hash-v1",
      });
      expect(getImproveLedgerRow(db, "/s", "memories/a", "consolidate-pair")).toMatchObject({
        contentHash: "hash-v1",
        nextEligibleAt: null,
      });
      // A later attempt (a content change) overwrites it.
      recordImproveLedger(db, {
        stashDir: "/s",
        ref: "memories/a",
        source: "consolidate-pair",
        outcome: "proposed",
        at: plusDays(T0, 1),
        contentHash: "hash-v2",
      });
      expect(getImproveLedgerRow(db, "/s", "memories/a", "consolidate-pair")).toMatchObject({
        contentHash: "hash-v2",
        outcome: "proposed",
      });
      // A row for a source that never sets contentHash decodes it as null, not undefined/missing.
      recordImproveLedger(db, { stashDir: "/s", ref: "skills/x", source: "reflect", outcome: "proposed", at: T0 });
      expect(getImproveLedgerRow(db, "/s", "skills/x", "reflect")?.contentHash).toBeNull();
    } finally {
      db.close();
    }
  });

  test("a consolidate promotion decided with its source hash holds the source memory by content: no clock, hash recorded (#998)", () => {
    const db = openStateDatabase(statePath());
    try {
      for (const [proposalId, memory, outcome] of [
        ["p-rejected", "memories/rejected", "rejected"],
        ["p-accepted", "memories/accepted", "accepted"],
      ] as const) {
        recordImproveLedger(db, {
          stashDir: "/s",
          ref: memory,
          source: "consolidate",
          outcome: "proposed",
          at: T0,
          proposalId,
        });
        // The proposal itself is keyed by the knowledge ref; the decision names the memory.
        recordImproveLedgerDecision(db, {
          proposalId,
          stashDir: "/s",
          ref: memory,
          source: "consolidate",
          outcome,
          at: plusDays(T0, 1),
          contentHash: `hash-of-${outcome}`,
        });
        expect(getImproveLedgerRow(db, "/s", memory, "consolidate")).toMatchObject({
          outcome,
          lastAttemptAt: T0,
          nextEligibleAt: null,
          contentHash: `hash-of-${outcome}`,
        });
      }
    } finally {
      db.close();
    }
  });

  test("a promotion decided without a hash keeps the old windows, and a hash never lands on an outcome that is not content-driven", () => {
    const db = openStateDatabase(statePath());
    try {
      recordImproveLedger(db, {
        stashDir: "/s",
        ref: "memories/legacy",
        source: "consolidate",
        outcome: "proposed",
        at: T0,
        proposalId: "p-legacy",
      });
      recordImproveLedgerDecision(db, {
        proposalId: "p-legacy",
        stashDir: "/s",
        ref: "memories/legacy",
        source: "consolidate",
        outcome: "rejected",
        at: T0,
      });
      expect(getImproveLedgerRow(db, "/s", "memories/legacy", "consolidate")).toMatchObject({
        nextEligibleAt: plusDays(T0, 7),
        contentHash: null,
      });

      // An expiry is a procedural refusal that judged nothing: the one-day grace stays and the hash is dropped.
      recordImproveLedger(db, {
        stashDir: "/s",
        ref: "memories/expired",
        source: "consolidate",
        outcome: "proposed",
        at: T0,
        proposalId: "p-expired",
      });
      recordImproveLedgerDecision(db, {
        proposalId: "p-expired",
        stashDir: "/s",
        ref: "memories/expired",
        source: "consolidate",
        outcome: "expired",
        at: T0,
        contentHash: "ignored",
      });
      expect(getImproveLedgerRow(db, "/s", "memories/expired", "consolidate")).toMatchObject({
        nextEligibleAt: plusDays(T0, 1),
        contentHash: null,
      });

      // Another source is untouched even when a caller passes a hash.
      recordImproveLedger(db, {
        stashDir: "/s",
        ref: "skills/x",
        source: "reflect",
        outcome: "proposed",
        at: T0,
        proposalId: "p-reflect",
      });
      recordImproveLedgerDecision(db, {
        proposalId: "p-reflect",
        stashDir: "/s",
        ref: "skills/x",
        source: "reflect",
        outcome: "rejected",
        at: T0,
        contentHash: "ignored",
      });
      expect(getImproveLedgerRow(db, "/s", "skills/x", "reflect")).toMatchObject({
        nextEligibleAt: plusDays(T0, 14),
        contentHash: null,
      });
    } finally {
      db.close();
    }
  });

  test("a promotion whose memory row a later attempt overwrote still lands its decision on the memory, keyed by the hash it names (#998)", () => {
    const db = openStateDatabase(statePath());
    try {
      // The row `proposed` left was replaced by a later judged_no_action, which
      // carries no proposal id, so the decision finds no row to update.
      recordImproveLedger(db, {
        stashDir: "/s",
        ref: "memories/overwritten",
        source: "consolidate",
        outcome: "judged_no_action",
        at: T0,
      });
      recordImproveLedgerDecision(db, {
        proposalId: "p-late",
        stashDir: "/s",
        ref: "memories/overwritten",
        source: "consolidate",
        outcome: "rejected",
        at: plusDays(T0, 9),
        contentHash: "hash-at-mint",
      });
      expect(getImproveLedgerRow(db, "/s", "memories/overwritten", "consolidate")).toMatchObject({
        outcome: "rejected",
        nextEligibleAt: null,
        contentHash: "hash-at-mint",
        proposalId: "p-late",
      });
    } finally {
      db.close();
    }
  });

  test("a decision on a proposal no row knows creates a row keyed by the proposal's ref", () => {
    const db = openStateDatabase(statePath());
    try {
      recordImproveLedgerDecision(db, {
        proposalId: "legacy",
        stashDir: "/s",
        ref: "personal//skills/x",
        source: "reflect",
        outcome: "accepted",
        at: T0,
      });
      expect(getImproveLedgerRow(db, "/s", "personal//skills/x", "reflect")).toMatchObject({
        outcome: "accepted",
        nextEligibleAt: null,
        proposalId: "legacy",
      });
      expect(listImproveLedgerRows(db, "/s", ["distill"])).toEqual([]);
    } finally {
      db.close();
    }
  });
});

describe("reopening a rejected proposal resets its ledger rows (#997)", () => {
  test("reopenImproveLedgerDecision puts the rows a rejection hardened back to `proposed` on the revisit cadence", () => {
    const db = openStateDatabase(statePath());
    try {
      recordImproveLedger(db, {
        stashDir: "/s",
        ref: "personal//memories/foo",
        source: "distill",
        outcome: "proposed",
        at: T0,
        proposalId: "p1",
      });
      recordImproveLedgerDecision(db, {
        proposalId: "p1",
        stashDir: "/s",
        ref: "personal//lessons/foo",
        source: "distill",
        outcome: "rejected",
        at: plusDays(T0, 2),
        detail: "not novel",
      });
      const rejected = getImproveLedgerRow(db, "/s", "personal//memories/foo", "distill");
      expect(rejected).toMatchObject({ outcome: "rejected", nextEligibleAt: plusDays(T0, 32) });
      expect(isLedgerBlocked(rejected, plusDays(T0, 3))).toBe(true);

      reopenImproveLedgerDecision(db, {
        proposalId: "p1",
        stashDir: "/s",
        source: "distill",
        at: plusDays(T0, 3),
        detail: "reopened: second look",
      });
      const reopened = getImproveLedgerRow(db, "/s", "personal//memories/foo", "distill");
      expect(reopened).toMatchObject({
        outcome: "proposed",
        lastAttemptAt: T0, // a decision — and its undoing — never moves the attempt time
        nextEligibleAt: plusDays(T0, 10), // the 7-day revisit cadence from the reopen, not the 30-day rejection window
        proposalId: "p1",
        detail: "reopened: second look",
      });
      expect(isLedgerBlocked(reopened, plusDays(T0, 3))).toBe(true); // still revisit-windowed while pending...
      expect(isLedgerBlocked(reopened, plusDays(T0, 3), plusDays(T0, 2))).toBe(false); // ...which fresh feedback lifts, unlike a rejection's
    } finally {
      db.close();
    }
  });

  test("reopenImproveLedgerDecision also drops a content_hash, so the row is exactly what a mint writes", () => {
    const db = openStateDatabase(statePath());
    try {
      recordImproveLedger(db, {
        stashDir: "/s",
        ref: "personal//memories/foo",
        source: "distill",
        outcome: "rejected",
        at: T0,
        proposalId: "p1",
        contentHash: "hash-v1",
      });
      expect(getImproveLedgerRow(db, "/s", "personal//memories/foo", "distill")?.contentHash).toBe("hash-v1");
      reopenImproveLedgerDecision(db, { proposalId: "p1", stashDir: "/s", source: "distill", at: T0 });
      expect(getImproveLedgerRow(db, "/s", "personal//memories/foo", "distill")).toMatchObject({
        outcome: "proposed",
        contentHash: null,
        detail: null,
      });
    } finally {
      db.close();
    }
  });

  test("reopenImproveLedgerDecision touches only the reopened proposal's rows, and creates none", () => {
    const db = openStateDatabase(statePath());
    try {
      recordImproveLedger(db, {
        stashDir: "/s",
        ref: "a",
        source: "reflect",
        outcome: "rejected",
        at: T0,
        proposalId: "p1",
      });
      recordImproveLedger(db, {
        stashDir: "/s",
        ref: "b",
        source: "reflect",
        outcome: "rejected",
        at: T0,
        proposalId: "p2",
      });
      recordImproveLedger(db, {
        stashDir: "/other",
        ref: "a",
        source: "reflect",
        outcome: "rejected",
        at: T0,
        proposalId: "p1",
      });

      reopenImproveLedgerDecision(db, { proposalId: "p1", stashDir: "/s", source: "reflect", at: T0 });
      reopenImproveLedgerDecision(db, { proposalId: "unknown", stashDir: "/s", source: "reflect", at: T0 });

      expect(getImproveLedgerRow(db, "/s", "a", "reflect")?.outcome).toBe("proposed");
      expect(getImproveLedgerRow(db, "/s", "b", "reflect")?.outcome).toBe("rejected");
      expect(getImproveLedgerRow(db, "/other", "a", "reflect")?.outcome).toBe("rejected");
      expect(listImproveLedgerRows(db, "/s")).toHaveLength(2);
    } finally {
      db.close();
    }
  });

  test("forgetImproveLedgerDecision drops the row a retire proposal's rejection created, and nothing else", () => {
    const db = openStateDatabase(statePath());
    try {
      // A retire mint writes no row; its rejection creates one keyed by the proposal's own ref.
      recordImproveLedgerDecision(db, {
        proposalId: "retire-1",
        stashDir: "/s",
        ref: "stash//memories/old-note",
        source: "consolidate-pair",
        outcome: "rejected",
        at: T0,
        detail: "would destroy content",
      });
      // The pair pass's own initiator row for the same asset lives under the bare ref and no proposal id.
      recordImproveLedger(db, {
        stashDir: "/s",
        ref: "memories/old-note",
        source: "consolidate-pair",
        outcome: "proposed",
        at: T0,
        contentHash: "h1",
      });

      forgetImproveLedgerDecision(db, "/s", "retire-1");

      expect(getImproveLedgerRow(db, "/s", "stash//memories/old-note", "consolidate-pair")).toBeUndefined();
      expect(getImproveLedgerRow(db, "/s", "memories/old-note", "consolidate-pair")).toMatchObject({
        outcome: "proposed",
        contentHash: "h1",
      });
    } finally {
      db.close();
    }
  });
});

describe("migration 028 backfills the ledger from proposals rows", () => {
  const before028 = STATE_MIGRATIONS.slice(
    0,
    STATE_MIGRATIONS.findIndex((migration) => migration.id === "028-improve-ledger"),
  );

  function insertProposal(
    db: ReturnType<typeof openDatabase>,
    row: { id: string; ref: string; status: string; source: string; updatedAt: string; metadata?: string },
  ): void {
    db.prepare(
      `INSERT INTO proposals (id, stash_dir, ref, status, source, created_at, updated_at, content, metadata_json)
       VALUES (?, '/s', ?, ?, ?, ?, ?, 'body', ?)`,
    ).run(row.id, row.ref, row.status, row.source, row.updatedAt, row.updatedAt, row.metadata ?? "{}");
  }

  test("the latest row per (stash, ref, source) becomes one ledger row with the outcome's window", () => {
    const file = statePath();
    const seeded = openDatabase(file);
    runMigrations(seeded, before028);
    expect(seeded.prepare("SELECT 1 FROM sqlite_master WHERE name = 'proposal_fingerprints'").get()).toBeTruthy();
    seeded
      .prepare(
        `INSERT INTO proposal_fingerprints (stash_dir, fingerprint, ref, source, created_at)
         VALUES ('/s', 'fp', 'personal//lessons/a', 'distill', ?)`,
      )
      .run(T0);
    // An older rejection superseded by a newer pending mint for the same key.
    insertProposal(seeded, {
      id: "a-old",
      ref: "personal//lessons/a",
      status: "rejected",
      source: "distill",
      updatedAt: T0,
    });
    insertProposal(seeded, {
      id: "a-new",
      ref: "personal//lessons/a",
      status: "pending",
      source: "distill",
      updatedAt: plusDays(T0, 3),
    });
    insertProposal(seeded, {
      id: "b",
      ref: "personal//skills/b",
      status: "rejected",
      source: "reflect",
      updatedAt: T0,
      metadata: JSON.stringify({ review: { outcome: "rejected", reason: "not helpful", decidedAt: T0 } }),
    });
    insertProposal(seeded, {
      id: "c",
      ref: "personal//skills/c",
      status: "rejected",
      source: "reflect",
      updatedAt: T0,
      metadata: JSON.stringify({
        review: { outcome: "rejected", reason: "expired: no action within retention window", decidedAt: T0 },
      }),
    });
    insertProposal(seeded, {
      id: "d",
      ref: "personal//skills/d",
      status: "rejected",
      source: "reflect",
      updatedAt: T0,
      metadata: JSON.stringify({
        review: { outcome: "rejected", reason: "stale-target: changed", decidedAt: T0 },
        gateDecision: { outcome: "auto-rejected", reason: "stale-target", decidedAt: T0 },
      }),
    });
    insertProposal(seeded, {
      id: "e",
      ref: "personal//knowledge/e",
      status: "accepted",
      source: "consolidate",
      updatedAt: T0,
    });
    insertProposal(seeded, {
      id: "f",
      ref: "personal//skills/f",
      status: "reverted",
      source: "reflect",
      updatedAt: T0,
    });
    insertProposal(seeded, {
      id: "g",
      ref: "personal//skills/g",
      status: "rejected",
      source: "reflect",
      updatedAt: T0,
      metadata: "{not json",
    });
    insertProposal(seeded, {
      id: "h",
      ref: "personal//skills/h",
      status: "rejected",
      source: "reflect",
      updatedAt: T0,
      metadata: JSON.stringify({
        review: { outcome: "rejected", reason: "Asset no longer exists on disk", decidedAt: T0 },
      }),
    });
    seeded.close();

    const db = openStateDatabase(file);
    try {
      const rows = new Map(listImproveLedgerRows(db, "/s").map((row) => [`${row.source} ${row.ref}`, row]));
      expect(rows.get("distill personal//lessons/a")).toMatchObject({
        outcome: "proposed",
        proposalId: "a-new",
        lastAttemptAt: plusDays(T0, 3),
        nextEligibleAt: plusDays(T0, 10),
      });
      expect(rows.get("reflect personal//skills/b")).toMatchObject({
        outcome: "rejected",
        nextEligibleAt: plusDays(T0, 14),
        detail: "not helpful",
      });
      expect(rows.get("reflect personal//skills/c")).toMatchObject({
        outcome: "expired",
        nextEligibleAt: plusDays(T0, 1),
      });
      expect(rows.get("reflect personal//skills/d")).toMatchObject({ outcome: "failed", nextEligibleAt: null });
      expect(rows.get("consolidate personal//knowledge/e")).toMatchObject({
        outcome: "accepted",
        nextEligibleAt: null,
      });
      expect(rows.get("reflect personal//skills/f")).toMatchObject({
        outcome: "rejected",
        nextEligibleAt: plusDays(T0, 14),
      });
      expect(rows.get("reflect personal//skills/g")).toMatchObject({ outcome: "rejected", detail: null });
      expect(rows.get("reflect personal//skills/h")).toMatchObject({ outcome: "failed", nextEligibleAt: null });
      expect(rows.size).toBe(8);
      for (const table of [
        "proposal_fingerprints",
        "improve_gate_thresholds",
        "proposal_fs_imports",
        "canary_queries",
        "improve_cycle_metrics",
      ]) {
        expect(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)).toBeNull();
      }
      expect(db.prepare("SELECT COUNT(*) AS n FROM proposals").get()).toEqual({ n: 9 });
    } finally {
      db.close();
    }
  });
});

describe("read/list tolerate a pre-029 improve_ledger with no content_hash column (second review round, should-fix 6)", () => {
  const before029 = STATE_MIGRATIONS.slice(
    0,
    STATE_MIGRATIONS.findIndex((migration) => migration.id === "029-improve-ledger-content-hash"),
  );

  test("getImproveLedgerRow / listImproveLedgerRows degrade to contentHash: null instead of throwing", () => {
    const file = statePath();
    const db = openDatabase(file);
    try {
      runMigrations(db, before029);
      // Confirm the fixture really is pre-029: improve_ledger exists, but
      // content_hash does not.
      expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'improve_ledger'").get()).toBeTruthy();
      expect(() => db.prepare("SELECT content_hash FROM improve_ledger").get()).toThrow();

      db.prepare(
        `INSERT INTO improve_ledger (stash_dir, ref, source, outcome, last_attempt_at)
         VALUES ('/s', 'memories/a', 'consolidate-pair', 'judged_no_action', ?)`,
      ).run(T0);

      expect(getImproveLedgerRow(db, "/s", "memories/a", "consolidate-pair")).toMatchObject({
        outcome: "judged_no_action",
        contentHash: null,
      });
      const rows = listImproveLedgerRows(db, "/s");
      expect(rows).toHaveLength(1);
      expect(rows[0]?.contentHash).toBeNull();
    } finally {
      db.close();
    }
  });
});
