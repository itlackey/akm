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
  getImproveLedgerRow,
  isLedgerBlocked,
  listImproveLedgerRows,
  nextEligibleAt,
  recordImproveLedger,
  recordImproveLedgerDecision,
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
