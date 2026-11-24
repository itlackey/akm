// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test, { after } from "node:test";
import { chromium, expect } from "@playwright/test";
import { akm, go, launchFixture } from "./support.mjs";

export const lesson =
  "---\ndescription: Restore in order\nwhen_to_use: Before restoring a laptop\ntags: [backup, restore]\ncustom_key: kept as written\nupdated: 2026-11-01\n---\n# Restore order\n\nRestore the disk first.\n";
export const task = "version: 4\nname: nightly\nrun: echo nightly\n";
export const script = '#!/bin/sh\nprintf "hello from the script\\n"\n';

/** A library with a lesson, a workflow, a script and a task of its own, and a claude bundle. */
export async function kinds(fixture) {
  const put = async (relative, content) => {
    await fs.mkdir(path.dirname(path.join(fixture.root, relative)), { recursive: true });
    await fs.writeFile(path.join(fixture.root, relative), content);
  };
  await put("personal/lessons/restore-order.md", lesson);
  await put("personal/scripts/hello.sh", script);
  await put("personal/tasks/nightly.yml", task);
  const config = path.join(fixture.root, "config/config.json");
  const json = JSON.parse(await fs.readFile(config, "utf8"));
  json.bundles.claude = {
    path: path.join(fixture.root, "claude"),
    writable: true,
    adapter: "claude",
  };
  await fs.writeFile(config, JSON.stringify(json));
  await put("claude/commands/review.md", "---\ndescription: Review a change\n---\n# Review\n\nLook at the diff.\n");
  akm(fixture, ["workflow", "create", "release-check"]);
  akm(fixture, ["index", "--full"]);
}

async function session(t, options = {}, viewport = { width: 1280, height: 860 }) {
  const app = await launchFixture({ configureFixture: kinds, ...options });
  t.after(() => app.stop());
  return browse(t, app, viewport);
}
// The tests that only read share one workspace; each starts its own browser.
let shared;
after(async () => (await shared?.catch(() => null))?.stop());
function readingSession(t) {
  shared ??= launchFixture({ configureFixture: kinds });
  return shared.then((app) => browse(t, app));
}
async function browse(t, app, viewport = { width: 1280, height: 860 }) {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport });
  await page.goto(app.url);
  return { app, page };
}
const open = (page, bundle, folder, name, ref) =>
  go(
    page,
    `/library/files?${new URLSearchParams({ bundle, path: folder, file: `${folder}/${name}`, ref, open: "1" })}`,
  );

test("every kind shows its frontmatter under the title, the keys that find it first, and Source is the whole file", async (t) => {
  const { app, page } = await readingSession(t);
  await open(page, "personal", "lessons", "restore-order.md", "personal//lessons/restore-order");
  const properties = page.getByRole("region", { name: "Properties" });
  await expect(properties).toContainText("Restore in order");
  await expect(properties).toContainText("custom_key");
  await expect(properties).toContainText("kept as written");
  await expect(properties).toContainText("backup, restore");
  const keys = await properties.locator("dt").allTextContents();
  assert.deepEqual(
    keys.slice(0, 4),
    ["description", "tags", "updated", "when_to_use"],
    "description, tags and updated come first",
  );
  await page.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("button", { name: "Source", exact: true }).click();
  const source = page.getByRole("group", { name: "Source" });
  assert.equal((await source.innerText()).trim(), lesson.trim(), "the source is the whole file, frontmatter included");
  // A workflow reads with its steps.
  const workflow = (await app.call("/api/search?q=release&type=workflow&belief=all")).body.data.hits[0].ref;
  await open(page, "personal", "workflows", "release-check.md", workflow);
  await expect(page.getByRole("region", { name: "Properties" })).toContainText("first-step");
  await expect(page.locator(".document-body")).toContainText("first-step");
});

test("a script reads as code and a task as YAML with its lines", async (t) => {
  const { page } = await readingSession(t);
  await open(page, "personal", "scripts", "hello.sh", "personal//scripts/hello.sh");
  await expect(page.locator(".document-body pre")).toContainText("hello from the script");
  await expect(page.getByText("This asset has no body.")).toHaveCount(0);
  await open(page, "personal", "tasks", "nightly.yml", "personal//tasks/nightly");
  await expect(page.locator(".document-body pre")).toContainText("run: echo nightly");
  const text = await page.locator(".document-body pre").innerText();
  assert.equal(text, task, "the YAML keeps its line breaks");
});

test("another adapter's bundle shows its properties, and a frontmatter that does not parse says why", async (t) => {
  const { app, page } = await session(t, {
    configureFixture: async (fixture) => {
      await kinds(fixture);
      await fs.writeFile(
        path.join(fixture.root, "personal/lessons/broken.md"),
        "---\ndescription: Broken\nwhen_to_use: [unclosed\n---\n# Broken\n",
      );
    },
  });
  const read = async (bundle, file, content) =>
    await app.call("/api/documents/frontmatter", { bundle, path: file, content });
  await open(page, "claude", "commands", "review.md", "claude//commands/review");
  // Another adapter's bundle reads the same: akm reads the frontmatter and the page is Markdown.
  await expect(page.getByRole("region", { name: "Properties" })).toContainText("Review a change");
  await expect(page.locator(".document-body")).toContainText("Look at the diff.");
  await go(
    page,
    `/library/files?${new URLSearchParams({ bundle: "personal", path: "lessons", file: "lessons/broken.md", open: "1" })}`,
  );
  const broken = (
    await read(
      "personal",
      "lessons/broken.md",
      await fs.readFile(path.join(app.root, "personal/lessons/broken.md"), "utf8"),
    )
  ).body.data.error;
  assert.ok(broken.reason);
  await expect(page.getByRole("alert").filter({ hasText: "The frontmatter cannot be read" })).toContainText(
    broken.reason,
  );
  await expect(page.getByRole("alert").filter({ hasText: "The frontmatter cannot be read" })).toContainText(
    `line ${broken.line}`,
  );
});

const edit = (page, ref, bundle, folder, name) =>
  go(
    page,
    `/library/edit?${new URLSearchParams({
      ref,
      returnTo: `/library/files?${new URLSearchParams({ bundle, path: folder, file: `${folder}/${name}`, ref, open: "1" })}`,
    })}`,
  );
const lessonPath = (app) => path.join(app.root, "personal/lessons/restore-order.md");

test("the editor's properties are fields: change, add and remove a key through akm; unknown keys and the body stay as written", async (t) => {
  const { app, page } = await session(t);
  await edit(page, "personal//lessons/restore-order", "personal", "lessons", "restore-order.md");
  const form = page.getByRole("group", { name: "Properties" });
  await expect(form.getByLabel(/^description \(required\)/)).toHaveValue("Restore in order");
  await expect(form.getByLabel(/^when_to_use \(required\)/)).toHaveValue("Before restoring a laptop");
  await expect(form.getByLabel("custom_key")).toHaveValue("kept as written");
  await form.getByLabel(/^description/).fill("Restore a laptop in order");
  await form.getByLabel(/^description/).blur();
  await form.getByLabel("New property").fill("owner");
  await form.getByLabel("Value", { exact: true }).fill("ops");
  await form.getByRole("button", { name: "Add property" }).click();
  await form.getByRole("button", { name: "Remove custom_key" }).click();
  const box = page.getByRole("textbox", { name: /^Markdown (body|source)/ });
  await expect(box).toHaveValue("# Restore order\n\nRestore the disk first.\n");
  await page.getByRole("button", { name: "Text", exact: true }).click();
  await expect(box).toHaveValue(/description: Restore a laptop in order\n/);
  await expect(box).toHaveValue(/owner: ops\n---\n/);
  await expect(box).not.toHaveValue(/custom_key/);
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Changes saved." })).toBeVisible();
  assert.equal(
    await fs.readFile(lessonPath(app), "utf8"),
    "---\ndescription: Restore a laptop in order\nwhen_to_use: Before restoring a laptop\ntags: [backup, restore]\nupdated: 2026-11-01\nowner: ops\n---\n# Restore order\n\nRestore the disk first.\n",
  );
});

test("a frontmatter the form cannot express opens as text with akm's reason, and the text view is the whole file", async (t) => {
  const { app, page } = await session(t, {
    configureFixture: async (fixture) => {
      await kinds(fixture);
      await fs.writeFile(
        path.join(fixture.root, "personal/lessons/broken.md"),
        "---\ndescription: Broken\nwhen_to_use: [unclosed\n---\n# Broken\n",
      );
    },
  });
  const broken = (
    await app.call("/api/documents/frontmatter", {
      bundle: "personal",
      path: "lessons/broken.md",
      content: await fs.readFile(path.join(app.root, "personal/lessons/broken.md"), "utf8"),
    })
  ).body.data.error;
  await go(
    page,
    `/library/edit?${new URLSearchParams({ bundle: "personal", file: "lessons/broken.md", returnTo: "/library/files?bundle=personal&path=lessons" })}`,
  );
  await expect(page.getByRole("group", { name: "Properties" })).toHaveCount(0);
  await expect(page.getByRole("status").filter({ hasText: "cannot be read as fields" })).toContainText(broken.reason);
  await expect(page.getByRole("button", { name: "Fields", exact: true })).toHaveAttribute("aria-disabled", "true");
  await expect(page.getByRole("textbox", { name: /^Markdown (body|source)/ })).toHaveValue(
    /^---\ndescription: Broken\nwhen_to_use: \[unclosed/,
  );
});

test("save checks: findings are listed with their lines and jump to them; one that would stop akm reading the asset stops the save, and Save anyway saves it", async (t) => {
  const { app, page } = await session(t);
  await edit(page, "personal//lessons/restore-order", "personal", "lessons", "restore-order.md");
  await page.getByRole("button", { name: "Text", exact: true }).click();
  const box = page.getByRole("textbox", { name: /^Markdown (body|source)/ });
  const checks = page.getByRole("complementary", { name: "Checks" });
  await expect(checks).toContainText("akm found no problems.");
  // A finding that does not stop akm reading the asset is listed and does not block the save.
  const noUpdated = lesson.replace("updated: 2026-11-01\n", "");
  const finding = (
    await app.call("/api/documents/check", { bundle: "personal", path: "lessons/restore-order.md", content: noUpdated })
  ).body.data.findings[0];
  await box.fill(noUpdated);
  await expect(checks.getByRole("listitem")).toContainText(finding.detail);
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Changes saved." })).toBeVisible();
  const original = await fs.readFile(lessonPath(app), "utf8");
  assert.equal(original, noUpdated, "a finding that leaves the asset readable does not block the save");
  await edit(page, "personal//lessons/restore-order", "personal", "lessons", "restore-order.md");
  await page.getByRole("button", { name: "Text", exact: true }).click();
  // A text akm cannot read stops the save.
  await box.fill(noUpdated.replace("tags: [backup, restore]", "tags: [backup, restore"));
  await expect(checks).toContainText("akm could not read this as an asset");
  const reasonLine = checks.getByRole("button", { name: /^Line \d+$/ }).first();
  const unreadable = (
    await app.call("/api/documents/check", {
      bundle: "personal",
      path: "lessons/restore-order.md",
      content: noUpdated.replace("tags: [backup, restore]", "tags: [backup, restore"),
    })
  ).body.data;
  assert.equal(unreadable.readable, false);
  await page.getByRole("button", { name: "Save changes" }).click();
  const stopped = page.getByRole("alert").filter({ hasText: "Not saved." });
  await expect(stopped).toContainText(unreadable.unreadable.reason);
  assert.equal(await fs.readFile(lessonPath(app), "utf8"), original, "nothing was written");
  await stopped.getByRole("button", { name: "Keep editing" }).click();
  await expect(stopped).toHaveCount(0);
  await reasonLine.click();
  await expect(box).toBeFocused();
  assert.equal(
    await box.evaluate((area) => area.value.slice(0, area.selectionStart).split("\n").length),
    unreadable.unreadable.line,
    "the cursor is on the line akm names",
  );
  await page.getByRole("button", { name: "Save changes" }).click();
  await page.getByRole("alert").filter({ hasText: "Not saved." }).getByRole("button", { name: "Save anyway" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Changes saved." })).toBeVisible();
  assert.match(await fs.readFile(lessonPath(app), "utf8"), /tags: \[backup, restore\n/);
  // The page says why akm cannot read the frontmatter: akm's own reason.
  await expect(page.getByRole("alert").filter({ hasText: "The frontmatter cannot be read" })).toContainText(
    unreadable.unreadable.reason,
  );
});

test("a workflow that would not compile stops the save; saved anyway it drops out of the index and is shown as not indexed with akm's reason", async (t) => {
  const { app, page } = await session(t);
  const ref = (await app.call("/api/search?q=release&type=workflow&belief=all")).body.data.hits[0].ref;
  const file = path.join(app.root, "personal/workflows/release-check.md");
  const before = await fs.readFile(file, "utf8");
  const broken = before.replace(/steps:[\s\S]*?\n---/, "steps: nope\n---");
  assert.notEqual(broken, before);
  await edit(page, ref, "personal", "workflows", "release-check.md");
  await page.getByRole("button", { name: "Text", exact: true }).click();
  await page.getByRole("textbox", { name: /^Markdown (body|source)/ }).fill(broken);
  const verdict = (
    await app.call("/api/documents/check", { bundle: "personal", path: "workflows/release-check.md", content: broken })
  ).body.data;
  assert.equal(verdict.readable, false);
  // Each finding is listed with the line akm gives, and the button puts the cursor there.
  const lined = verdict.findings.find((finding) => finding.line);
  const checks = page.getByRole("complementary", { name: "Checks" });
  await checks
    .getByRole("button", { name: `Line ${lined.line}`, exact: true })
    .first()
    .click();
  const box = page.getByRole("textbox", { name: /^Markdown (body|source)/ });
  await expect(box).toBeFocused();
  assert.equal(await box.evaluate((area) => area.value.slice(0, area.selectionStart).split("\n").length), lined.line);
  await page.getByRole("button", { name: "Save changes" }).click();
  // akm names the file by its path in the bundle, not the scratch folder the check ran in.
  assert.doesNotMatch(verdict.unreadable.reason, /akm-check-/);
  const reason = verdict.unreadable.reason.split("\n").slice(1).join("\n").trim();
  assert.match(reason, /^Workflow has errors/);
  await expect(page.getByRole("alert").filter({ hasText: "Not saved." })).toContainText(reason.split("\n")[1]);
  assert.equal(await fs.readFile(file, "utf8"), before);
  await page.getByRole("button", { name: "Save anyway" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Not indexed" })).toContainText(reason.split("\n")[1]);
  assert.equal(await fs.readFile(file, "utf8"), broken);
});

test("a text akm cannot check is saved, and the page says it could not check", async (t) => {
  const { app, page } = await session(t);
  await edit(page, "claude//commands/review", "claude", "commands", "review.md");
  const refused = (
    await app.call("/api/documents/check", { bundle: "claude", path: "commands/review.md", content: "x" })
  ).body.error;
  await expect(page.getByRole("complementary", { name: "Checks" })).toContainText(
    `akm could not check this text: ${refused}`,
  );
  await page
    .getByRole("textbox", { name: /^Markdown (body|source)/ })
    .fill("---\ndescription: Review a change\n---\n# Review\n\nLook closely.\n");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Changes saved." })).toBeVisible();
  assert.match(await fs.readFile(path.join(app.root, "claude/commands/review.md"), "utf8"), /Look closely/);
});

test("an asset with no file in a bundle is read from the text akm returned, from the body start akm gives", async (t) => {
  const { app, page } = await readingSession(t);
  const ref = "registry//knowledge/remote-guide";
  await page.route("**/api/asset?*", async (route) => {
    const real = await (
      await route.fetch({ url: `${app.origin}/api/asset?ref=${encodeURIComponent(app.refs.document)}` })
    ).json();
    const content = "---\ndescription: From a registry\ncustom: x\n---\n# Remote guide\n\nRead this remote text.\n";
    await route.fulfill({
      json: {
        ...real,
        data: {
          ...real.data,
          location: null,
          actions: null,
          durableRef: ref,
          bodyStart: content.indexOf("# Remote guide"),
          asset: { ref, type: "knowledge", name: "remote-guide", content },
        },
      },
    });
  });
  await go(page, `/library/asset?ref=${encodeURIComponent(ref)}`);
  await expect(page.locator(".document-body")).toContainText("Read this remote text.");
  await expect(page.locator(".document-body")).not.toContainText("From a registry");
  await expect(page.locator(".document-body")).not.toContainText("custom");
});
