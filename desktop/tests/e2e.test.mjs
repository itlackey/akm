// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import assert from "node:assert/strict";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { chromium, expect } from "@playwright/test";
import { akm, go, launchFixture, open } from "./support.mjs";

// Wiring only: each section shows what its operations return, reaches them, and shows a refusal. What the operations
// decide (revisions, leases, staleness, write targets) is akm's and is tested there.
test("built desktop UI: each section's happy path and one refusal", { timeout: 240000 }, async (t) => {
  const server = await launchFixture({ proposals: true, metrics: true, similarity: true });
  t.after(() => server.stop());
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const screenshots = process.env.AKM_DESKTOP_SCREENSHOTS || path.join(server.root, "screenshots");
  await mkdir(screenshots, { recursive: true });
  const nav = (name) =>
    page
      .getByRole("navigation", { name: "Primary navigation" })
      .getByRole("link", { name: new RegExp(`^${name}(?:\\s|$)`) });
  const editor = () => page.getByRole("textbox", { name: "Markdown source, including optional frontmatter" });
  const searchBox = page.getByRole("searchbox", { name: "Search library" });
  const search = async (query) => {
    await searchBox.fill(query);
    const response = page.waitForResponse((r) => r.url().includes("/api/search?") && r.status() === 200);
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await response;
  };
  const openResult = (text) =>
    page
      .getByRole("region", { name: "Search results" })
      .getByRole("link")
      .filter({ hasText: text.replaceAll("-", " ") })
      .first()
      .click();
  /** Answer the next call to `pattern` with an error, as the server would. */
  const refuse = (pattern, status, code, error) =>
    page.route(pattern, (route) => route.fulfill({ status, json: { ok: false, code, error } }), { times: 1 });

  await open(page, server);

  await t.test("Home: shows the workspace; a failed read is an error with a retry", async () => {
    await expect(page.getByRole("heading", { name: "Overview", exact: true })).toBeVisible();
    await expect(page.locator(".host")).toContainText("AKM");
    await page.screenshot({ path: path.join(screenshots, "home-desktop.png"), fullPage: true });
    await refuse("**/api/overview?*", 500, "INTERNAL_ERROR", "The overview failed.");
    await page.getByRole("button", { name: "Check health", exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: "The overview failed." })).toBeVisible();
    await page.getByRole("button", { name: "Retry overview", exact: true }).click();
    await expect(page.getByRole("alert")).toHaveCount(0);
  });

  await t.test(
    "Library: related assets list a stored-embedding match with its score (before any edit re-indexes it)",
    async () => {
      await go(page, `/library/asset?ref=${encodeURIComponent(server.refs.document)}`);
      await page.getByRole("button", { name: "Related assets", exact: true }).click();
      await page.getByRole("button", { name: "Similar content", exact: true }).click();
      await expect(page.locator(".related-list")).toContainText("Shared backup");
      await expect(page.locator(".score")).toContainText("0.994");
      await go(page, "/library/search");
    },
  );

  await t.test("Library: search, read, edit and save; a concurrent change keeps the draft", async () => {
    await nav("Library").click();
    await expect(page).toHaveURL(/\/library\/search/);
    await search("backup");
    await openResult("restore-laptop");
    await expect(page.locator(".markdown")).toContainText("Verify the checksum");
    await page.screenshot({ path: path.join(screenshots, "library-desktop.png"), fullPage: true });
    await page.getByRole("link", { name: "Edit page", exact: true }).click();
    const draft = `${await editor().inputValue()}\nHuman edit from the desktop.\n`;
    await editor().fill(draft);
    await writeFile(server.documentPath, `${server.content}\nConcurrent edit from another client.\n`);
    await page.getByRole("button", { name: "Save changes", exact: true }).click();
    await expect(page.getByRole("heading", { name: "A newer version exists" })).toBeVisible();
    assert.equal(await editor().inputValue(), draft);
    await expect(page.locator(".conflict")).toContainText("Concurrent edit from another client.");
    await editor().fill(`${draft}\nConcurrent edit from another client.\n`);
    await page.getByRole("button", { name: "Save reviewed version", exact: true }).click();
    await expect(page.locator(".document-body")).toContainText("Human edit from the desktop.");
    assert.match(await readFile(server.documentPath, "utf8"), /Concurrent edit from another client/);
  });

  await t.test("Library: a read-only bundle's asset cannot be edited", async () => {
    await go(page, "/library/search");
    await search("vendor-backup");
    await openResult("vendor-backup");
    await expect(page.locator(".markdown")).toContainText("Use the vendor tool.");
    await expect(page.getByRole("link", { name: "Edit page", exact: true })).toHaveCount(0);
  });

  await t.test("Library: create knowledge; copy a skill; a refused copy changes nothing", async () => {
    await nav("Library").click();
    await page.goto(`${server.origin}/library/files?bundle=personal&path=knowledge`);
    await page.getByRole("link", { name: /New knowledge/ }).click();
    await page.getByRole("textbox", { name: "File name", exact: true }).fill("desktop-created");
    await editor().fill("# Desktop created\n\nA synthetic note written by the UI through AKM.\n");
    await page.getByRole("button", { name: "Create knowledge", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Changes saved." })).toBeVisible();
    assert.match(
      await readFile(path.join(server.root, "personal/knowledge/desktop-created.md"), "utf8"),
      /synthetic note written/,
    );
    await page.goto(`${server.origin}/library/asset?ref=${encodeURIComponent(server.refs.skill)}`);
    await page.getByRole("button", { name: "More", exact: true }).click();
    await page.getByRole("button", { name: "Copy to bundle…", exact: true }).click();
    await page.getByRole("combobox", { name: "Destination bundle", exact: true }).selectOption("shared");
    await page.getByRole("button", { name: "Confirm copy", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Copy completed" })).toBeVisible();
    assert.match(await readFile(path.join(server.root, "shared/skills/backup-check/SKILL.md"), "utf8"), /backup-check/);
    // A second copy to the same place is refused by akm; the page shows why and leaves the first copy alone.
    await page.getByRole("button", { name: "More", exact: true }).click();
    await page.getByRole("button", { name: "Copy to bundle…", exact: true }).click();
    await page.getByRole("combobox", { name: "Destination bundle", exact: true }).selectOption("shared");
    await page.getByRole("button", { name: "Confirm copy", exact: true }).click();
    await expect(page.getByRole("alert")).toBeVisible();
  });

  await t.test("Library: a move copies, then retires the original", async () => {
    await page.goto(`${server.origin}/library/files?${new URLSearchParams({ ref: server.refs.memory, open: "1" })}`);
    await page.getByRole("button", { name: "More", exact: true }).click();
    await page.getByRole("button", { name: "Rename or move…", exact: true }).click();
    await page.getByRole("combobox", { name: "Bundle", exact: true }).selectOption("shared");
    await page.getByRole("textbox", { name: "Name or folder/name", exact: true }).fill("moved-preference");
    await page.getByRole("button", { name: "Move", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Move completed", exact: true })).toBeVisible();
    assert.match(await readFile(path.join(server.root, "shared/memories/moved-preference.md"), "utf8"), /offline copy/);
    await assert.rejects(stat(path.join(server.root, "personal/memories/backup-preference.md")), { code: "ENOENT" });
  });

  await t.test("Review: accept a proposal; a refused decision shows its reason and nothing changes", async () => {
    await nav("Review").click();
    await expect(page.getByRole("heading", { name: "Review", exact: true })).toBeVisible();
    await page
      .getByRole("region", { name: "Proposals" })
      .getByRole("link")
      .filter({ hasText: "review example" })
      .click();
    await page.getByRole("button", { name: "Reject…", exact: true }).click();
    await page.getByRole("textbox", { name: "Details" }).fill("Synthetic review: verify the evidence first.");
    await refuse("**/api/proposals/*/reject", 409, "PROPOSAL_NOT_PENDING", "This proposal is no longer pending.");
    await page.getByRole("button", { name: "Confirm reject", exact: true }).click();
    // A refused write is not recorded, nothing advances, and the reviewer's input stays.
    await expect(page.getByRole("alert").filter({ hasText: "The decision was not recorded." })).toContainText(
      "no longer pending",
    );
    await expect(page.getByRole("textbox", { name: "Details" })).toHaveValue(/verify the evidence/);
    await expect(page.getByRole("heading", { name: "review example", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Confirm reject", exact: true }).click();
    // The next proposal opens by itself, and a toast (no Dismiss step) says what was rejected, with Reopen….
    await expect(page.getByRole("status").filter({ hasText: "Rejected “review example”" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "review example", exact: true })).toHaveCount(0);
    await expect(
      page.getByRole("region", { name: "Proposal detail" }).getByRole("heading", { level: 2 }),
    ).toBeFocused();
    await expect(page.getByRole("region", { name: "Proposal detail" }).getByText(/^Last: Rejected/)).toBeVisible();
    await page
      .getByRole("region", { name: "Proposals" })
      .getByRole("link")
      .filter({ hasText: "recovery checklist" })
      .click();
    await page.screenshot({ path: path.join(screenshots, "review-desktop.png"), fullPage: true });
    await page.getByRole("button", { name: "Accept…", exact: true }).click();
    await page.getByRole("button", { name: "Confirm accept", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Accepted “recovery checklist”" })).toBeVisible();
    assert.match(
      await readFile(path.join(server.root, "personal/knowledge/recovery-checklist.md"), "utf8"),
      /Preserve the original backup/,
    );
    await expect(nav("Review")).not.toContainText("3");
  });

  await t.test("Activity: opens its views from recorded measurements; a failed read is shown", async () => {
    await nav("Activity").click();
    await expect(page.getByRole("heading", { name: "Health", exact: true })).toBeVisible();
    await page.screenshot({ path: path.join(screenshots, "activity-desktop.png"), fullPage: true });
    await page.getByRole("link", { name: "Improve impact", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Is review keeping up?", exact: true })).toBeVisible();
    await refuse("**/api/improve/impact*", 500, "INTERNAL_ERROR", "Impact could not be read.");
    await page.reload();
    await expect(page.getByText("Impact could not be read.")).toBeVisible();
  });

  await t.test("Activity: a recorded task run and an improve run open in place; Back returns focus", async () => {
    await go(page, "/activity/overview?view=runs");
    await page.getByRole("button", { name: "synthetic-failure", exact: true }).click();
    const task = page.getByRole("region", { name: "Task run details", exact: true });
    await expect(task).toBeFocused();
    await expect(task).toContainText("failed");
    await task.getByText("timeout", { exact: true }).click();
    await expect(task).toContainText("Synthetic timeout");
    // The chart of the latest improve runs opens first; its table lists each run with a button.
    await page
      .getByRole("region", { name: "Latest improve runs", exact: true })
      .getByRole("button", { name: "Table", exact: true })
      .click();
    const inspect = page.getByRole("button", { name: "Inspect run synthetic-improve", exact: true });
    await inspect.click();
    const run = page.getByRole("region", { name: "Improve run details", exact: true });
    await expect(run.getByRole("table", { name: "Run usage by process, execution target and model" })).toContainText(
      "reflect",
    );
    await run.getByRole("button", { name: "Back to run records", exact: true }).click();
    await expect(inspect).toBeFocused();
  });

  await t.test("Activity: the run timeline draws the recorded runs and lists them as a table", async () => {
    await go(page, "/activity/overview?view=runs");
    const timeline = page.getByRole("region", { name: "Run timeline", exact: true });
    // One mark per recorded run: the failed task run, the improve run and the fixture's index build.
    await expect(timeline.locator("#activity-run-timeline svg")).toBeVisible();
    await timeline.getByRole("button", { name: "Table", exact: true }).click();
    const cells = (name) => timeline.getByRole("row", { name: new RegExp(`^${name}`) }).getByRole("cell");
    await expect(cells("synthetic-failure").nth(0)).toHaveText("1");
    await expect(cells("synthetic-failure").nth(1)).toHaveText("1");
    await expect(cells("Improve").nth(1)).toHaveText("0");
  });

  await t.test("Activity: a workflow run is listed and opens its trace", async () => {
    // A finished run with one step, written as akm's workflow engine journals it.
    const db = new DatabaseSync(path.join(server.root, "data", "state.db"));
    const at = new Date(Date.now() - 5 * 60000).toISOString();
    try {
      db.prepare(
        `INSERT INTO workflow_runs (id, workflow_ref, scope_key, workflow_entry_id, workflow_title, status, params_json,
           current_step_id, created_at, updated_at, completed_at, agent_harness)
         VALUES ('77777777-7777-4777-8777-777777777777', 'personal//workflows/release', 'dir:v1:x', NULL, 'Release check',
           'completed', '{}', NULL, ?, ?, ?, 'claude')`,
      ).run(at, at, at);
      db.prepare(
        `INSERT INTO workflow_run_steps (run_id, step_id, step_title, instructions, completion_json, sequence_index, status)
         VALUES ('77777777-7777-4777-8777-777777777777', 'collect', 'Collect changes', '', '[]', 0, 'completed')`,
      ).run();
    } finally {
      db.close();
    }
    // The page was already on Runs: Refresh reads the new run.
    await go(page, "/activity/overview?view=runs");
    await page.getByRole("button", { name: "Refresh activity", exact: true }).click();
    const runs = page.getByRole("table", { name: /Workflow runs started/ });
    await expect(runs).toContainText("claude");
    await runs.getByRole("link", { name: "Release check", exact: true }).click();
    const trace = page.getByRole("region", { name: "Workflow run trace", exact: true });
    await expect(trace).toBeFocused();
    await expect(trace.getByRole("heading", { name: "Release check" })).toBeVisible();
    await expect(trace).toContainText("Collect changes");
    await expect(trace).toContainText("No units recorded for this run yet.");
  });

  await t.test("Library: the map shows every asset by folder, and a folder's assets link to their pages", async () => {
    await go(page, "/library/map");
    await expect(page.getByRole("heading", { name: "Library map", exact: true })).toBeVisible();
    // The map keeps Library's tabs.
    await expect(page.getByRole("navigation", { name: "Library views" }).getByRole("link")).toHaveText([
      "Search",
      "Files",
      "Map",
    ]);
    const figures = page.getByRole("complementary", { name: "Figures" });
    // The fixture has no embeddings: the library is grouped by folder.
    await expect(figures.locator(".stats")).toContainText("folders");
    // Env and secret files are never on the map.
    await expect(figures.locator("table.groups")).not.toContainText("env");
    await figures.getByRole("button", { name: "knowledge", exact: true }).click();
    const detail = figures.locator(".detail");
    await expect(detail.getByRole("heading", { name: "knowledge" })).toBeVisible();
    await detail.locator(".assets a").first().click();
    await expect(page).toHaveURL(/\/library\/search\?ref=/);
    await expect(page.locator(".markdown")).toBeVisible();
  });

  await t.test("Activity: the replay plays the period's searches, reads and feedback", async () => {
    await go(page, "/activity/replay");
    const replay = page.getByRole("region", { name: "Activity replay", exact: true });
    await expect(replay.getByRole("slider", { name: "Time" })).toBeVisible();
    // At the end of the period the figures are the fixture's: three searches for "backup" and one that found nothing.
    await replay.getByRole("slider", { name: "Time" }).evaluate((input) => {
      input.value = input.max;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await expect(replay).toContainText("missing restore steps");
    await expect(replay.getByRole("rowheader", { name: /^No agent recorded \d+ events?$/ })).toBeVisible();
    await expect(replay.getByRole("button", { name: "Play", exact: true })).toBeEnabled();
  });

  await t.test("Activity: charts follow the chosen appearance", async () => {
    await go(page, "/activity/overview?view=retrieval");
    const label = page.locator("#activity-operations svg text").first();
    await expect(label).toBeVisible();
    const appearance = page.getByRole("combobox", { name: "Appearance" });
    await appearance.selectOption("light");
    await expect.poll(() => label.getAttribute("fill")).toBeTruthy();
    const light = await label.getAttribute("fill");
    await appearance.selectOption("dark");
    await expect.poll(() => label.getAttribute("fill")).not.toBe(light);
    await appearance.selectOption("system");
  });

  await t.test("Settings: a bundle setting persists; a refused save keeps the form", async () => {
    await nav("Settings").click();
    await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
    await page.screenshot({ path: path.join(screenshots, "settings-desktop.png"), fullPage: true });
    await page
      .getByRole("article", { name: "Bundle shared", exact: true })
      .getByRole("link", { name: "Manage shared", exact: true })
      .click();
    const management = page.getByRole("article", { name: "Manage bundle shared", exact: true });
    await management.getByRole("switch", { name: "Enabled", exact: true }).uncheck();
    await refuse("**/api/bundles/settings", 409, "CONFIG_CONFLICT", "The configuration changed. Reload it.");
    await management.getByRole("button", { name: "Save shared settings", exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: "The configuration changed" })).toBeVisible();
    await management.getByRole("button", { name: "Save shared settings", exact: true }).click();
    await expect(management.getByRole("button", { name: "Save shared settings", exact: true })).toBeEnabled();
    const config = JSON.parse(await readFile(path.join(server.root, "config/config.json"), "utf8"));
    assert.equal(config.bundles.shared.enabled, false);
    assert.deepEqual(errors, []);
  });
  await t.test(
    "Settings: Browse folders asks the app's folder dialog; outside the app it says so and typing still works",
    async () => {
      await go(page, "/settings/bundles");
      const source = page.getByLabel("Source", { exact: true });
      await source.fill("/tmp/typed-by-hand");
      const dialogRequest = page.waitForResponse((r) => r.url().endsWith("/api/desktop/pick-folder"));
      await page.getByRole("button", { name: "Browse folders…", exact: true }).click();
      const response = await dialogRequest;
      assert.equal(response.status(), 400);
      assert.equal((await response.json()).code, "FOLDER_DIALOG_FAILED");
      await expect(
        page.getByRole("alert").filter({ hasText: "folder dialog is available in the AKM Desktop app" }),
      ).toBeVisible();
      await expect(source).toHaveValue("/tmp/typed-by-hand");
      await expect(source).toBeFocused();
    },
  );
  console.log(`Screenshots: ${screenshots}`);
});

test("Library: the link map draws an asset's recorded links, both ways, and follows them", {
  timeout: 120000,
}, async (t) => {
  // A page that cross-references the restore checklist and a page nobody wrote.
  const server = await launchFixture({
    configureFixture: async (fixture) => {
      await writeFile(
        path.join(fixture.root, "personal/knowledge/recovery-index.md"),
        "---\ntitle: Recovery index\ndescription: Synthetic page of links\nxrefs:\n  - knowledge/restore-laptop\n  - knowledge/not-written-yet\n---\n# Recovery index\n\nSee the checklist.\n",
      );
      akm(fixture, ["index"]);
    },
  });
  t.after(() => server.stop());
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const map = page.getByRole("group", { name: /^Links of / });
  const openMap = async () => {
    await page.getByRole("button", { name: "Related assets", exact: true }).click();
    await page.getByRole("button", { name: "Link map", exact: true }).click();
  };
  await open(page, server, `/library/asset?ref=${encodeURIComponent("personal//knowledge/recovery-index")}`);
  await openMap();
  await expect(map).toContainText("Links to");
  // The target nobody wrote is named, and is not a link.
  await expect(map).toContainText("Cross-reference (missing)");
  await expect(map).toContainText("knowledge/not-written-yet");
  await expect(map.getByRole("link")).toHaveCount(1);
  await map.getByRole("link", { name: "Cross-reference: knowledge/restore-laptop", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Restore a laptop", exact: true })).toBeVisible();
  // From the other end the same link is on the left.
  await openMap();
  await expect(map).toContainText("Linked from");
  await expect(map.getByRole("link", { name: "Cross-reference: knowledge/recovery-index", exact: true })).toBeVisible();
  assert.deepEqual(errors, []);
});
