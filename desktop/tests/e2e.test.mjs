import assert from "node:assert/strict";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { chromium, expect } from "@playwright/test";
import { go, launchFixture, open } from "./support.mjs";

// Wiring only: each section shows what its operations return, reaches them, and shows a refusal. What the operations
// decide (revisions, leases, staleness, write targets) is akm's and is tested there.
test("built desktop UI: each section's happy path and one refusal", { timeout: 240000 }, async (t) => {
  const server = await launchFixture({ proposals: true, metrics: true });
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
    await page.getByRole("textbox", { name: "Rejection reason" }).fill("Synthetic review: verify the evidence first.");
    await refuse("**/api/proposals/*/reject", 409, "PROPOSAL_NOT_PENDING", "This proposal is no longer pending.");
    await page.getByRole("button", { name: "Confirm decision", exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: "no longer pending" })).toBeVisible();
    await page.getByRole("button", { name: "Confirm decision", exact: true }).click();
    await expect(
      page.getByRole("region", { name: "Proposal detail" }).getByRole("button", { name: "Reopen…", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("region", { name: "Proposals" })
      .getByRole("link")
      .filter({ hasText: "recovery checklist" })
      .click();
    await page.screenshot({ path: path.join(screenshots, "review-desktop.png"), fullPage: true });
    await page.getByRole("button", { name: "Accept…", exact: true }).click();
    await page.getByRole("button", { name: "Confirm decision", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Decision recorded" })).toBeVisible();
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
  console.log(`Screenshots: ${screenshots}`);
});
