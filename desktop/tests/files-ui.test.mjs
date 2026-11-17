// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { chromium, expect } from "@playwright/test";
import { go, launchFixture } from "./support.mjs";

const opened = (ref, folder, file) =>
  `/library/files?${new URLSearchParams({ bundle: "personal", path: folder, file, ref, open: "1" })}`;
const exists = (file) =>
  fs.access(file).then(
    () => true,
    () => false,
  );

async function session(t, options = {}, viewport = { width: 1280, height: 860 }) {
  const app = await launchFixture(options);
  t.after(() => app.stop());
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(app.url);
  return { app, page, errors };
}

test("Move to… on the open file asks for a folder in the tree, and the page follows the file with its history", async (t) => {
  const { app, page } = await session(t, {
    metrics: true,
    configureFixture: async (fixture) => fs.mkdir(path.join(fixture.root, "personal/knowledge/archive")),
  });
  await go(page, opened(app.refs.document, "knowledge", "knowledge/restore-laptop.md"));
  const tree = page.getByRole("tree", { name: "Bundle files" });
  const item = tree.getByRole("treeitem", { name: "restore-laptop.md" });
  await item.focus();
  await page.keyboard.press("ContextMenu");
  const menu = page.getByRole("menu", { name: "Actions for restore-laptop.md" });
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitem", { name: /^Move to…/ }).click();
  const dialog = page.getByRole("dialog", { name: "Move restore-laptop.md" });
  await dialog.getByRole("treeitem", { name: "archive" }).click();
  await dialog.getByRole("button", { name: "Move here" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Moved restore-laptop.md to knowledge/archive." }),
  ).toBeAttached();
  await expect(page).toHaveURL(/path=knowledge%2Farchive/);
  await expect(page.locator(".document-body")).toContainText("Verify the checksum");
  assert.equal(await exists(path.join(app.root, "personal/knowledge/archive/restore-laptop.md")), true);
  assert.equal(await exists(app.documentPath), false);
  const moved = (await app.call(`/api/asset?ref=${encodeURIComponent("personal//knowledge/archive/restore-laptop")}`))
    .body.data;
  assert.ok(moved.feedback.counts.positive >= 1, "the asset kept its feedback at the new place");
});

const folderOf = async (app, folder, bundle = "personal") =>
  (await app.call(`/api/bundles/files?${new URLSearchParams({ bundle, path: folder, hidden: "1" })}`)).body.data;
const reasonOf = async (app, bundle, folder, name, action) =>
  (await folderOf(app, folder, bundle)).entries.find((entry) => entry.name === name).actions[action].reason;

async function claudeBundle(fixture) {
  const file = path.join(fixture.root, "config/config.json");
  const config = JSON.parse(await fs.readFile(file, "utf8"));
  config.bundles.claude = {
    path: path.join(fixture.root, "claude"),
    writable: true,
    components: { main: { root: ".", adapter: "claude" } },
  };
  await fs.writeFile(file, JSON.stringify(config));
  await fs.mkdir(path.join(fixture.root, "claude/commands"), { recursive: true });
  await fs.writeFile(
    path.join(fixture.root, "claude/commands/review.md"),
    "---\ndescription: Review a change\n---\n# Review\n\nLook at the diff.\n",
  );
}

test("the menu offers what akm allows and says why not: a read-only bundle, another adapter's bundle, a protected file, a skill", async (t) => {
  const { app, page } = await session(t, {
    configureFixture: async (fixture) => {
      await claudeBundle(fixture);
      await fs.mkdir(path.join(fixture.root, "personal/env"));
      await fs.writeFile(path.join(fixture.root, "personal/env/prod.env"), "TOKEN=synthetic\n");
    },
  });
  const menuFor = async (bundle, folder, name) => {
    await go(page, `/library/files?${new URLSearchParams({ bundle, path: folder })}`);
    await page.getByRole("button", { name: `Actions for ${name}`, exact: true }).click();
    return page.getByRole("menu", { name: `Actions for ${name}` });
  };
  const item = (menu, label) => menu.getByRole("menuitem", { name: new RegExp(`^${label}`) });
  for (const [bundle, folder, name, enabled, refused] of [
    ["vendor", "knowledge", "vendor-backup.md", ["Copy to…"], ["Rename", "Move to…", "Retire", "Delete"]],
    ["claude", "commands", "review.md", ["Rename", "Move to…", "Copy to…", "Delete"], ["Retire"]],
    ["personal", "env", "prod.env", [], ["Rename", "Move to…", "Copy to…", "Retire", "Delete"]],
    ["personal", "skills/backup-check", "SKILL.md", ["Copy to…"], ["Rename", "Move to…"]],
  ]) {
    const menu = await menuFor(bundle, folder, name);
    for (const label of enabled)
      await expect(item(menu, label), `${name}: ${label}`).not.toHaveAttribute("aria-disabled", "true");
    for (const label of refused) {
      const control = item(menu, label);
      await expect(control, `${name}: ${label}`).toHaveAttribute("aria-disabled", "true");
      const action = { Rename: "move", "Move to…": "move", "Copy to…": "copy", Retire: "retire", Delete: "delete" }[
        label
      ];
      // The sentence on the control is the one akm reports for it.
      await expect(control).toContainText(await reasonOf(app, bundle, folder, name, action));
    }
    await page.keyboard.press("Escape");
  }
  // A refused control stays focusable and does nothing.
  const menu = await menuFor("vendor", "knowledge", "vendor-backup.md");
  await item(menu, "Delete").focus();
  await expect(item(menu, "Delete")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  assert.equal(await exists(app.vendorPath), true);
});

test("a rename in the tree is a rename on disk, announced, and the open page follows it", async (t) => {
  const { app, page } = await session(t);
  await go(page, opened(app.refs.document, "knowledge", "knowledge/restore-laptop.md"));
  const tree = page.getByRole("tree", { name: "Bundle files" });
  await tree.getByRole("treeitem", { name: "restore-laptop.md" }).focus();
  await page.keyboard.press("F2");
  const input = tree.getByRole("textbox", { name: "New name for restore-laptop.md" });
  await expect(input).toBeFocused();
  await input.fill("restore-desktop.md");
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("status").filter({ hasText: "Renamed restore-laptop.md to restore-desktop.md." }),
  ).toBeAttached();
  await expect(page.locator(".document-body")).toContainText("Verify the checksum");
  await expect(page).toHaveURL(/restore-desktop/);
  assert.equal(await exists(path.join(app.root, "personal/knowledge/restore-desktop.md")), true);
  assert.equal(await exists(app.documentPath), false);
  await expect(tree.getByRole("treeitem", { name: "restore-desktop.md" })).toBeVisible();
  // Escape leaves the name as it was.
  await tree.getByRole("treeitem", { name: "restore-desktop.md" }).focus();
  await page.keyboard.press("F2");
  await page.getByRole("textbox", { name: "New name for restore-desktop.md" }).fill("nothing.md");
  await page.keyboard.press("Escape");
  await expect(tree.getByRole("treeitem", { name: "restore-desktop.md" })).toBeVisible();
  assert.equal(await exists(path.join(app.root, "personal/knowledge/nothing.md")), false);
});

test("dropping a file on a folder names both and asks once; protected files cannot be dragged", async (t) => {
  const { app, page } = await session(t, {
    configureFixture: async (fixture) => {
      await fs.mkdir(path.join(fixture.root, "personal/knowledge/archive"));
      await fs.mkdir(path.join(fixture.root, "personal/env"));
      await fs.writeFile(path.join(fixture.root, "personal/env/prod.env"), "TOKEN=synthetic\n");
    },
  });
  await go(page, "/library/files?bundle=personal&path=knowledge");
  const row = page.getByRole("row", { name: /restore-laptop\.md/ });
  const folder = page.getByRole("row", { name: /^archive/ });
  await row.dragTo(folder);
  const dialog = page.getByRole("dialog", { name: "Move restore-laptop.md into archive?" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  assert.equal(await exists(app.documentPath), true, "cancelling moves nothing");
  await row.dragTo(folder);
  await page.getByRole("dialog").getByRole("button", { name: "Move here" }).click();
  await expect(page.getByRole("row", { name: /restore-laptop\.md/ })).toHaveCount(0);
  assert.equal(await exists(path.join(app.root, "personal/knowledge/archive/restore-laptop.md")), true);
  await go(page, "/library/files?bundle=personal&path=env");
  await expect(page.getByRole("row", { name: /prod\.env/ })).not.toHaveAttribute("draggable", "true");
});

test("the list shows size and modified time from akm", async (t) => {
  const { app, page } = await session(t);
  await go(page, "/library/files?bundle=personal&path=knowledge");
  const listed = (await folderOf(app, "knowledge")).entries.find((entry) => entry.name === "restore-laptop.md");
  const row = page.getByRole("row", { name: /restore-laptop\.md/ });
  await expect(row.getByRole("cell").nth(2)).toHaveText(/\d+ B/);
  await expect(row.getByRole("cell").nth(3)).toHaveText(new Date(listed.modified).toLocaleString());
});

const linker = (name, ref) =>
  `---\ndescription: Links to ${name}\nupdated: 2026-11-01\n---\n\nSee ${ref} for details.\n`;

test("after a move the page counts the links that still name the old place; one button rewrites them and says what changed", async (t) => {
  const { app, page } = await session(t, {
    configureFixture: async (fixture) => {
      await fs.mkdir(path.join(fixture.root, "personal/knowledge/archive"));
      await fs.writeFile(
        path.join(fixture.root, "personal/knowledge/linker.md"),
        linker("the laptop guide", "personal//knowledge/restore-laptop"),
      );
      await fs.writeFile(
        path.join(fixture.root, "vendor/knowledge/vendor-linker.md"),
        linker("the laptop guide", "personal//knowledge/restore-laptop"),
      );
    },
  });
  await go(page, opened(app.refs.document, "knowledge", "knowledge/restore-laptop.md"));
  await expect(page.getByRole("button", { name: /^Update \d+ links?$/ })).toHaveCount(0);
  await page.getByRole("tree", { name: "Bundle files" }).getByRole("treeitem", { name: "restore-laptop.md" }).focus();
  await page.keyboard.press("ContextMenu");
  await page.getByRole("menuitem", { name: /^Move to…/ }).click();
  await page.getByRole("dialog").getByRole("treeitem", { name: "archive" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Move here" }).click();
  const notice = page.getByRole("region", { name: "Links to the old place" });
  await expect(notice).toContainText("2 links still point at the old place.");
  // The read-only bundle is counted and says why it is not updated: akm's sentence.
  const blocker = (await app.call("/api/bundles")).body.data.bundles.find(
    (entry) => entry.name === "vendor",
  ).writeBlocker;
  await expect(notice).toContainText(`1 in vendor, not updated: ${blocker}`);
  const before = await fs.readFile(path.join(app.root, "personal/knowledge/linker.md"), "utf8");
  assert.match(before, /personal\/\/knowledge\/restore-laptop /, "nothing is rewritten before the click");
  await notice.getByRole("button", { name: "Update 1 link" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Updated 1 link in 1 file" })).toContainText("linker.md");
  assert.match(
    await fs.readFile(path.join(app.root, "personal/knowledge/linker.md"), "utf8"),
    /personal\/\/knowledge\/archive\/restore-laptop for details/,
  );
  assert.equal(
    await fs.readFile(path.join(app.root, "vendor/knowledge/vendor-linker.md"), "utf8"),
    linker("the laptop guide", "personal//knowledge/restore-laptop"),
    "a read-only bundle is not written",
  );
});

test("the page has no move form: More offers no rename or move, and Edit and Retire come from akm's verdicts", async (t) => {
  const { app, page } = await session(t);
  await go(page, opened(app.refs.document, "knowledge", "knowledge/restore-laptop.md"));
  await page.getByRole("button", { name: "More", exact: true }).click();
  const menu = page.locator("#asset-actions");
  await expect(menu.getByRole("button", { name: /Rename or move/ })).toHaveCount(0);
  await expect(menu.getByRole("button", { name: "Retire" })).not.toHaveAttribute("aria-disabled", "true");
  await page.keyboard.press("Escape");
  await go(
    page,
    opened(app.refs.vendor, "knowledge", "knowledge/vendor-backup.md").replace("bundle=personal", "bundle=vendor"),
  );
  const edit = page.getByRole("button", { name: "Edit page", exact: true });
  await expect(edit).toHaveAttribute("aria-disabled", "true");
  const reason = (await folderOf(app, "knowledge", "vendor")).entries.find((entry) => entry.name === "vendor-backup.md")
    .actions.edit.reason;
  await expect(page.locator(".asset-context")).toContainText(reason);
  await page.getByRole("button", { name: "More", exact: true }).click();
  const retire = page.locator("#asset-actions").getByRole("button", { name: "Retire" });
  await expect(retire).toHaveAttribute("aria-disabled", "true");
  await expect(page.locator("#asset-actions")).toContainText(
    (await folderOf(app, "knowledge", "vendor")).entries.find((entry) => entry.name === "vendor-backup.md").actions
      .retire.reason,
  );
});
