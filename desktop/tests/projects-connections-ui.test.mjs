// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { chromium, expect } from "@playwright/test";
import { projectsAndConnections as configure, launchFixture, open } from "./support.mjs";

const configOf = async (server) => JSON.parse(await readFile(path.join(server.root, "config/config.json"), "utf8"));

test("Projects: list, overview with counts, assets, add, edit, rename, remove; unsaved edits ask first", {
  timeout: 240000,
}, async (t) => {
  const server = await launchFixture({ configureFixture: configure });
  t.after(() => server.stop());
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await open(page, server, "/");
  const nav = page.getByRole("navigation", { name: "Primary navigation" });

  // Projects sits right after Library and is current on every project route.
  await expect(nav.getByRole("link")).toHaveCount(6);
  assert.deepEqual(await nav.getByRole("link").allInnerTexts(), [
    "Home",
    "Library",
    "Projects",
    "Review",
    "Activity",
    "Settings",
  ]);
  await nav.getByRole("link", { name: "Projects" }).click();
  await expect(page.getByRole("heading", { name: "Projects", level: 1 })).toBeVisible();
  await expect(page.getByRole("article")).toHaveCount(2);
  await page.getByRole("link", { name: "docs", exact: true }).click();
  await expect(page).toHaveURL(/\/projects\/docs$/);
  await expect(nav.getByRole("link", { name: "Projects" })).toHaveAttribute("aria-current", "page");

  // Eligible versus indexed come from akm: the filter matches nothing here, the bundle holds assets.
  const card = page.getByRole("article").filter({ hasText: "personal" });
  await expect(card).toContainText("eligible");
  await expect(card.getByText(/None of its \d+ assets match/)).toBeVisible();
  await expect(page.getByRole("article").filter({ hasText: "vendor" })).toContainText("Read-only");

  // Browse: the bundle's own assets, with the project kept in the crumbs and the reader.
  await page.goto(`${server.origin}/projects/notes`);
  await page
    .getByRole("link", { name: /^Browse \d+ assets/ })
    .first()
    .click();
  await expect(page.getByRole("heading", { name: /^Assets in personal/ })).toBeVisible();
  await expect(page.getByText(/\d+ eligible of \d+ indexed/)).toBeVisible();
  await page
    .getByRole("link", { name: /restore laptop/i })
    .first()
    .click();
  await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toContainText("notes");
  await expect(page.getByText("Reading in project notes.")).toBeVisible();
  await expect(page).toHaveURL(/\/projects\/notes\/asset\?ref=/);
  await page.goBack();
  await expect(page.getByRole("heading", { name: /^Assets in personal/ })).toBeVisible();
  await page.goto(`${server.origin}/projects/docs/assets`);
  await expect(page.getByRole("heading", { name: "No assets match this project" })).toBeVisible();

  // A project that reads several bundles and filters opens in the editor with its fields as configured.
  await page.goto(`${server.origin}/projects/docs/edit`);
  await expect(page.getByRole("checkbox", { name: "personal" })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "shared" })).not.toBeChecked();
  await expect(page.getByRole("button", { name: "Save project" })).toBeDisabled();

  // Add: validation is inline, a save toasts and opens the overview.
  await page.goto(`${server.origin}/projects?add`);
  await page.getByRole("button", { name: "Add project" }).click();
  await expect(page.getByText("Enter a name.")).toBeVisible();
  await page.getByLabel(/^Name/).fill("none");
  await page.getByRole("button", { name: "Add project" }).click();
  await expect(page.getByText("“none” is reserved. Choose another name.")).toBeVisible();
  await page.getByLabel(/^Name/).fill("docs");
  await expect(page.getByText("A project named “docs” already exists.")).toBeVisible();
  await page.getByLabel(/^Name/).fill("fresh");
  await page.getByLabel(/^Directories/).fill("/work/fresh");
  await page.getByRole("button", { name: "Add project" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Added project “fresh”" })).toBeVisible();
  await expect(page).toHaveURL(/\/projects\/fresh$/);
  assert.deepEqual((await configOf(server)).projects.fresh, { paths: ["/work/fresh"] });

  // Saving an existing project finishes: overview, toast, no "Discard unsaved changes?" and a clean guard.
  await page.goto(`${server.origin}/projects/docs/edit`);
  await page.getByLabel(/^Channel/).fill("synthetic-channel");
  await page.getByRole("button", { name: "Save project" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Saved project “docs”" })).toBeVisible();
  await expect(page).toHaveURL(/\/projects\/docs$/);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  assert.equal((await configOf(server)).projects.docs.write.channel, "synthetic-channel");
  await page.getByRole("link", { name: "Edit project" }).click();
  await page.getByLabel(/^Channel/).fill("again");
  await page.getByRole("button", { name: "Save project" }).click();
  await expect(page).toHaveURL(/\/projects\/docs$/);
  await page.goto(`${server.origin}/projects?add`);
  await page.getByLabel(/^Name/).fill("rel");
  await page.getByLabel(/^Directories/).fill("relative/path");
  await page.getByRole("button", { name: "Add project" }).click();
  await expect(page.getByText("Use an absolute path or one starting with ~.")).toBeVisible();
  assert.equal((await configOf(server)).projects.rel, undefined);
  await page.getByLabel(/^Directories/).fill("/work/rel");
  await page.getByRole("button", { name: "Add project" }).click();
  await expect(page).toHaveURL(/\/projects\/rel$/);

  // A dirty form asks before it is left; Keep editing stays.
  await page.goto(`${server.origin}/projects/fresh`);
  await page.getByRole("link", { name: "Edit project" }).click();
  await page.getByLabel(/^Directories/).fill("/work/changed");
  await expect(page.getByText("1 unsaved change")).toBeVisible();
  await page.getByRole("link", { name: "Cancel" }).click();
  const dialog = page.getByRole("dialog", { name: "Discard unsaved changes?" });
  await expect(dialog).toContainText("Your changes to “fresh” have not been saved.");
  await dialog.getByRole("button", { name: "Keep editing" }).click();
  await expect(page.getByLabel(/^Directories/)).toHaveValue("/work/changed");
  // Rename keeps the settings under the new name and the old name is gone.
  await page.getByLabel(/^Name/).fill("fresh-2");
  await page.getByRole("button", { name: "Save project" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Renamed project “fresh” to “fresh-2”" })).toBeVisible();
  // A rename lands on the new name's overview, not its edit form.
  await expect(page).toHaveURL(/\/projects\/fresh-2$/);
  await expect(page.getByRole("heading", { name: "fresh-2", level: 1 })).toBeVisible();
  const renamed = (await configOf(server)).projects;
  assert.deepEqual([renamed.fresh, renamed["fresh-2"]], [undefined, { paths: ["/work/changed"] }]);
  // Back to the old overview opens the renamed project instead of "Project not found".
  await page.goBack();
  await expect(page).toHaveURL(/\/projects\/fresh-2$/);
  await expect(page.getByRole("heading", { name: "fresh-2", level: 1 })).toBeVisible();
  await page.goto(`${server.origin}/projects/fresh`);
  await expect(page.getByRole("heading", { name: "Project not found" })).toBeVisible();

  // Remove only the entry, after a confirmation.
  await page.goto(`${server.origin}/projects/fresh-2/edit`);
  await page.getByRole("button", { name: "Remove fresh-2…" }).click();
  await expect(page.getByRole("button", { name: "Keep project" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Remove fresh-2…" })).toBeFocused();
  await page.getByRole("button", { name: "Remove fresh-2…" }).click();
  await page.getByRole("button", { name: "Remove project" }).click();
  await expect(page).toHaveURL(/\/projects$/);
  assert.equal((await configOf(server)).projects["fresh-2"], undefined);
  assert.deepEqual(Object.keys((await configOf(server)).projects), ["docs", "notes", "rel"]);

  // Old links land on the new destination.
  await page.goto(`${server.origin}/settings/config?section=projects`);
  await expect(page).toHaveURL(/\/projects$/);
  await page.goto(`${server.origin}/settings/config?section=connection-lab`);
  await expect(page).toHaveURL(/\/settings\/connections\?name=lab$/);
  await page.goto(`${server.origin}/settings/config?section=add-connection`);
  await expect(page).toHaveURL(/\/settings\/connections\?add$/);
  await page.goto(`${server.origin}/settings/config`);
  const sections = page.getByRole("navigation", { name: "Configuration sections" });
  await expect(sections.getByRole("link")).toHaveCount(4);
  assert.deepEqual(await sections.getByRole("link").allInnerTexts(), [
    "Library defaults",
    "Search",
    "Command output",
    "Advanced",
  ]);
  assert.deepEqual(errors, []);
});

test("Connections: list, detail, add, edit preserving options, delete with its consequences", {
  timeout: 240000,
}, async (t) => {
  const server = await launchFixture({ configureFixture: configure });
  t.after(() => server.stop());
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await open(page, server, "/settings/connections");
  await expect(page.getByRole("link", { name: "Connections", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(page.getByText("Default connection: default (named “default”).")).toBeVisible();
  await page.getByRole("link", { name: /^lab/ }).click();
  await expect(page.getByRole("heading", { name: "lab", level: 2 })).toBeFocused();
  await expect(page.getByText("temperature: 0")).toBeVisible();
  await expect(page.getByRole("definition").filter({ hasText: "improve.connection" })).toBeVisible();

  // Edit one alias: everything untouched is written back as it was (object model, other options).
  const before = (await configOf(server)).connections.lab;
  await page.getByRole("link", { name: "Edit" }).click();
  await expect(page.getByRole("button", { name: "Save connection" })).toBeDisabled();
  await page.getByRole("textbox", { name: /^Model\s*1/ }).fill("mid-2");
  await expect(page.getByText("1 unsaved change")).toBeVisible();
  await page.getByRole("button", { name: "Save connection" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Saved connection “lab”" })).toContainText("does not test");
  const after = (await configOf(server)).connections.lab;
  assert.deepEqual(after, { ...before, models: { ...before.models, summarize: "mid-2" } });

  // Clearing a model's options removes them from the file, and saving an existing connection finishes.
  await page.getByRole("link", { name: "Edit" }).click();
  await page.getByText("Options (1)").click();
  await page.getByRole("textbox", { name: "Request options for model 2" }).fill("");
  await page.getByRole("button", { name: "Save connection" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Saved connection “lab”" })).toBeVisible();
  await expect(page).toHaveURL(/\/settings\/connections\?name=lab$/);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  assert.equal((await configOf(server)).connections.lab.models.judge, "big");

  await page.goto(`${server.origin}/settings/connections`);
  await expect(page.getByRole("link", { name: /^default/ })).toBeVisible();
  assert.match(await page.getByRole("list").first().innerText(), /^default/);

  // Add: the key must be a reference; a literal one never reaches akm.
  await page.goto(`${server.origin}/settings/connections?add`);
  await page.getByLabel(/^Name/).fill("Bad Name");
  await page.getByLabel(/^Endpoint/).fill("nope");
  await page.getByLabel(/^API key reference/).fill("sk-literal");
  await page.getByRole("button", { name: "Add connection" }).click();
  await expect(page.getByText("Use lowercase letters, digits and hyphens")).toBeVisible();
  await expect(page.getByText("Enter a complete http or https URL.")).toBeVisible();
  await expect(page.getByText("not the key itself")).toBeVisible();
  await page.getByLabel(/^Name/).fill("extra");
  await page.getByLabel(/^Endpoint/).fill("https://api.example.test/v1");
  await page.getByLabel(/^API key reference/).fill("$EXTRA_KEY");
  for (const row of [1, 2, 3])
    await page.getByRole("textbox", { name: new RegExp(`^Model\\s*${row}`) }).fill(`m${row}`);
  await page.getByRole("button", { name: "Add connection" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Added connection “extra”" })).toBeVisible();
  assert.deepEqual((await configOf(server)).connections.extra.models, { fast: "m1", balanced: "m2", reasoning: "m3" });

  // Delete says what names it; afterwards the setting is reported, and unrelated settings stay.
  await page.goto(`${server.origin}/settings/connections?name=lab`);
  await page.getByRole("button", { name: "Delete…" }).click();
  const dialog = page.getByRole("dialog", { name: "Delete connection “lab”?" });
  await expect(dialog).toContainText("improve.connection");
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await dialog.getByRole("button", { name: "Delete connection" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Deleted connection “lab”" })).toContainText(
    "1 setting still names it",
  );
  await expect(page).toHaveURL(/\/settings\/connections$/);
  const saved = await configOf(server);
  assert.equal(saved.connections.lab, undefined);
  assert.deepEqual(Object.keys(saved.connections), ["default", "extra"]);
  assert.equal(saved.improve.connection, "lab");
  assert.deepEqual(errors, []);
});

test("Project assets: Show 50 more appends in place and focuses the first new row", { timeout: 240000 }, async (t) => {
  const server = await launchFixture({ assetCount: 70, configureFixture: configure });
  t.after(() => server.stop());
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await open(page, server, "/projects/notes/assets?bundle=personal");
  const rows = page.locator(".asset-row");
  await expect(rows).toHaveCount(50);
  const url = page.url();
  await page.getByRole("button", { name: "Show 50 more" }).click();
  await expect(rows).not.toHaveCount(50);
  assert.ok((await rows.count()) > 50);
  assert.equal(page.url(), url, "no navigation");
  assert.equal(
    await page.evaluate(() => [...document.querySelectorAll(".asset-row a")].indexOf(document.activeElement)),
    50,
    "focus is on the first new row",
  );
});
