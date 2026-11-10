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
  tokens,
} from "../src/lib/activity-presenter.ts";
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
  assert.match(items[1].text, /1 failed improve runs/);
  // The view names the check by its label, so the item carries the id apart from the text (F16).
  assert.equal(items[2].text, "1 health warnings");
  assert.equal(items[2].check, "index");
  assert.equal(items[3].href, "/review");
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
