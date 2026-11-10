// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import AxeBuilder from "@axe-core/playwright";
import { chromium, expect } from "@playwright/test";
import { go, launchFixture, tabStops } from "./support.mjs";

test("reviewed human workflows prevent dead ends and preserve focus and source", { timeout: 180000 }, async (t) => {
  const app = await launchFixture({ proposals: true, metrics: true });
  t.after(() => app.stop());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(app.url);
  const navigate = (href) => go(page, href);
  const workspace = page.getByRole("region", { name: "Asset workspace", exact: true });
  const editor = page.getByRole("textbox", { name: "Markdown source, including optional frontmatter" });
  const original = await readFile(app.documentPath, "utf8");

  await t.test("narrow browsing moves focus into content and back to the same result", async () => {
    await navigate("/library/search?q=backup");
    const result = page.locator(".library-hit-content").filter({ hasText: "restore laptop" });
    await result.focus();
    await page.keyboard.press("Enter");
    const heading = workspace.locator(".asset-heading h1");
    await expect(heading).toBeFocused();
    await expect(workspace.locator(".document-body")).toContainText("Verify the checksum");
    assert.ok(
      await heading.evaluate(
        (el) =>
          el.getBoundingClientRect().top >= document.querySelector(".desktop-topbar").getBoundingClientRect().bottom,
      ),
      "Focused heading is not hidden by sticky navigation",
    );
    await expect(page.getByRole("region", { name: "Search results" })).toBeHidden();
    await workspace.getByRole("link", { name: /Search results/ }).click();
    await expect(result).toBeFocused();
    await expect(page).toHaveURL(/q=backup/);
    await result.click();
    await expect(page.getByRole("searchbox", { name: "Search library" })).toBeHidden();
    await page.keyboard.press("Control+k");
    await expect(page.getByRole("searchbox", { name: "Search library" })).toBeFocused();
    await expect(page.getByRole("searchbox", { name: "Search library" })).toHaveValue("backup");
    await result.click();
  });
  await t.test("same-bundle copy requires a new name before submission; cancel returns focus", async () => {
    const copy = workspace.getByRole("button", { name: "Copy to bundle…", exact: true });
    await workspace.getByRole("button", { name: "More", exact: true }).click();
    await copy.click();
    const name = workspace.getByRole("textbox", { name: /^New name/ });
    await expect(workspace.getByRole("button", { name: "Confirm copy" })).toBeDisabled();
    await name.fill("restore-laptop");
    await expect(workspace.getByRole("button", { name: "Confirm copy" })).toBeDisabled();
    await name.fill("another-recovery-guide");
    await expect(workspace.getByRole("button", { name: "Confirm copy" })).toBeEnabled();
    await workspace.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(workspace.getByRole("button", { name: "More", exact: true })).toBeFocused();
    assert.equal(await readFile(app.documentPath, "utf8"), original);
  });
  await t.test("unsaved drafts are explicit, survive reload and can be discarded without saving", async () => {
    await workspace.getByRole("link", { name: "Edit page", exact: true }).click();
    const draft = `${original}\nUnsaved review fixture.\n`;
    await editor.fill(draft);
    await expect(workspace.getByRole("status")).toContainText("Unsaved changes");
    // Session-only draft survives a renderer reload; no live source writes.
    await page.reload();
    await expect(editor).toHaveValue(draft);
    await expect(workspace.getByRole("status")).toContainText("Restored unsaved draft");
    await workspace.getByRole("button", { name: "Discard draft…", exact: true }).click();
    await workspace.getByRole("button", { name: "Keep editing", exact: true }).click();
    await expect(page.getByRole("tab", { name: "Markdown", exact: true })).toBeFocused();
    await expect(editor).toHaveValue(draft);
    await workspace.getByRole("button", { name: "Discard draft…", exact: true }).click();
    await workspace.getByRole("button", { name: "Discard draft", exact: true }).click();
    await expect(editor).toHaveValue(original);
    await expect(workspace.getByRole("heading", { name: "Restore a laptop" })).toBeFocused();
    await expect(workspace.getByRole("button", { name: "Save changes", exact: true })).toBeDisabled();
    assert.equal(await readFile(app.documentPath, "utf8"), original);
    await workspace.getByRole("link", { name: "Back to file", exact: true }).click();
    await expect(workspace.locator(".document-body")).toContainText("Verify the checksum");
    await expect(page).toHaveURL(/\/library\/files\?/);
    await page.getByRole("link", { name: "Back to reading", exact: true }).click();
    await workspace.getByRole("link", { name: /Search results/ }).click();
    await expect(page.locator(".library-hit-content").filter({ hasText: "restore laptop" })).toBeFocused();
  });
  await t.test("duplicate creation keeps the draft and provides a usable recovery action", async () => {
    await navigate("/library/new");
    await page.getByRole("textbox", { name: "File name", exact: true }).fill("restore-laptop");
    await editor.fill("# Synthetic duplicate\n\nKeep this draft.\n");
    await page.getByRole("button", { name: "Create knowledge", exact: true }).click();
    const alert = workspace.getByRole("alert");
    await expect(alert).toContainText("Choose a different file name");
    await expect(alert).toBeFocused();
    await expect(alert).not.toContainText("--force");
    await expect(editor).toHaveValue(/Keep this draft/);
    assert.equal(await readFile(app.documentPath, "utf8"), original);
    await workspace.getByRole("button", { name: "Discard draft…", exact: true }).click();
    await workspace.getByRole("button", { name: "Discard draft", exact: true }).click();
  });
  await t.test(
    "narrow review focuses selected detail and returns to queue; new files have no broken link",
    async () => {
      await navigate("/review");
      const item = page.locator(".review-item").filter({ hasText: "recovery checklist" });
      await item.focus();
      await page.keyboard.press("Enter");
      const detail = page.getByRole("region", { name: "Proposal detail", exact: true });
      await expect(detail.locator(".proposal-title h2")).toBeFocused();
      await expect(detail).toContainText("New asset");
      await expect(detail.getByRole("link", { name: "Open in Files", exact: true })).toHaveCount(0);
      await detail.getByRole("link", { name: "Back to queue", exact: true }).click();
      await expect(item).toBeFocused();
    },
  );
  await t.test("read-only bundles are not selectable write targets", async () => {
    await navigate("/settings/config");
    const target = page.getByRole("combobox", { name: "Default write target", exact: true });
    await expect(target.locator('option[value="vendor"]')).toBeDisabled();
    await expect(target.locator('option[value="shared"]')).toBeEnabled();
  });
  await t.test("phone layout: the filter panel stays inside the viewport", async () => {
    await navigate("/library/search?q=backup");
    await page.locator("summary", { hasText: "Filters" }).click();
    const panel = await page.evaluate(() => {
      const width = document.documentElement.clientWidth;
      const outside = [...document.querySelectorAll(".filter-panel :is(select, input, button)")]
        .map((e) => ({
          control: e.closest("label")?.firstChild?.textContent?.trim() || e.textContent.trim(),
          left: Math.round(e.getBoundingClientRect().left),
          right: Math.round(e.getBoundingClientRect().right),
        }))
        .filter((e) => e.right > width || e.left < 0);
      const region = document.querySelector(".search-page");
      return { outside, sideways: region.scrollWidth - region.clientWidth };
    });
    assert.deepEqual(panel.outside, [], "every filter control is inside the viewport");
    assert.ok(panel.sideways <= 0, `the search page must not scroll sideways (${panel.sideways}px)`);
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
  });
  await t.test("phone chrome: a one-row bar, tabs that wrap, and 44px targets", async () => {
    const small = [];
    for (const [href, ready] of [
      ["/library/search?q=backup", ".library-views"],
      ["/library/files?bundle=personal&path=knowledge", ".file-breadcrumbs"],
      ["/review", ".tabs"],
      ["/settings/config", ".settings-tabs"],
      ["/activity/overview", ".activity-tabs"],
    ]) {
      await navigate(href);
      await expect(page.locator(ready).first()).toBeVisible();
      const facts = await page.evaluate(() => {
        const width = document.documentElement.clientWidth;
        const tabs = document.querySelector(".activity-tabs");
        const selector =
          ".desktop-topbar nav a, .library-views a, .file-breadcrumbs button, .tabs button, .settings-tabs a, .activity-tabs a";
        return {
          barHeight: Math.round(document.querySelector(".desktop-topbar").getBoundingClientRect().height),
          tabsSideways: tabs ? tabs.scrollWidth - tabs.clientWidth : 0,
          width,
          targets: [...document.querySelectorAll(selector)]
            .filter((e) => e.getClientRects().length)
            .map((e) => ({
              label: e.textContent.trim(),
              height: Math.round(e.getBoundingClientRect().height),
              right: Math.round(e.getBoundingClientRect().right),
            })),
        };
      });
      assert.ok(facts.barHeight <= 64, `${href}: the bar must be one row on a phone (${facts.barHeight}px)`);
      assert.ok(facts.tabsSideways <= 0, `${href}: tabs must wrap, not scroll sideways (${facts.tabsSideways}px)`);
      small.push(
        ...facts.targets
          .filter((target) => target.height < 44 || target.right > facts.width)
          .map((target) => `${href}: ${target.label} ${target.height}px, right ${target.right}`),
      );
    }
    assert.deepEqual(small, [], "tabs and bar links meet the 44px floor and stay inside the viewport");
  });
  await t.test("phone keyboard: Files reads in focus order, the folder drawer hands focus back", async () => {
    await navigate("/library/files?bundle=personal&path=knowledge");
    await expect(page.locator(".file-breadcrumbs")).toBeVisible();
    const bar = await tabStops(page, ".files-location");
    assert.ok(bar.length >= 4, `the location bar has its controls in the tab order (${bar.length})`);
    assert.deepEqual(
      bar.filter((stop) => stop.moved).map((stop) => `${stop.name}: ${stop.moved}`),
      [],
      "Files on a phone: focus order is reading order across the location bar",
    );
    const folders = page.getByRole("button", { name: "Folders", exact: true });
    const drawer = page.locator(".files-workspace");
    await folders.focus();
    await page.keyboard.press("Enter");
    await expect(drawer).toHaveClass(/tree-open/);
    await expect(page.locator('[role="treeitem"]:focus')).toBeVisible();
    await page.getByRole("button", { name: "Close", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(drawer).not.toHaveClass(/tree-open/);
    await expect(folders, "Close hands focus back to Folders").toBeFocused();
    await folders.focus();
    await page.keyboard.press("Enter");
    await expect(page.locator('[role="treeitem"]:focus')).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(drawer, "Escape closes the folder drawer").not.toHaveClass(/tree-open/);
    await expect(folders, "Escape hands focus back to Folders").toBeFocused();
  });
  await t.test("phone overlays pass axe while open", async () => {
    const violations = [];
    const audit = async (state) => {
      const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
      violations.push(...results.violations.map(({ id, nodes }) => `${state}: ${id} ${nodes[0].target}`));
    };
    await navigate("/library/search?q=backup");
    await page.locator("summary", { hasText: "Filters" }).click();
    await expect(page.locator(".filter-panel")).toBeVisible();
    await audit("filter panel open");
    await page.keyboard.press("Escape");
    await navigate(`/library/search?ref=${encodeURIComponent(app.refs.document)}`);
    await page.getByRole("button", { name: "More", exact: true }).click();
    await expect(page.locator("#asset-actions")).toBeVisible();
    await audit("asset menu open");
    await page.keyboard.press("Escape");
    await navigate("/library/files?bundle=personal&path=knowledge");
    await page.getByRole("button", { name: "Folders", exact: true }).click();
    await expect(page.locator('[role="tree"]')).toBeVisible();
    await audit("folder drawer open");
    assert.deepEqual(violations, [], "axe at 390 with an overlay open");
  });
  await t.test("usage charts are directly visible", async () => {
    await page.setViewportSize({ width: 1280, height: 860 });
    await navigate("/activity/overview?view=retrieval");
    await expect(page.locator("#activity-retrieval-rate svg")).toBeVisible();
  });
  assert.deepEqual(errors, []);
});
