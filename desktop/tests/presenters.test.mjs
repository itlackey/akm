// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import assert from "node:assert/strict";
import test from "node:test";
import {
  attentionItems,
  duration,
  healthGroup,
  percent,
  rollingSearch,
  runTimelineRows,
  tokens,
} from "../src/lib/activity-presenter.ts";
import { pageTitle } from "../src/lib/page-title.ts";
import { configurationChanges } from "../src/lib/settings-presenter.ts";

test("activity/settings presentation keeps measured zero separate from missing observations", () => {
  assert.equal(duration(0), "0 ms");
  assert.equal(duration(null), "Not recorded");
  assert.equal(percent(0), "0%");
  assert.equal(percent(null), "Not measured");
  assert.equal(tokens({ calls: 2, usageCalls: 0, totalTokens: 0 }), "Not reported");
  assert.equal(tokens({ calls: 0, usageCalls: 0, totalTokens: 0 }), "0");
  const checks = [{ name: "connections-and-harnesses", status: "unknown", message: "No model configured" }];
  assert.equal(healthGroup(checks[0], checks), "off");
  assert.equal(healthGroup({ name: "cli-version", status: "unknown", message: "Not probed" }, checks), "unchecked");
  // Not run, could not run, and run with nothing to report are three different things (F9, F17).
  const unknown = (name, message) => healthGroup({ name, status: "unknown", message }, []);
  assert.equal(
    unknown("state-db-round-trip", "state.db append/read round-trip skipped: this run is read-only."),
    "unchecked",
  );
  assert.equal(
    unknown("scheduler-binary", "No scheduler is available on this host (crontab -l failed: …)."),
    "unchecked",
  );
  assert.equal(
    unknown("cli-version", "akm v1 is installed; the update check could not reach the release source."),
    "blocked",
  );
  assert.equal(
    unknown("plugin-version", "akm@akm-plugins: installed 1 — the newest release could not be read"),
    "blocked",
  );
  assert.equal(unknown("session-extraction", "No extraction recorded in the last 7 days."), "idle");
  assert.deepEqual(
    configurationChanges(
      [
        { key: "search.defaultExcludeTypes", label: "Hide", kind: "list" },
        { key: "defaultWriteTarget", label: "Target" },
      ],
      { "search.defaultExcludeTypes": "", defaultWriteTarget: "personal" },
      { "search.defaultExcludeTypes": "memory, script", defaultWriteTarget: "" },
    ),
    { set: { "search.defaultExcludeTypes": '["memory","script"]' }, unset: ["defaultWriteTarget"] },
  );
});

test("attention ranks real faults before review work and never treats unknown runs as failures", () => {
  const data = {
    health: {
      status: "warn",
      hardChecks: [{ name: "disk", status: "fail", message: "Full" }],
      advisories: [{ name: "index", status: "warn", message: "Stale" }],
    },
    improveRuns: [{ ok: null }, { ok: false }],
  };
  const pulse = {
    tiles: { runs: { failedTasks: [] } },
    attention: { pending: { count: 3 }, misses: { queries: 1 }, harm: { reverted: 0 }, setup: null },
  };
  const items = attentionItems(data, pulse);
  assert.deepEqual(
    items.map((item) => item.tone),
    ["fail", "fail", "warn", "work", "work"],
  );
  assert.equal(items[0].text, "1 failing check");
  assert.equal(items[1].text, "1 failed improve run in latest records");
  // The view names the check by its label, so the item carries the id apart from the text (F16).
  assert.equal(items[2].text, "1 health warning");
  assert.equal(items[2].check, "index");
  assert.equal(items[3].href, "/review");
  assert.equal(items[3].text, "3 proposals waiting for review");
  assert.equal(items[4].text, "1 query found nothing on multiple days");
  assert.equal(attentionItems({ health: null, improveRuns: [{ ok: null }] }, null).length, 0);
});

test("rolling retrieval does not turn missing daily observations into measured zero", () => {
  const today = new Date().toISOString().slice(0, 10);
  const sparse = { daily: [{ date: today, searches: 10, zeroResults: 0, medianMs: 1 }], weekly: [], centre: null };
  assert.equal(rollingSearch(sparse, [], 7).rates.at(-1), null);
  const complete = {
    ...sparse,
    daily: Array.from({ length: 7 }, (_, i) => ({
      date: new Date(Date.now() - (6 - i) * 86400000).toISOString().slice(0, 10),
      searches: 1,
      zeroResults: 0,
      medianMs: 1,
    })),
  };
  assert.equal(rollingSearch(complete, [], 7).rates.at(-1), 100);
});

test("every view has a document title of its own, most specific part first", () => {
  const title = (address) => pageTitle(new URL(address, "http://desktop.test"));
  assert.equal(title("/"), "Home · AKM Desktop");
  assert.equal(title("/setup"), "Set up · AKM Desktop");
  assert.equal(title("/library/search"), "Search · Library · AKM Desktop");
  assert.equal(title("/library/search?tab=misses"), "Search gaps · Library · AKM Desktop");
  assert.equal(
    title("/library/search?ref=personal%2F%2Fknowledge%2Frestore-laptop"),
    "restore laptop · Library · AKM Desktop",
  );
  assert.equal(
    title("/library/asset?ref=personal%2F%2Fknowledge%2Frestore-laptop"),
    "restore laptop · Library · AKM Desktop",
  );
  assert.equal(title("/library/files?bundle=personal&path=knowledge"), "Files · Library · AKM Desktop");
  assert.equal(
    title("/library/files?bundle=personal&path=notes&file=notes%2Ftodo.txt&open=1"),
    "todo.txt · Library · AKM Desktop",
  );
  assert.equal(title("/library/search?compare=a%2F%2Fx&compare=b%2F%2Fy"), "Compare assets · Library · AKM Desktop");
  assert.equal(
    title("/library/edit?ref=personal%2F%2Fknowledge%2Frestore-laptop"),
    "Edit restore laptop · Library · AKM Desktop",
  );
  assert.equal(title("/library/new"), "New knowledge · Library · AKM Desktop");
  assert.equal(title("/library/new-sensitive?kind=secret"), "New secret · Library · AKM Desktop");
  assert.equal(title("/review"), "Pending · Review · AKM Desktop");
  assert.equal(title("/review?status=recent"), "Recent decisions · Review · AKM Desktop");
  assert.equal(title("/review/8f0c"), "Proposal · Review · AKM Desktop");
  assert.equal(title("/activity/overview"), "Health · Activity · AKM Desktop");
  assert.equal(title("/activity/overview?view=runs"), "Runs · Activity · AKM Desktop");
  assert.equal(title("/activity/overview?view=retrieval"), "Usage & retrieval · Activity · AKM Desktop");
  assert.equal(title("/activity/improve"), "Improve impact · Activity · AKM Desktop");
  assert.equal(title("/activity/history"), "Source history · Activity · AKM Desktop");
  assert.equal(title("/settings/bundles"), "Bundles & index · Settings · AKM Desktop");
  assert.equal(title("/settings/config"), "Configuration · Settings · AKM Desktop");
  assert.equal(title("/projects"), "Projects · AKM Desktop");
  assert.equal(title("/projects/docs"), "docs · Projects · AKM Desktop");
  assert.equal(title("/projects/docs/edit"), "Edit docs · Projects · AKM Desktop");
});

test("the run timeline draws only what akm recorded inside the window: a row per task, per workflow, then improve and index", () => {
  const window = { since: "2026-11-01T00:00:00.000Z", until: "2026-11-11T00:00:00.000Z" };
  const data = {
    health: null,
    taskFailures: null,
    metrics: {
      window,
      tasks: { runs: 3, failed: 1, byTask: [] },
      index: { runs: 40, recent: [{ at: "2026-11-10T08:00:00.000Z", mode: "incremental", totalMs: 900 }] },
    },
    improveRuns: [
      { startedAt: "2026-11-09T02:00:00.000Z", ok: false, durationMs: 60000 },
      { startedAt: "2026-11-08T02:00:00.000Z", ok: null, durationMs: null },
      { startedAt: "2026-10-20T02:00:00.000Z", ok: true, durationMs: 1000 },
    ],
  };
  const task = (taskId, status, startedAt, trigger) => ({
    taskId,
    status,
    startedAt,
    finishedAt: null,
    durationMs: 5,
    trigger,
  });
  const taskRuns = [
    task("tasks/sync", "completed", "2026-11-10T00:00:00.000Z", "schedule"),
    task("tasks/sync", "failed", "2026-11-09T00:00:00.000Z", "manual"),
    task("tasks/a", "blocked", "2026-11-08T00:00:00.000Z", null),
    task("tasks/old", "completed", "2026-10-01T00:00:00.000Z", null),
  ];
  const workflowRuns = [
    {
      id: "run-1",
      workflowRef: "workflows/release",
      title: "Release",
      status: "completed",
      createdAt: "2026-11-10T01:00:00.000Z",
      updatedAt: "2026-11-10T01:05:00.000Z",
      completedAt: "2026-11-10T01:05:00.000Z",
      harness: "claude",
      session: null,
    },
  ];
  const rows = runTimelineRows(data, taskRuns, workflowRuns);
  // A run before the window is not drawn, and a task with none inside it has no row.
  assert.deepEqual(
    rows.map((row) => [row.name, row.task, row.runs.map((run) => run.tone)]),
    [
      ["tasks/a", "tasks/a", ["other"]],
      ["tasks/sync", "tasks/sync", ["ok", "fail"]],
      ["Workflow Release", undefined, ["ok"]],
      ["Improve", undefined, ["fail", "other"]],
      ["Index builds", undefined, ["ok"]],
    ],
  );
  assert.deepEqual(
    rows[1].runs.map((run) => run.said),
    ["completed, started by the schedule", "failed, started by hand"],
  );
  assert.deepEqual(rows[2].runs[0], {
    at: "2026-11-10T01:00:00.000Z",
    tone: "ok",
    durationMs: 300000,
    said: "completed, started by claude",
    runId: "run-1",
  });
  assert.equal(rows[3].runs[1].said, "outcome not recorded");
  assert.deepEqual(runTimelineRows({ ...data, metrics: null }, taskRuns, workflowRuns), []);
});
