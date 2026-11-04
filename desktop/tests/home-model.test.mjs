// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import assert from "node:assert/strict";
import test from "node:test";
import { healthCheckAnchor, homeConcerns, homeCoverage, taskOutcomes } from "../src/lib/home-model.ts";

const overview = () => ({
  health: { status: "pass", hardChecks: [], advisories: [] },
  metrics: { tasks: { runs: 18, failed: 12 } },
  improveRuns: [{ ok: true }, { ok: false }, { ok: null }],
  taskFailures: [],
});
const pulse = () => ({
  tiles: { runs: { tasks: { ok: 4, total: 18 }, failedTasks: [{ taskId: "a" }, { taskId: "b" }, { taskId: "c" }] } },
  attention: { failedRuns: { tasks: 12, improve: 2 } },
});

test("Home shows actual task failure totals, not the three-row preview, and ignores unknown improve outcomes", () => {
  const data = overview();
  data.health.hardChecks.push({ name: "state-store", status: "fail", message: "Unavailable" });
  data.health.advisories.push({ name: "source/access", status: "warn", message: "Missing directory" });
  const concerns = homeConcerns(data);
  assert.deepEqual(
    concerns.map((row) => row.key),
    ["state-store", "task-runs", "improve-runs", "source/access"],
  );
  assert.equal(concerns[1].title, "12 task runs failed");
  assert.equal(concerns[2].title, "1 improvement run failed");
  assert.match(concerns[2].description, /3 latest records, across all time/);
  assert.match(concerns[1].href, /window=7d/);
  assert.equal(new URLSearchParams(concerns[3].href.split("?")[1]).get("anchor"), healthCheckAnchor("source/access"));
});
test("Home keeps other task outcomes separate from failures and refuses unavailable or inconsistent data", () => {
  assert.deepEqual(taskOutcomes(overview(), pulse()), { completed: 4, failed: 12, other: 2, total: 18 });
  assert.equal(taskOutcomes({ ...overview(), taskFailures: null }, pulse()), null);
  assert.equal(taskOutcomes({ ...overview(), errors: { state: "Read failed" } }, pulse()), null);
  const inconsistent = pulse();
  inconsistent.tiles.runs.tasks.total = 2;
  assert.equal(taskOutcomes(overview(), inconsistent), null);
  assert.equal(taskOutcomes(overview(), null), null);
  assert.equal(taskOutcomes(null, pulse()), null);
});
test("Unavailable is not all-clear; measured zero stays zero; proposals are not health concerns", () => {
  assert.ok(homeCoverage(null, null).includes("Health checks"));
  const data = overview();
  data.metrics.tasks.failed = 0;
  data.improveRuns = [];
  const weekly = pulse();
  weekly.tiles.runs.tasks = { ok: 0, total: 0 };
  weekly.attention.failedRuns.tasks = 0;
  weekly.attention.pending = { count: 40 };
  assert.deepEqual(taskOutcomes(data, weekly), { completed: 0, failed: 0, other: 0, total: 0 });
  assert.deepEqual(homeCoverage(data, weekly), []);
  assert.deepEqual(homeConcerns(data), []);
  assert.deepEqual(homeConcerns(null), []);
});
