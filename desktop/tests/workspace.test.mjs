import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { chromium, expect } from "@playwright/test";
import { launchFixture } from "./support.mjs";

test("representative workspace: large library, local Git, navigation, drafts and appearance", {
  timeout: 180000,
}, async (t) => {
  const server = await launchFixture({ assetCount: 150, git: true });
  t.after(() => server.stop());
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.stack ?? error.message));
  const requests = [];
  page.on("request", (request) => requests.push(new URL(request.url()).pathname));
  const nav = (name) =>
    page
      .getByRole("navigation", { name: "Primary navigation" })
      .getByRole("link", { name: new RegExp(`^${name}(?:\\s|$)`) });
  await page.goto(`${server.url}#/search`);
  await expect(page.getByRole("heading", { name: "Library", exact: true })).toBeVisible();
  assert.equal(requests.includes("/api/overview"), false);
  assert.equal(requests.includes("/api/config"), false);
  await page.evaluate(() => {
    location.hash = "#/search?tab=browse&bundle=personal&limit=200";
  });
  await expect(page.locator(".library-hit-content")).toHaveCount(158);
  await page
    .getByRole("region", { name: "Search results" })
    .getByRole("link")
    .filter({ hasText: "restore laptop" })
    .click();
  const inspector = page.getByRole("region", { name: "Asset workspace", exact: true });
  await expect(inspector.locator(".document-body")).toContainText("A committed verification step.");
  await inspector.getByRole("button", { name: "More", exact: true }).click();
  await inspector.getByRole("button", { name: "History", exact: true }).click();
  await expect(inspector).toContainText("Add verified recovery step");
  await inspector
    .getByRole("button", { name: /^[a-f0-9]{8}$/ })
    .first()
    .click();
  await expect(inspector.locator(".change-preview")).toBeVisible();
  await expect(inspector.locator(".dcol.inline")).toHaveCount(1);
  await inspector.getByRole("button", { name: "Side by side", exact: true }).click();
  await expect(inspector.locator(".sbs")).toHaveCount(1);
  await inspector.getByRole("button", { name: "Read", exact: true }).click();
  await inspector.getByRole("button", { name: "More", exact: true }).click();
  await inspector.getByRole("button", { name: "History", exact: true }).click();
  await inspector
    .getByRole("button", { name: /^[a-f0-9]{8}$/ })
    .first()
    .click();
  await expect(inspector.locator(".dcol.inline")).toHaveCount(1);
  await inspector.getByRole("link", { name: "Edit page", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "Markdown source, including optional frontmatter" });
  const draft = `${await editor.inputValue()}\nUnsaved retained test draft.\n`;
  await editor.fill(draft);
  await nav("Review").click();
  await page.getByRole("dialog").getByRole("button", { name: "Leave and keep draft", exact: true }).click();
  await nav("Library").click();
  await expect(editor).toHaveValue(draft);
  await page.getByRole("treeitem", { name: "reference-000.md", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Leave and keep draft", exact: true }).click();
  await expect(inspector.locator(".document-body")).toContainText("reference 0.");
  await page.goBack();
  await expect(editor).toHaveValue(draft);
  assert.doesNotMatch(await readFile(server.documentPath, "utf8"), /Unsaved retained test draft/);
  // A new browser context has no localStorage; appearance is a Desktop-only
  // saved preference, not an ephemeral loopback-origin storage coincidence.
  const saved = page.waitForResponse(
    (r) => r.url().endsWith("/api/desktop/preferences") && r.request().method() === "POST",
  );
  await page.getByRole("combobox", { name: "Appearance" }).selectOption("dark");
  await saved;
  const other = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  await other.goto(`${server.url}#/search`);
  await expect(other.locator("html")).toHaveAttribute("data-theme", "dark");
  await other.getByRole("searchbox", { name: "Search library" }).fill("restore-laptop");
  await other.getByRole("button", { name: "Search", exact: true }).click();
  await other
    .getByRole("region", { name: "Search results" })
    .getByRole("link")
    .filter({ hasText: "restore laptop" })
    .click();
  await expect(other.locator(".document-body")).toContainText("Verify the checksum");
  await other.evaluate(() => scrollTo(0, 0));
  const screenshots = process.env.AKM_DESKTOP_SCREENSHOTS ?? path.join(server.root, "screenshots");
  await mkdir(screenshots, { recursive: true });
  await other.screenshot({ path: path.join(screenshots, "workspace-large-dark.png"), animations: "disabled" });
  await other.getByRole("combobox", { name: "Appearance" }).selectOption("light");
  await expect(other.locator("html")).toHaveAttribute("data-theme", "light");
  await other.evaluate(() => scrollTo(0, 0));
  await other.screenshot({ path: path.join(screenshots, "workspace-large-light.png"), animations: "disabled" });
  console.log(`Workspace screenshots: ${screenshots}`);
  assert.deepEqual(errors, []);
});
