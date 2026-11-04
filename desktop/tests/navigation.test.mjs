import assert from "node:assert/strict";
import test from "node:test";
import { chromium, expect } from "@playwright/test";
import { launchFixture, open } from "./support.mjs";

test("pages are addressable; history, unsaved drafts and appearance survive navigation", {
  timeout: 90000,
}, async (t) => {
  const server = await launchFixture({ proposals: true });
  t.after(() => server.stop());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const nav = (name) =>
    page
      .getByRole("navigation", { name: "Primary navigation" })
      .getByRole("link", { name: new RegExp(`^${name}(?:\\s|$)`) });
  const editor = page.getByRole("textbox", { name: "Markdown source, including optional frontmatter" });
  const leave = page.getByRole("dialog", { name: "Leave this draft?" });

  await t.test("a deep link opens its page on a fresh load, and Back/Forward keep their pages", async () => {
    await open(page, server, "/review?source=propose");
    await expect(page.getByRole("heading", { name: "Review", exact: true })).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Source", exact: true })).toHaveValue("propose");
    const filesUrl = `/library/files?${new URLSearchParams({ bundle: "personal", path: "knowledge", file: "knowledge/restore-laptop.md", ref: server.refs.document, open: "1" })}`;
    await page.goto(server.origin + filesUrl);
    await expect(page.locator(".document-body")).toContainText("Verify the checksum");
    await nav("Review").click();
    await expect(page.getByRole("heading", { name: "Review", exact: true })).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(server.origin + filesUrl);
    await expect(page.locator(".document-body")).toContainText("Verify the checksum");
    await page.goForward();
    await expect(page.getByRole("heading", { name: "Review", exact: true })).toBeVisible();
    // The navigation returns to where each section was left.
    await nav("Library").click();
    await expect(page).toHaveURL(server.origin + filesUrl);
  });

  await t.test("a draft asks before it is left, is kept when left, and survives a reload", async () => {
    await page.goto(`${server.origin}/library/edit?${new URLSearchParams({ ref: server.refs.document })}`);
    const draft = `${await editor.inputValue()}\nAn unsaved line.\n`;
    await editor.fill(draft);
    await nav("Settings").click();
    await expect(leave).toBeVisible();
    await leave.getByRole("button", { name: "Stay in editor", exact: true }).click();
    await expect(leave).not.toBeVisible();
    await expect(page).toHaveURL(/\/library\/edit/);
    await nav("Settings").click();
    await leave.getByRole("button", { name: "Leave and keep draft", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
    await nav("Library").click();
    assert.equal(await editor.inputValue(), draft);
    await page.reload();
    await expect(page.locator("main")).toContainText("Restored unsaved draft");
    assert.equal(await editor.inputValue(), draft);
  });

  await t.test("the chosen appearance is saved and applied again after a reload", async () => {
    await open(page, server, "/");
    await page.getByRole("combobox", { name: "Appearance" }).selectOption("dark");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect.poll(async () => (await server.call("/api/desktop/preferences")).body.data.theme).toBe("dark");
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    assert.deepEqual(errors, []);
  });
});
