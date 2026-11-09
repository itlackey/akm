// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { chromium, expect } from "@playwright/test";
import { go, launchFixture } from "./support.mjs";

test("reviewed human workflows prevent dead ends and preserve focus and source", { timeout: 180000 }, async (t) => {
  const app = await launchFixture({ proposals: true, metrics: true });
  t.after(() => app.stop());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
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
    const heading = workspace.locator(".asset-heading h2");
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
  await t.test("read-only bundles are not selectable as the default bundle", async () => {
    await navigate("/settings/config");
    const target = page.getByRole("combobox", { name: "Default bundle", exact: true });
    await expect(target.locator('option[value="vendor"]')).toBeDisabled();
    await expect(target.locator('option[value="shared"]')).toBeEnabled();
  });
  await t.test("usage charts are directly visible", async () => {
    await page.setViewportSize({ width: 1280, height: 860 });
    await navigate("/activity/overview?view=retrieval");
    await expect(page.locator("#activity-retrieval-rate svg")).toBeVisible();
  });
  assert.deepEqual(errors, []);
});
