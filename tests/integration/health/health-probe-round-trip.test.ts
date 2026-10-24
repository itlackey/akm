// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * R-030 regression: `probeStateDbRoundTrip` (the `state-db-round-trip` health
 * check `akm health` runs on every invocation) used to append a permanent
 * `health_probe` event and never remove it — a read-only health check run on
 * a monitoring cron would grow state.db's `events` table without bound (the
 * only purge is `improve`'s retention pass, which a health-only user never
 * runs). The fix makes the probe self-cleaning: it still genuinely inserts
 * and reads back a row (proving the round trip works), but deletes that row
 * before returning, so repeated invocations leave the `events` table
 * untouched.
 */

import { describe, expect, test } from "bun:test";
import { probeStateDbRoundTrip } from "../../../src/commands/health";
import { getStateDbPath, openStateDatabase } from "../../../src/core/state-db";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../../_helpers/sandbox";

function countEventsTable(): number {
  const db = openStateDatabase();
  try {
    const row = db.prepare("SELECT COUNT(*) AS c FROM events").get() as { c: number };
    return row.c;
  } finally {
    db.close();
  }
}

describe("probeStateDbRoundTrip (R-030)", () => {
  test("repeated invocations do not grow the events table", () => {
    const storage: IsolatedAkmStorage = withIsolatedAkmStorage();
    try {
      const stateDbPath = getStateDbPath();
      for (let i = 0; i < 5; i++) {
        const result = probeStateDbRoundTrip(stateDbPath);
        expect(result.ok).toBe(true);
        expect(countEventsTable()).toBe(0);
      }
    } finally {
      storage.cleanup();
    }
  });

  test("does not disturb pre-existing events (only its own probe row is touched)", () => {
    const storage: IsolatedAkmStorage = withIsolatedAkmStorage();
    try {
      const stateDbPath = getStateDbPath();
      const db = openStateDatabase(stateDbPath);
      try {
        db.prepare("INSERT INTO events (event_type, ts, ref, metadata_json) VALUES (?, ?, ?, ?)").run(
          "reflect_invoked",
          new Date().toISOString(),
          "lessons/pre-existing",
          "{}",
        );
      } finally {
        db.close();
      }
      expect(countEventsTable()).toBe(1);

      const result = probeStateDbRoundTrip(stateDbPath);
      expect(result.ok).toBe(true);
      expect(countEventsTable()).toBe(1);

      const survivors = openStateDatabase(stateDbPath);
      try {
        const rows = survivors.prepare("SELECT event_type, ref FROM events").all() as Array<{
          event_type: string;
          ref: string | null;
        }>;
        expect(rows).toEqual([{ event_type: "reflect_invoked", ref: "lessons/pre-existing" }]);
      } finally {
        survivors.close();
      }
    } finally {
      storage.cleanup();
    }
  });
});
