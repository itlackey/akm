// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Behavioral coverage for the usage_events RECORDING contract on the read
 * path. The read commands attach an `entry_id` at INSERT time:
 *
 *   - show.ts   : insertUsageEvent({ ..., entry_ref: ref, entry_id: findEntryIdByRef(db, ref) })
 *   - feedback  : insertUsageEvent({ ..., entry_ref: ref, entry_id }) then countFeedbackSignals(db, entryId)
 *
 * These are the rows that `relinkUsageEvents` later corrupted. This file pins
 * the recorder's own guarantees, exercising the shapes the exemplar bug hid:
 *   (a) an ORIGIN-QUALIFIED ref records a NON-NULL entry_id (resolved via the
 *       parse-first path), while the raw origin-qualified string is preserved
 *       in entry_ref;
 *   (b) a ref for an ABSENT entry records entry_id = NULL (never a false id);
 *   (c) feedback pos/neg aggregation keys on entry_id, so it is correct even
 *       when entry_ref carries an origin qualifier;
 *   (d) source defaults to "user" and machine sources persist verbatim (the
 *       column that gates utility bumps / retrieval demand downstream).
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { closeDatabase, findEntryIdByRef, openIndexDatabase, upsertEntry } from "../../src/indexer/db/db";
import type { StashEntry } from "../../src/indexer/passes/metadata";
import { countFeedbackSignals, getUsageEvents, insertUsageEvent } from "../../src/indexer/usage/usage-events";
import type { Database } from "../../src/storage/database";
import { type Cleanup, sandboxXdgCacheHome, sandboxXdgConfigHome } from "../_helpers/sandbox";

// ── Temp directory management ───────────────────────────────────────────────

const createdTmpDirs: string[] = [];

function tmpDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-usage-recording-"));
  createdTmpDirs.push(dir);
  return path.join(dir, "index.db");
}

afterAll(() => {
  for (const dir of createdTmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

// ── Environment isolation ───────────────────────────────────────────────────

let envCleanup: Cleanup = () => {};

beforeEach(() => {
  const cacheResult = sandboxXdgCacheHome();
  const cfgResult = sandboxXdgConfigHome(cacheResult.cleanup);
  envCleanup = cfgResult.cleanup;
});

afterEach(() => {
  envCleanup();
  envCleanup = () => {};
});

// ── Seed helper (production entry_key shape) ─────────────────────────────────

const STASH = "/home/user/.local/share/akm";

function seed(db: Database, type: StashEntry["type"], name: string): number {
  const entryKey = `${STASH}:${type}:${name}`;
  const filePath = `${STASH}/${type}/${name}`;
  const entry = { description: `desc ${name}`, type, name } as unknown as StashEntry;
  return upsertEntry(db, entryKey, path.dirname(filePath), filePath, STASH, entry, `${name} desc`);
}

function withDb(fn: (db: Database) => void): void {
  const db = openIndexDatabase(tmpDbPath());
  try {
    fn(db);
  } finally {
    closeDatabase(db);
  }
}

/**
 * Mirror show.ts's logShowEvent insert path exactly: resolve the entry_id from
 * the (possibly origin-qualified) ref, then record the raw ref + resolved id.
 */
function recordShow(db: Database, ref: string): void {
  insertUsageEvent(db, {
    event_type: "show",
    entry_ref: ref,
    entry_id: findEntryIdByRef(db, ref),
    source: "user",
  });
}

describe("read-path usage_events recording contract", () => {
  test("show with a BARE ref records the resolved entry_id and the ref verbatim", () => {
    withDb((db) => {
      const id = seed(db, "skill", "deploy");
      recordShow(db, "skill:deploy");

      const rows = getUsageEvents(db, { event_type: "show" });
      expect(rows).toHaveLength(1);
      expect(rows[0].entry_ref).toBe("skill:deploy");
      expect(rows[0].entry_id).toBe(id);
    });
  });

  // The relink-class shape: origin-qualified ref must still get a NON-NULL
  // entry_id, and the raw origin-qualified string is preserved in entry_ref.
  test("show with an ORIGIN-QUALIFIED ref records a non-null entry_id + raw qualified ref", () => {
    withDb((db) => {
      const id = seed(db, "skill", "deploy");
      recordShow(db, "local//skill:deploy");

      const rows = getUsageEvents(db, { event_type: "show" });
      expect(rows).toHaveLength(1);
      // entry_id resolved despite the origin qualifier (parse-first path).
      expect(rows[0].entry_id).toBe(id);
      // The raw qualified ref is what gets stored (this is exactly the string
      // the relink suffix-match later had to cope with).
      expect(rows[0].entry_ref).toBe("local//skill:deploy");
    });
  });

  test("show for an ABSENT entry records entry_id = NULL (no false-positive id)", () => {
    withDb((db) => {
      seed(db, "skill", "deploy");
      recordShow(db, "skill:ghost");

      const rows = getUsageEvents(db, { event_type: "show", entry_ref: "skill:ghost" });
      expect(rows).toHaveLength(1);
      expect(rows[0].entry_id).toBeNull();
    });
  });

  test("feedback pos/neg aggregation keys on entry_id even when entry_ref is origin-qualified", () => {
    withDb((db) => {
      const id = seed(db, "lesson", "postmortem");

      // Two positive + one negative, recorded under DIFFERENT ref spellings but
      // the SAME resolved entry_id — exactly how feedback-cli records them.
      for (const ref of ["lesson:postmortem", "local//lesson:postmortem"]) {
        insertUsageEvent(db, {
          event_type: "feedback",
          entry_ref: ref,
          entry_id: findEntryIdByRef(db, ref),
          signal: "positive",
        });
      }
      insertUsageEvent(db, {
        event_type: "feedback",
        entry_ref: "owner/repo//lesson:postmortem",
        entry_id: findEntryIdByRef(db, "owner/repo//lesson:postmortem"),
        signal: "negative",
      });

      const { pos, neg } = countFeedbackSignals(db, id);
      expect(pos).toBe(2);
      expect(neg).toBe(1);
    });
  });

  test("countFeedbackSignals returns {0,0} for an entry with no feedback", () => {
    withDb((db) => {
      const id = seed(db, "skill", "untouched");
      // A show event on the same entry must NOT count as feedback.
      recordShow(db, "skill:untouched");
      expect(countFeedbackSignals(db, id)).toEqual({ pos: 0, neg: 0 });
    });
  });

  test("source defaults to 'user' and machine sources persist verbatim", () => {
    withDb((db) => {
      seed(db, "skill", "deploy");
      // No source → default 'user' (drives utility bump / retrieval demand).
      insertUsageEvent(db, { event_type: "show", entry_ref: "skill:deploy", entry_id: 1 });
      insertUsageEvent(db, { event_type: "search", query: "x", source: "improve" });
      insertUsageEvent(db, { event_type: "search", query: "y", source: "task" });

      expect(getUsageEvents(db, { source: "user" })).toHaveLength(1);
      expect(getUsageEvents(db, { source: "improve" })).toHaveLength(1);
      expect(getUsageEvents(db, { source: "task" })).toHaveLength(1);
    });
  });

  test("curate-style per-item events store entry_ref with NO entry_id (backfilled by relink later)", () => {
    // curate.ts records per-item rows with only entry_ref (no entry_id) — the
    // shape most exposed to the relink bug. Pin that the recorder writes a NULL
    // entry_id here so a regression that starts fabricating ids is caught.
    withDb((db) => {
      seed(db, "skill", "deploy");
      insertUsageEvent(db, { event_type: "curate", query: "ship it", entry_ref: "local//skill:deploy" });

      const rows = getUsageEvents(db, { event_type: "curate" });
      expect(rows).toHaveLength(1);
      expect(rows[0].entry_ref).toBe("local//skill:deploy");
      expect(rows[0].entry_id).toBeNull();
    });
  });
});
