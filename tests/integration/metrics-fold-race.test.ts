// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Real processes folding and purging one state.db at once. metrics.db is the only copy of a purged day, so
 * every seeded event must end up in a rollup (or still be in state.db): a process that built its day list
 * before another folded and purged a day must not wipe that day's rollups and mark it covered.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { openMetricsDatabase } from "../../src/core/metrics-db";
import { openStateDatabase } from "../../src/core/state-db";
import { dayPlus } from "../_helpers/metrics-fixtures";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../_helpers/sandbox";

const DAYS = 150;
const PER_DAY = 200;
const PROCESSES = 4;
const ROUNDS = 3;

let storage: IsolatedAkmStorage;
beforeEach(() => {
  storage = withIsolatedAkmStorage();
});
afterEach(() => storage.cleanup());

function seed(): string[] {
  const today = new Date().toISOString().slice(0, 10);
  const days = Array.from({ length: DAYS }, (_, i) => dayPlus(today, -(i + 3)));
  const state = openStateDatabase();
  try {
    const insert = state.prepare(
      "INSERT INTO events (event_type, ts, ref, metadata_json) VALUES ('health_probe', ?, NULL, '{}')",
    );
    state.exec("BEGIN");
    for (const day of days)
      for (let i = 0; i < PER_DAY; i++)
        insert.run(`${day}T01:00:${String(i % 60).padStart(2, "0")}.${String(i).padStart(3, "0")}Z`);
    state.exec("COMMIT");
  } finally {
    state.close();
  }
  return days;
}

test(
  "concurrent fold + purge processes lose no day",
  async () => {
    for (let round = 0; round < ROUNDS; round++) {
      fs.rmSync(path.join(storage.dataDir, "akm"), { recursive: true, force: true });
      const days = seed();
      const dir = fs.mkdtempSync(path.join(storage.root, "race-"));
      const goFile = path.join(dir, "go");
      const procs = Array.from({ length: PROCESSES }, (_, i) =>
        Bun.spawn(
          [
            "bun",
            path.join(import.meta.dir, "..", "_helpers", "fold-race-child.ts"),
            path.join(dir, `ready-${i}`),
            goFile,
          ],
          {
            env: { ...process.env },
            stdout: "inherit",
            stderr: "inherit",
          },
        ),
      );
      while (fs.readdirSync(dir).filter((f) => f.startsWith("ready-")).length < PROCESSES) await Bun.sleep(10);
      fs.writeFileSync(goFile, "");
      for (const proc of procs) expect(await proc.exited).toBe(0);

      const state = openStateDatabase();
      const metrics = openMetricsDatabase();
      try {
        const lost = days.filter((day) => {
          const rolled = (
            metrics.prepare("SELECT COALESCE(SUM(n), 0) AS n FROM event_daily WHERE day = ?").get(day) as { n: number }
          ).n;
          const raw = (
            state.prepare("SELECT COUNT(*) AS n FROM events WHERE ts >= ? AND ts < ?").get(day, dayPlus(day, 1)) as {
              n: number;
            }
          ).n;
          return rolled !== PER_DAY && raw !== PER_DAY;
        });
        expect(lost).toEqual([]);
      } finally {
        state.close();
        metrics.close();
      }
    }
  },
  { timeout: 300_000 },
);
