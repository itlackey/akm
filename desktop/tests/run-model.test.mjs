// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import assert from "node:assert/strict";
import test from "node:test";
import {
  improveAroundTask,
  improveOutcome,
  outcomeCounts,
  statusOutcome,
  tasksAroundImprove,
  workflowFacts,
} from "../src/lib/run-model.ts";

const minute = 60_000;
const at = (offset) => new Date(Date.parse("2026-11-12T12:00:00.000Z") + offset * minute).toISOString();

test("a run with no recorded end is unknown, never completed", () => {
  assert.equal(statusOutcome("completed"), "completed");
  assert.equal(statusOutcome("failed"), "failed");
  for (const status of ["active", "blocked", "running", "", "something-new"])
    assert.equal(statusOutcome(status), "unknown");
  assert.equal(improveOutcome({ ok: true }), "completed");
  assert.equal(improveOutcome({ ok: false }), "failed");
  assert.equal(improveOutcome({ ok: null }), "unknown");
  assert.deepEqual(outcomeCounts(["completed", "failed", "unknown", "unknown"]), {
    completed: 1,
    failed: 1,
    terminated: 0,
    unknown: 2,
  });
});

test("improve runs and scheduled task runs are matched by start time within five minutes, and only for improve tasks", () => {
  const run = { id: "r1", startedAt: at(0) };
  const task = (taskId, offset) => ({ taskId, startedAt: at(offset), status: "failed" });
  const near = task("akm-improve-frequent", -4);
  assert.deepEqual(
    tasksAroundImprove(run, [near, task("akm-improve-frequent", 6), task("nightly-digest", 0), task("improve", 5)]).map(
      (row) => row.taskId,
    ),
    ["akm-improve-frequent", "improve"],
  );
  assert.deepEqual(
    improveAroundTask(near, [run, { id: "far", startedAt: at(-30) }]).map((row) => row.id),
    ["r1"],
  );
  assert.deepEqual(improveAroundTask(task("nightly-digest", 0), [run]), []);
});

const attempt = (n, status, tokens, failureReason, from, to) => ({
  attempt: n,
  phase: "unit",
  status,
  startedAt: at(from),
  finishedAt: to === null ? null : at(to),
  tokens,
  failureReason,
});
const trace = (status, units) => ({
  run: { id: "w1", status },
  steps: [{ id: "build", title: "Build", status: "failed", sequenceIndex: 0, completedAt: null }],
  units,
  children: [],
});
const unit = (id, engine, status, attempts) => ({
  unitId: id,
  nodeId: id,
  stepId: "build",
  status,
  engine,
  tokens: null,
  startedAt: null,
  finishedAt: null,
  failureReason: null,
  attempts,
});

test("a workflow run's failures are listed in the order they ended, and tokens are summed per target", () => {
  const facts = workflowFacts(
    trace("failed", [
      unit("b", "cloud", "failed", [
        attempt(1, "failed", 300, "provider_error", 5, 8),
        attempt(2, "failed", null, null, 8, 9),
      ]),
      unit("a", "lab", "completed", [
        attempt(1, "failed", 100, "timeout", 0, 2),
        attempt(2, "completed", 700, null, 2, 4),
      ]),
    ]),
  );
  assert.deepEqual(
    facts.failures.map((row) => [row.unit, row.attempt, row.reason, row.step]),
    [
      ["a", 1, "timeout", "Build"],
      ["b", 1, "provider_error", "Build"],
      ["b", 2, null, "Build"],
    ],
  );
  assert.deepEqual(facts.engines, [
    { engine: "lab", attempts: 2, failed: 1, tokens: 800, unreported: 0 },
    { engine: "cloud", attempts: 2, failed: 2, tokens: 300, unreported: 1 },
  ]);
  assert.equal(facts.failedWithoutFailedUnit, false);
});

test("a run that failed with no failed attempt says so, and an old unit with no attempts stands for one", () => {
  const facts = workflowFacts(trace("failed", [unit("a", null, "completed", [])]));
  assert.equal(facts.failedWithoutFailedUnit, true);
  assert.deepEqual(facts.engines, [{ engine: "Not recorded", attempts: 1, failed: 0, tokens: 0, unreported: 1 }]);
  assert.equal(workflowFacts(trace("completed", [])).failedWithoutFailedUnit, false);
});
