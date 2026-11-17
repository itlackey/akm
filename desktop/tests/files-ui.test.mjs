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
  // A compact time on one line, with the full timestamp in the cell's title.
  const modified = row.getByRole("cell").nth(3);
  await expect(modified).toHaveAttribute("title", new Date(listed.modified).toLocaleString());
  const lines = await modified.evaluate((cell) => {
    const range = document.createRange();
    range.selectNodeContents(cell);
    return new Set([...range.getClientRects()].map((box) => Math.round(box.top))).size;
  });
  assert.equal(lines, 1, "the time fits one line");
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

test("New names what akm says the folder holds and makes it in this folder of this bundle, started with akm's text", async (t) => {
  const { app, page } = await session(t, {
    configureFixture: async (fixture) => {
      for (const folder of ["personal/lessons", "personal/workflows", "personal/reports", "shared/knowledge/team"])
        await fs.mkdir(path.join(fixture.root, folder), { recursive: true });
    },
  });
  const typeOf = async (folder, bundle = "personal") => (await folderOf(app, folder, bundle)).newFile.type;
  assert.equal(await typeOf("lessons"), "lesson");
  assert.equal(await typeOf("reports"), null);
  for (const [bundle, folder, type] of [
    ["personal", "lessons", "lesson"],
    ["personal", "workflows", "workflow"],
    ["personal", "reports", null],
  ]) {
    await go(page, `/library/files?${new URLSearchParams({ bundle, path: folder })}`);
    const label = type ? `New ${type}` : "New file";
    await expect(page.getByRole("button", { name: label, exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "New knowledge" })).toHaveCount(0);
  }
  // In another bundle's folder it makes the file there, not in the default bundle's knowledge/ root.
  await go(page, "/library/files?bundle=shared&path=knowledge/team");
  await page.getByRole("button", { name: "New knowledge", exact: true }).click();
  await page.getByRole("textbox", { name: "Name of the new knowledge" }).fill("onboarding");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByRole("heading", { name: /onboarding/i })).toBeVisible();
  assert.equal(await exists(path.join(app.root, "shared/knowledge/team/onboarding.md")), true);
  assert.equal(await exists(path.join(app.root, "personal/knowledge/onboarding.md")), false);
  // A lesson starts with the keys akm requires for one, and is indexed at once.
  await go(page, "/library/files?bundle=personal&path=lessons");
  await page.getByRole("button", { name: "New lesson", exact: true }).click();
  await page.getByRole("textbox", { name: "Name of the new lesson" }).fill("restore-order");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByRole("button", { name: "Save changes" })).toBeVisible();
  const text = await fs.readFile(path.join(app.root, "personal/lessons/restore-order.md"), "utf8");
  assert.match(text, /^---\n/);
  const found = (await app.call("/api/bundles/files?bundle=personal&path=lessons")).body.data.entries.find(
    (entry) => entry.name === "restore-order.md",
  );
  assert.deepEqual(found.assets, [{ ref: "personal//lessons/restore-order", type: "lesson" }]);
  // A name that is taken is refused by akm and the file is untouched.
  await go(page, "/library/files?bundle=personal&path=lessons");
  await page.getByRole("button", { name: "New lesson", exact: true }).click();
  await page.getByRole("textbox", { name: "Name of the new lesson" }).fill("restore-order");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  assert.equal(await fs.readFile(path.join(app.root, "personal/lessons/restore-order.md"), "utf8"), text);
});

test("where akm refuses a new file the button is disabled with its sentence; a folder can still be made where only a file is refused", async (t) => {
  const { app, page } = await session(t, {
    configureFixture: async (fixture) => {
      await claudeBundle(fixture);
      await fs.mkdir(path.join(fixture.root, "personal/env"));
    },
  });
  for (const [bundle, folder] of [
    ["vendor", "knowledge"],
    ["claude", "commands"],
    ["personal", "skills"],
  ]) {
    await go(page, `/library/files?${new URLSearchParams({ bundle, path: folder })}`);
    const listing = await folderOf(app, folder, bundle);
    assert.equal(listing.newFile.allowed, false, `${bundle}/${folder}`);
    const create = page.locator(".folder-new").getByRole("button", { name: /^New (?!folder)/ });
    await expect(create).toHaveAttribute("aria-disabled", "true");
    await expect(page.locator(".folder-new")).toContainText(listing.newFile.reason);
    await create.click({ force: true });
    await expect(page.getByRole("textbox", { name: /Name of the new/ })).toHaveCount(0);
    const folderButton = page.getByRole("button", { name: "New folder", exact: true });
    if (listing.place.allowed) await expect(folderButton).not.toHaveAttribute("aria-disabled", "true");
    else {
      await expect(folderButton).toHaveAttribute("aria-disabled", "true");
      await expect(page.locator(".folder-new")).toContainText(listing.place.reason);
    }
  }
  // skills/ takes a folder, and the folder is made there.
  await go(page, "/library/files?bundle=personal&path=skills");
  await page.getByRole("button", { name: "New folder", exact: true }).click();
  await page.getByRole("textbox", { name: "Name of the new folder" }).fill("restore");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByRole("row", { name: /^restore/ })).toBeVisible();
  assert.equal((await fs.stat(path.join(app.root, "personal/skills/restore"))).isDirectory(), true);
});

test("a file that is no asset and an empty folder are deleted after one confirmation; an asset is retired; a folder with files is not deleted", async (t) => {
  const { app, page } = await session(t, {
    configureFixture: async (fixture) => {
      await fs.mkdir(path.join(fixture.root, "personal/notes"));
      await fs.writeFile(path.join(fixture.root, "personal/notes/todo.txt"), "one\n");
      await fs.mkdir(path.join(fixture.root, "personal/empty"));
    },
  });
  const row = (name) => page.getByRole("row", { name: new RegExp(`^${name}`) });
  const choose = async (name, item) => {
    await page.getByRole("button", { name: `Actions for ${name}`, exact: true }).click();
    return page.getByRole("menuitem", { name: new RegExp(`^${item}`) });
  };
  await go(page, "/library/files?bundle=personal&path=");
  // A folder with files says why it is not deleted: akm's sentence, on a control that stays focusable.
  const full = await choose("notes", "Delete");
  await expect(full).toHaveAttribute("aria-disabled", "true");
  await expect(full).toContainText(await reasonOf(app, "personal", "", "notes", "delete"));
  await full.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.keyboard.press("Escape");
  // An empty folder: one confirmation, then it is gone.
  await (await choose("empty", "Delete")).click();
  await expect(page.getByRole("dialog", { name: "Delete empty?" })).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: "Delete", exact: true }).click();
  await expect(row("empty")).toHaveCount(0);
  assert.equal(await exists(path.join(app.root, "personal/empty")), false);
  // A file that is no asset.
  await go(page, "/library/files?bundle=personal&path=notes");
  await (await choose("todo.txt", "Delete")).click();
  await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
  assert.equal(await exists(path.join(app.root, "personal/notes/todo.txt")), true, "cancelling deletes nothing");
  await expect(page.getByRole("button", { name: "Actions for todo.txt" })).toBeFocused();
  await (await choose("todo.txt", "Delete")).click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete", exact: true }).click();
  await expect(row("todo.txt")).toHaveCount(0);
  assert.equal(await exists(path.join(app.root, "personal/notes/todo.txt")), false);
  // An asset is retired, not deleted, and the archive is recoverable.
  await go(page, "/library/files?bundle=personal&path=knowledge");
  const asset = await choose("review-example.md", "Delete");
  await expect(asset).toHaveAttribute("aria-disabled", "true");
  await expect(asset).toContainText(await reasonOf(app, "personal", "knowledge", "review-example.md", "delete"));
  await page.getByRole("menuitem", { name: /^Retire/ }).click();
  await expect(page.getByRole("status").filter({ hasText: "Retired review-example.md." })).toBeAttached();
  await expect(row("review-example")).toHaveCount(0);
  assert.equal(await exists(path.join(app.root, "personal/knowledge/review-example.md")), false);
});

const uncommitted = async (app, bundle) =>
  (await app.call("/api/bundles")).body.data.bundles.find((entry) => entry.name === bundle).git?.uncommitted;

test("the bundle header counts the files akm would commit and a Commit button commits them, showing what it did; nothing commits by itself", async (t) => {
  const { app, page } = await session(t, { git: true });
  await fs.writeFile(path.join(app.root, "personal/knowledge/new-note.md"), "# New note\n");
  await fs.writeFile(path.join(app.root, "personal/knowledge/another.md"), "# Another\n");
  assert.equal(await uncommitted(app, "personal"), 2);
  await go(page, "/library/files?bundle=personal&path=knowledge");
  const header = page.getByRole("region", { name: "Git for personal" });
  await expect(header).toContainText("2 files uncommitted");
  assert.equal(
    (await fs.readdir(path.join(app.root, "personal/.git"))).includes("COMMIT_EDITMSG"),
    true,
    "the fixture's own commits exist",
  );
  const head = async () =>
    (await app.call("/api/bundles")).body.data.bundles.find((b) => b.name === "personal").git.lastCommit.sha;
  const before = await head();
  await header.getByRole("button", { name: "Commit" }).click();
  await expect(header.getByRole("status")).toContainText("Committed");
  await expect(header).toContainText("0 files uncommitted");
  const after = await head();
  assert.notEqual(after, before, "one commit was made");
  assert.equal(await uncommitted(app, "personal"), 0);
  // A bundle that is not a Git repository has no header.
  await go(page, "/library/files?bundle=shared&path=knowledge");
  await expect(page.getByRole("region", { name: "Git for shared" })).toHaveCount(0);
});

test("when akm could not list the changes the count is unknown, never zero", async (t) => {
  const { app, page } = await session(t, { git: true });
  await page.route("**/api/bundles", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    for (const entry of body.data.bundles) if (entry.git) entry.git.uncommitted = null;
    await route.fulfill({ response, json: body });
  });
  await page.goto(`${app.origin}/library/files?bundle=personal&path=knowledge`);
  const header = page.getByRole("region", { name: "Git for personal" });
  await expect(header).toContainText("unknown");
  await expect(header).not.toContainText("0 files");
});

test("in env/ and secrets/ the button names what akm says the folder takes and opens the protected editor; no other folder offers one", async (t) => {
  const { app, page } = await session(t, {
    configureFixture: async (fixture) => {
      for (const folder of ["env", "secrets"]) await fs.mkdir(path.join(fixture.root, "personal", folder));
    },
  });
  for (const [folder, label, kind] of [
    ["env", "New environment file", "env"],
    ["secrets", "New secret", "secret"],
  ]) {
    const verdict = (await folderOf(app, folder)).newFile;
    assert.deepEqual([verdict.type, verdict.through], [kind, "protected-editor"]);
    await go(page, `/library/files?${new URLSearchParams({ bundle: "personal", path: folder })}`);
    await page.getByRole("button", { name: label, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`new-sensitive\\?kind=${kind}`));
    await expect(page.locator(".sensitive-editor form")).toBeVisible();
  }
  await go(page, "/library/files?bundle=personal&path=knowledge");
  await expect(page.getByRole("button", { name: /protected/i })).toHaveCount(0);
  await expect(page.getByRole("link", { name: /Environment file|Secret/ })).toHaveCount(0);
});

test("Settings counts a bundle's uncommitted files as the Files header does, from akm's one number", async (t) => {
  const { app, page } = await session(t, { git: true });
  await fs.writeFile(path.join(app.root, "personal/knowledge/one.md"), "# One\n");
  await fs.writeFile(path.join(app.root, "personal/knowledge/two.md"), "# Two\n");
  assert.equal(await uncommitted(app, "personal"), 2);
  await go(page, "/settings/bundles");
  await page.getByRole("link", { name: "Manage personal", exact: true }).click();
  await expect(page.getByText("Uncommitted").locator("xpath=following-sibling::dd[1]")).toHaveText(/2 files/);
});

test("Write this up makes a knowledge file in akm's write target through the same create as New, and opens the editor", async (t) => {
  const { app, page } = await session(t);
  await go(page, "/library/search?q=zzqqxx+nothing+matches");
  await page.getByRole("button", { name: "Write this up" }).click();
  await expect(page.getByRole("button", { name: "Save changes" })).toBeVisible();
  const writeTarget = (await app.call("/api/bundles")).body.data.writeTarget.name;
  const place = (await folderOf(app, "knowledge", writeTarget)).entries.find(
    (entry) => entry.name === "zzqqxx-nothing-matches.md",
  );
  assert.ok(place, "the file is in the knowledge folder of the write target");
  assert.equal(place.assets[0].type, "knowledge");
});

test("the editor's save line says what is true of Git from akm's count, not that Git is unchanged", async (t) => {
  const { app, page } = await session(t, { git: true });
  await fs.writeFile(path.join(app.root, "personal/knowledge/loose.md"), "# Loose\n");
  const count = await uncommitted(app, "personal");
  assert.equal(count, 1);
  const editUrl = (ref) =>
    `/library/edit?${new URLSearchParams({ ref, returnTo: "/library/files?bundle=personal&path=knowledge" })}`;
  await go(page, editUrl(app.refs.document));
  const line = page.locator(".save-policy");
  await expect(line).toContainText(`${count} file uncommitted`);
  await expect(line).not.toContainText("Git is not changed");
  // A bundle that is not a Git repository says nothing about Git.
  await go(
    page,
    `/library/edit?${new URLSearchParams({ ref: app.refs.shared, returnTo: "/library/files?bundle=shared&path=knowledge" })}`,
  );
  await expect(page.locator(".save-policy")).toContainText("Saves to the file.");
  await expect(page.locator(".save-policy")).not.toContainText("uncommitted");
});
