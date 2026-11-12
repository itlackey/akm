// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium, expect } from "@playwright/test";
import { launchFixture, open, runViewIds } from "./support.mjs";

// The single-run views: an improve run, a task run and a workflow run, each with its outcome, what failed and the
// recorded error detail, and with a match by time named as one.
test("run views show outcomes, failures and error detail, and mark what is matched by time", {
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

  await t.test("a failed improve run shows its failing processes and the task run matched by time", async () => {
    await open(page, server, `${runs}&improve=${runViewIds.failedImprove}&anchor=improve-run`);
    const view = page.getByRole("region", { name: "Improve run details", exact: true });
    await expect(view).toContainText("Failed");
    const calls = view.getByRole("table", { name: "Run calls by process" });
    await expect(calls.getByRole("row", { name: /reflect/ })).toContainText("▲ 3");
    await expect(view).toContainText("no record of an improve run carries the id", { ignoreCase: true });
    await expect(view).toContainText("Matched by time");
    await expect(view).toContainText("Synthetic: the connection refused the request");
    await expect(view).toContainText("agent_failed");
  });

  await t.test("an improve run without a usage report says so instead of showing zero", async () => {
    await open(page, server, `${runs}&improve=${runViewIds.oldImprove}&anchor=improve-run`);
    const view = page.getByRole("region", { name: "Improve run details", exact: true });
    await expect(view).toContainText("No model calls are recorded for this run");
    await expect(view).toContainText("No scheduled task run started within 5 minutes");
  });

  await t.test("an improve run akm does not return here is named, not guessed", async () => {
    await open(page, server, `${runs}&improve=no-such-run`);
    await expect(page.getByText("is not among the latest 10 improve runs")).toBeVisible();
  });

  await t.test("a task run that never recorded an end is unknown", async () => {
    await open(page, server, `${runs}&task=nightly-digest`);
    const task = page.getByRole("region", { name: "Task run details", exact: true });
    await task.getByRole("button", { name: /^Open run started/ }).click();
    await expect(task).toContainText("Unknown (active)");
    await expect(task).toContainText("unknown, not succeeded");
  });

  await t.test(
    "a task run that ran a workflow links to it by run id, and one that started an improve run by time",
    async () => {
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
      await expect(frequent).toContainText("Matched by time");
      await frequent.getByRole("link", { name: runViewIds.failedImprove }).click();
      await expect(page.getByRole("region", { name: "Improve run details", exact: true })).toContainText(
        runViewIds.failedImprove,
      );
    },
  );

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
