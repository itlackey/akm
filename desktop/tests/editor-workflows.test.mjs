import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { launchFixture } from "./support.mjs";

test("document editing: formatting, preview, Files save, and revision conflict use isolated real core", {
  timeout: 150000,
}, async (t) => {
  const server = await launchFixture();
  t.after(() => server.stop());
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.evaluate((ref) => {
    location.hash = `#/asset?ref=${encodeURIComponent(ref)}`;
  }, server.refs.document);
  await expect(page.locator(".document-body")).toContainText("Verify the checksum");
  await expect(page.locator(".asset-views")).toHaveCount(0);
  await page.getByRole("link", { name: "Edit page", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "Markdown source, including optional frontmatter", exact: true });
  const original = await readFile(server.documentPath, "utf8");
  await expect(editor).toHaveValue(original.replace(/\r\n?/g, "\n"));
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    const save = page.getByRole("button", { name: "Save changes", exact: true });
    const geometry = await save.evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      return { lines: range.getClientRects().length, height: element.getBoundingClientRect().height };
    });
    assert.equal(geometry.lines, 1, `Save label should remain on one line at ${width}px`);
    assert.ok(geometry.height >= 44, `Save remains a touch target at ${width}px`);
    if (width === 390)
      assert.equal(
        geometry.height,
        (await page.getByRole("tab", { name: "Markdown", exact: true }).boundingBox()).height,
      );
    if (process.env.AKM_DESKTOP_SCREENSHOTS) {
      await mkdir(process.env.AKM_DESKTOP_SCREENSHOTS, { recursive: true });
      await page.screenshot({
        path: path.join(process.env.AKM_DESKTOP_SCREENSHOTS, `editor-refined-${width}.png`),
        animations: "disabled",
      });
    }
  }
  await page.setViewportSize({ width: 1280, height: 860 });

  const select = async (text) => {
    await editor.focus();
    await editor.evaluate((element, value) => {
      const start = element.value.indexOf(value);
      if (start < 0) throw new Error(`Missing synthetic selection: ${value}`);
      element.setSelectionRange(start, start + value.length);
    }, text);
  };
  await select("checksum");
  await page.getByRole("button", { name: "Bold", exact: true }).click();
  await expect(editor).toHaveValue(original.replace("checksum", "**checksum**").replace(/\r\n?/g, "\n"));
  await editor.press("Control+z");
  await expect(editor).toHaveValue(original.replace(/\r\n?/g, "\n"));
  await editor.press("Control+Shift+z");
  await expect(editor).toHaveValue(original.replace("checksum", "**checksum**").replace(/\r\n?/g, "\n"));
  await select("Verify");
  await editor.press("Control+i");
  await select("restoring");
  await editor.press("Control+k");
  await expect(editor).toHaveValue(/\[restoring\]\(https:\/\/\)/);
  await expect(page).toHaveURL(/#\/edit\?/);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await editor.press("Control+z");
  await expect(editor).not.toHaveValue(/\[restoring\]\(https:\/\/\)/);
  await page.getByRole("tab", { name: "Preview", exact: true }).click();
  await expect(page.locator("#editor-preview strong")).toContainText("checksum");
  await expect(page.locator("#editor-preview em")).toContainText("Verify");
  await page.getByRole("tab", { name: "Preview", exact: true }).press("ArrowLeft");
  await expect(page.getByRole("tab", { name: "Markdown", exact: true })).toBeFocused();
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page).toHaveURL(/#\/files\?/);
  await expect(page.locator(".document-body")).toContainText("Verify the checksum");
  const saved = await readFile(server.documentPath, "utf8");
  assert.ok(saved.includes("*Verify* the **checksum**"));

  // Technical views remain reachable without imposing their tabs on every reader.
  await page.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("button", { name: "Source", exact: true }).click();
  await expect(page.locator(".raw-source")).toContainText("*Verify* the **checksum**");
  await page.getByRole("button", { name: "Read", exact: true }).click();
  await page.getByRole("link", { name: "Edit page", exact: true }).click();
  const draft = `${await editor.inputValue()}\nRetained author draft.\n`;
  await editor.fill(draft);
  await writeFile(server.documentPath, `${saved}\nConcurrent synthetic edit.\n`);
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByRole("heading", { name: "A newer version exists" })).toBeVisible();
  await expect(editor).toHaveValue(draft);
  await expect(page.locator(".conflict .dcol.inline")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Save changes", exact: true })).toBeDisabled();
  await editor.fill(`${draft}\nConcurrent synthetic edit.\n`);
  await page.getByRole("button", { name: "Save reviewed version", exact: true }).click();
  await expect(page).toHaveURL(/#\/files\?/);
  await expect(page.locator(".document-body")).toContainText("Retained author draft.");
  assert.ok((await readFile(server.documentPath, "utf8")).includes("Concurrent synthetic edit."));
  assert.deepEqual(errors, []);
});
