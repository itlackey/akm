// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { chromium, expect } from "@playwright/test";
import { akm, launchFixture, open, runViewIds } from "./support.mjs";

// The single-run views: an improve run, a task run and a workflow run, each with its outcome, what failed and the
// recorded error detail; an improve run is not linked to a task run unless akm records the link.
test("run views show outcomes, failures and error detail, and guess no link between an improve run and a task run", {
  timeout: 240000,
}, async (t) => {
  const server = await launchFixture({ metrics: true, runViews: true });
  t.after(() => server.stop());
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const runs = "/activity/overview?view=runs";

  await t.test("the summary counts a run with no recorded end as unknown, not completed", async () => {
    await open(page, server, runs);
    const summary = page.getByRole("region", { name: "How runs ended in this window" });
    await expect(summary).toContainText("3 completed · 3 failed · 1 unknown");
    await expect(summary).toContainText("1 completed · 1 failed · 1 unknown");
    await expect(summary).toContainText("No error recorded is Unknown, not Completed");
  });

  await t.test("a failed improve run shows its failing processes and offers no guessed task run", async () => {
    await open(page, server, `${runs}&improve=${runViewIds.failedImprove}&anchor=improve-run`);
    const view = page.getByRole("region", { name: "Improve run details", exact: true });
    await expect(view).toContainText("Failed");
    const calls = view.getByRole("table", { name: "Run usage by process, execution target and model" });
    const reflect = calls.getByRole("row", { name: /reflect/ });
    await expect(reflect).toContainText("▲ 3");
    await expect(reflect).toContainText("lab");
    await expect(reflect).toContainText("synthetic-model");
    await expect(reflect).toContainText("5,000 (3 of 5 calls)");
    await expect(calls.getByRole("row", { name: /consolidate/ })).toContainText("Not reported");
    await expect(view).toContainText("distill (no_signal)");
    await expect(view).toContainText("Synthetic: model timed out");
    await expect(view).not.toContainText("cannot show the model");
    // A task run that started within minutes of it (the fixture has one) is not offered as its cause.
    await expect(view).not.toContainText("Matched by time");
    await expect(view).not.toContainText("Synthetic: the connection refused the request");
  });

  await t.test("an improve run without a usage report says so instead of showing zero", async () => {
    await open(page, server, `${runs}&improve=${runViewIds.oldImprove}&anchor=improve-run`);
    const view = page.getByRole("region", { name: "Improve run details", exact: true });
    await expect(view).toContainText("No model calls are recorded for this run");
    await expect(view).not.toContainText("scheduled task run");
  });

  await t.test("an improve run older than the latest ten opens by id and shows that it was terminated", async () => {
    await open(page, server, `${runs}&improve=${runViewIds.terminatedImprove}&anchor=improve-run`);
    const view = page.getByRole("region", { name: "Improve run details", exact: true });
    await expect(view).toContainText("Terminated");
    await expect(view).toContainText("SIGTERM");
    await expect(view).toContainText("Synthetic: stopped by the scheduler timeout");
    // It is brought into view, not left at the bottom of the page.
    await expect(view).toBeInViewport();
  });

  await t.test("an improve run id can be typed in, and an unknown one is named, not guessed", async () => {
    await open(page, server, runs);
    await page.getByLabel("Improve run ID").fill(runViewIds.terminatedImprove);
    await page.getByRole("button", { name: "Open run" }).click();
    await expect(page.getByRole("region", { name: "Improve run details", exact: true })).toContainText("SIGTERM");
    await page.getByLabel("Improve run ID").fill("no-such-run");
    await page.getByRole("button", { name: "Open run" }).click();
    await expect(page.getByText("No improve run with the id no-such-run is recorded")).toBeVisible();
  });

  await t.test("a task run that never recorded an end is unknown", async () => {
    await open(page, server, `${runs}&task=nightly-digest`);
    const task = page.getByRole("region", { name: "Task run details", exact: true });
    await task.getByRole("button", { name: /^Open run started/ }).click();
    await expect(task).toContainText("Unknown (active)");
    await expect(task).toContainText("unknown, not succeeded");
  });

  await t.test("a task run that ran a workflow links to it by run id, and links no improve run", async () => {
    await open(page, server, `${runs}&task=weekly-review`);
    const task = page.getByRole("region", { name: "Task run details", exact: true });
    await task
      .getByRole("button", { name: /^Open run started/ })
      .first()
      .click();
    await expect(task).toContainText("Matched by run id");
    await task.getByRole("link", { name: "Open the workflow run this task ran" }).click();
    await expect(page.getByRole("region", { name: "Workflow run trace" })).toBeVisible();
    await open(page, server, `${runs}&task=akm-improve-frequent`);
    const frequent = page.getByRole("region", { name: "Task run details", exact: true });
    await frequent
      .getByRole("row", { name: /failed/ })
      .getByRole("button", { name: /^Open run started/ })
      .click();
    await expect(frequent).toContainText("Run started");
    await expect(frequent).not.toContainText("Matched by time");
    await expect(frequent.getByRole("link", { name: runViewIds.failedImprove })).toHaveCount(0);
    // What the run executed comes from akm's history row, and its output from the task log (the fixture has none).
    await expect(frequent).toContainText("Agent");
    await frequent.getByText("Log output").click();
    await expect(frequent).toContainText("no task log database");
  });

  await t.test("a failed workflow run lists its failed attempts in order and its tokens by target", async () => {
    await open(page, server, `${runs}&run=${runViewIds.failedWorkflow}&anchor=workflow-trace`);
    const trace = page.getByRole("region", { name: "Workflow run trace" });
    const failures = trace.getByRole("table", { name: "Failed attempts in the order they ended" });
    await expect(failures.getByRole("row")).toHaveCount(3);
    await expect(failures).toContainText("provider_error");
    const usage = trace.getByRole("table", { name: "Tokens by execution target" });
    await expect(usage.getByRole("row", { name: /lab/ })).toContainText("1,200");
    await expect(usage.getByRole("row", { name: /cloud/ })).toContainText("800");
    await expect(trace).toContainText("Failed");
  });

  await t.test("a workflow run still active is unknown, and shows no failure", async () => {
    await open(page, server, `${runs}&run=${runViewIds.activeWorkflow}&anchor=workflow-trace`);
    const trace = page.getByRole("region", { name: "Workflow run trace" });
    await expect(trace).toContainText("Unknown (running)");
    await expect(trace).toContainText("No failed attempt is recorded for this run.");
  });

  assert.deepEqual(errors, []);
});

// A chart's tooltip is drawn on the page, so neither a short chart nor the window's edge cuts it off.
test("chart tooltips stay inside the window, over a strip chart and at a narrow width", {
  timeout: 120000,
}, async (t) => {
  const server = await launchFixture({ metrics: true, runViews: true });
  t.after(() => server.stop());
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  for (const viewport of [
    { width: 1280, height: 900 },
    { width: 390, height: 800 },
  ]) {
    const page = await browser.newPage({ viewport });
    await open(page, server, "/activity/overview?view=usage");
    const strip = page.locator('.echarts-view[data-height="strip"]');
    await strip.scrollIntoViewIfNeeded();
    const box = await strip.boundingBox();
    assert.ok(box, "the strip chart is drawn");
    // Sweep the strip: wherever a mark's tooltip shows, the whole of it is inside the window.
    let shown = 0;
    for (let x = box.x + 2; x < box.x + box.width; x += 4) {
      await page.mouse.move(x, box.y + box.height / 2);
      const tip = await page.evaluate(() => {
        for (const el of document.querySelectorAll("body > div")) {
          if (el.style.pointerEvents !== "none" || !el.textContent.trim() || getComputedStyle(el).opacity === "0")
            continue;
          const r = el.getBoundingClientRect();
          return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, wide: innerWidth, high: innerHeight };
        }
        return null;
      });
      if (!tip) continue;
      shown++;
      assert.ok(tip.left >= 0 && tip.top >= 0 && tip.right <= tip.wide && tip.bottom <= tip.high, JSON.stringify(tip));
    }
    assert.ok(shown > 0, `a tooltip showed at ${viewport.width}px`);
    await page.close();
  }
});

// A state.db that does not exist is not an empty one: every figure read from it says so and gives akm's reason.
test("with no state.db the Runs, Usage and search-gap views say it is absent, not that nothing was recorded", {
  timeout: 240000,
}, async (t) => {
  const server = await launchFixture({
    configureFixture: async (fixture) => fs.rm(path.join(fixture.root, "data", "state.db"), { force: true }),
  });
  t.after(() => server.stop());
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  const absent = "state database";

  await open(page, server, "/activity/overview?view=runs");
  const summary = page.getByRole("region", { name: "How runs ended in this window" });
  await expect(summary).toContainText(absent);
  await expect(summary).not.toContainText("No runs recorded");
  await expect(page.locator("#workflow-runs")).toContainText(absent);
  await expect(page.locator("#workflow-runs")).not.toContainText("No workflow runs in this window");

  await open(page, server, "/activity/overview?view=usage");
  await expect(page.locator("#search-gaps")).toContainText(absent);
  await expect(page.locator("#search-gaps")).not.toContainText("No query found nothing");
  await expect(page.getByText("Usage and model measurements unavailable.")).toBeVisible();
  await expect(page.getByLabel("Selected-window activity")).toHaveCount(0);
});

// The Usage summary counts what happened in the window, so it names the proposals it counts by what akm counts: the
// ones updated in the window, not the queue (the queue is the badge on Review and Needs attention).
test("the Usage summary names the proposals updated in the window and does not call them the queue", {
  timeout: 240000,
}, async (t) => {
  const server = await launchFixture({ metrics: true, proposals: true });
  t.after(() => server.stop());
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  await open(page, server, "/activity/overview?view=usage&window=7d");
  const summary = page.getByLabel("Selected-window activity");
  await expect(summary).toContainText("3 proposals updated in this window");
  await expect(summary).not.toContainText("pending proposals");
});

// The list under "Repeated search gaps" is the queries akm marks `repeated` (nothing on two or more days); a query
// that came back empty once is counted in the sentence above it, not listed as a gap.
test("Repeated search gaps lists only the queries akm marks as repeated", {
  timeout: 240000,
}, async (t) => {
  const server = await launchFixture({
    configureFixture: async (fixture) => akm(fixture, ["search", "zzqx unmatched phrase"]),
  });
  t.after(() => server.stop());
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  await open(page, server, "/activity/overview?view=usage");
  const gaps = page.locator("#search-gaps");
  await expect(gaps).toContainText("1 of 1 searches returned no results");
  await expect(gaps).not.toContainText("zzqx unmatched phrase");
  await expect(gaps).toContainText("No query found nothing on more than one day in this window.");
});

// akm says where its usage figures start and which changes have a before side it did not keep: the table says "Not
// recorded" for that side, never a zero.
test("Improve impact says where the usage figures start and shows an unkept before side as not recorded", {
  timeout: 240000,
}, async (t) => {
  const server = await launchFixture({ metrics: true });
  t.after(() => server.stop());
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  await page.route("**/api/improve/impact*", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    const data = body.data ?? body;
    data.usageComplete = false;
    data.usageSince = "2026-08-20T00:00:00.000Z";
    data.changedAssets = [
      {
        ref: "stash//knowledge/old-change",
        source: "reflect",
        outcome: "judge",
        decidedAt: "2026-08-25T00:00:00.000Z",
        before: { hits: 0, negative: 0 },
        after: { hits: 3, negative: 1 },
        complete: true,
        beforeComplete: false,
        afterDays: 28,
      },
    ];
    await route.fulfill({ response, json: body });
  });
  await open(page, server, "/activity/improve?since=365d");
  const row = page.getByRole("row", { name: /old-change/ });
  await expect(row).toContainText("Not recorded → 3");
  await expect(row).toContainText("Not recorded → 1");
  await expect(page.locator(".impact-summary")).toContainText("cover usage only from");
});

// akm marks the weeks it has only part of and says whether it has enough whole weeks for a usual range: the chart
// shows a partial week as partial and draws no range or verdict from a week or two of searches.
test("the weekly retrieval chart marks partial weeks and claims no usual range without enough history", {
  timeout: 240000,
}, async (t) => {
  const server = await launchFixture({ metrics: true });
  t.after(() => server.stop());
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  await open(page, server, "/activity/overview?view=usage&window=7d");
  const rate = page.getByRole("region", { name: "Is search finding what you need?" });
  await expect(rate).toContainText("Too few whole weeks for a usual range");
  await expect(rate).not.toContainText("Band: usual range");
  await rate.getByRole("button", { name: "Table" }).click();
  const table = rate.getByRole("table", { name: "Weekly retrieval and control bands" });
  await expect(table.getByRole("row").nth(1)).toContainText("(partial week)");
  await expect(table.getByRole("row").nth(1)).toContainText("Partial week");
  await expect(table).not.toContainText("Within range");
  await expect(table).not.toContainText("Unusual");
});

// Replay plays the person's events unless asked for everyone's, and says which it shows: the figures change with the
// choice, and a curate is counted as a curate, not as a search.
test("Replay: You and Everyone show different figures under their own labels", { timeout: 240000 }, async (t) => {
  const server = await launchFixture({ metrics: true });
  t.after(() => server.stop());
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  const now = Date.now();
  const at = (minutesAgo) => new Date(now - minutesAgo * 60_000).toISOString();
  const row = (id, minutes, eventType, source, extra = {}) => ({
    id,
    at: at(minutes),
    eventType,
    source,
    byPerson: source === "user",
    ...extra,
  });
  await page.route("**/api/events?since=24h", (route) =>
    route.fulfill({
      json: {
        ok: true,
        data: {
          available: true,
          truncated: false,
          window: { since: at(24 * 60), until: at(0) },
          events: [
            row(1, 50, "search", "user", { query: "backup", resultCount: 2 }),
            row(2, 40, "search", "user", { query: "nothing here", resultCount: 0 }),
            row(3, 30, "search", "improve", { query: "agent one", resultCount: 1 }),
            row(4, 20, "search", "improve", { query: "agent two", resultCount: 0 }),
            row(5, 10, "curate", "improve", { query: "agent curate", resultCount: 1 }),
          ],
        },
      },
    }),
  );
  await open(page, server, "/activity/replay");
  const replay = page.getByRole("region", { name: "Activity replay", exact: true });
  const figures = replay.locator(".figures");
  await expect(figures).toContainText(/2\s*searches/);
  await expect(figures).toContainText(/0\s*curates/);
  await expect(figures).toContainText(/1\s*found nothing/);
  await replay.getByLabel("Events by").selectOption({ label: "Everyone: you, agents and automation" });
  await expect(figures).toContainText(/4\s*searches/);
  await expect(figures).toContainText(/1\s*curates/);
  await expect(figures).toContainText(/2\s*found nothing/);
  await replay.getByLabel("Events by").selectOption({ label: "You" });
  await expect(figures).toContainText(/2\s*searches/);
});
