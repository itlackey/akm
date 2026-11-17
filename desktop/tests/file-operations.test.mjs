// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { launchFixture } from "./support.mjs";

const value = (result) => {
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body.data;
};
const move = (app, body) => app.call("/api/desktop/files/move", { bundle: "personal", ...body });
const folderOf = async (app, folder, bundle = "personal") =>
  value(await app.call(`/api/bundles/files?${new URLSearchParams({ bundle, path: folder, hidden: "1" })}`));
const exists = (file) =>
  fs.access(file).then(
    () => true,
    () => false,
  );

const folder = (app, body) => app.call("/api/desktop/files/folder", { bundle: "personal", ...body });
const remove = (app, body) => app.call("/api/desktop/files/delete", { bundle: "personal", ...body });
const asset = (app, ref) => app.call(`/api/asset?ref=${encodeURIComponent(ref)}`);

test("a file moved on disk is the same asset at its new place, with its feedback", async (t) => {
  const app = await launchFixture({ metrics: true });
  t.after(() => app.stop());
  assert.ok(value(await asset(app, app.refs.document)).feedback.counts.positive >= 1);
  value(await folder(app, { folder: "knowledge", name: "archive" }));
  const moved = value(
    await move(app, { from: "knowledge/restore-laptop.md", folder: "knowledge/archive", name: "restore-laptop.md" }),
  );
  assert.equal(moved.done, true);
  assert.deepEqual(moved.assets, [{ ref: "personal//knowledge/archive/restore-laptop", type: "knowledge" }]);
  assert.deepEqual(
    moved.moves.moved.map((pair) => pair.to),
    ["personal//knowledge/archive/restore-laptop"],
  );
  assert.equal(await exists(app.documentPath), false);
  const after = value(await asset(app, moved.assets[0].ref));
  assert.ok(after.feedback.counts.positive >= 1, "its history went with it");
});

test("a rename keeps the folder; a skill moves as its folder and a file that is no asset moves too", async (t) => {
  const app = await launchFixture({
    configureFixture: async (fixture) => {
      await fs.mkdir(path.join(fixture.root, "personal/notes"));
      await fs.writeFile(path.join(fixture.root, "personal/notes/todo.txt"), "one\n");
    },
  });
  t.after(() => app.stop());
  value(await folder(app, { folder: "", name: "archive" }));
  const skill = value(await move(app, { from: "skills/backup-check", folder: "archive", name: "backup-check" }));
  assert.equal(skill.done, true);
  assert.ok(await exists(path.join(app.root, "personal/archive/backup-check/SKILL.md")));
  assert.equal(
    value(await app.call(`/api/search?q=backup&type=skill&belief=all`)).hits.some((hit) =>
      hit.ref.includes("archive/backup-check"),
    ),
    true,
    "the skill is indexed at its new place",
  );
  const renamed = value(await move(app, { from: "notes/todo.txt", folder: "notes", name: "done.txt" }));
  assert.equal(renamed.to, "notes/done.txt");
  assert.deepEqual(renamed.assets, []);
  assert.equal(await fs.readFile(path.join(app.root, "personal/notes/done.txt"), "utf8"), "one\n");
  assert.equal(await exists(path.join(app.root, "personal/notes/todo.txt")), false);
});

test("a move akm refuses is refused with akm's sentence and changes nothing", async (t) => {
  const app = await launchFixture({
    configureFixture: async (fixture) => {
      await fs.mkdir(path.join(fixture.root, "personal/env"));
      await fs.writeFile(path.join(fixture.root, "personal/env/prod.env"), "TOKEN=synthetic\n");
    },
  });
  t.after(() => app.stop());
  value(await folder(app, { folder: "", name: "archive" }));
  const verdict = async (bundle, dir, name, action) =>
    (await folderOf(app, dir, bundle)).entries.find((entry) => entry.name === name).actions[action];
  for (const [bundle, dir, name, destination] of [
    ["vendor", "knowledge", "vendor-backup.md", "knowledge"],
    ["personal", "env", "prod.env", "archive"],
    ["personal", "skills/backup-check", "SKILL.md", "archive"],
  ]) {
    const reason = (await verdict(bundle, dir, name, "move")).reason;
    assert.ok(reason, `akm refuses ${bundle}/${dir}/${name}`);
    const refused = await app.call("/api/desktop/files/move", {
      bundle,
      from: dir ? `${dir}/${name}` : name,
      folder: destination,
      name: `${name}.moved`,
    });
    assert.equal(refused.status, 400);
    assert.equal(refused.body.error, reason);
  }
  const intoEnv = await move(app, { from: "knowledge/restore-laptop.md", folder: "env", name: "restore-laptop.md" });
  assert.equal(intoEnv.status, 400);
  assert.equal(intoEnv.body.error, (await folderOf(app, "env")).place.reason);
  assert.ok(await exists(app.documentPath));
  assert.ok(await exists(path.join(app.root, "vendor/knowledge/vendor-backup.md")));
});

test("a move never replaces what is at the destination, and a name carries no folder", async (t) => {
  const app = await launchFixture();
  t.after(() => app.stop());
  const taken = await move(app, {
    from: "knowledge/restore-laptop.md",
    folder: "knowledge",
    name: "review-example.md",
  });
  assert.equal(taken.status, 400);
  assert.equal(taken.body.code, "RESOURCE_ALREADY_EXISTS");
  assert.match(
    await fs.readFile(path.join(app.root, "personal/knowledge/review-example.md"), "utf8"),
    /Original review guidance/,
  );
  const outside = await move(app, { from: "knowledge/restore-laptop.md", folder: "knowledge", name: "../escape.md" });
  assert.equal(outside.status, 400);
  assert.equal(await exists(path.join(app.root, "personal/escape.md")), false);
  assert.ok(await exists(app.documentPath));
});

test("a folder is made where akm says a folder may go, and skills/ is such a place", async (t) => {
  const app = await launchFixture({
    configureFixture: async (fixture) => {
      await fs.mkdir(path.join(fixture.root, "personal/env"));
    },
  });
  t.after(() => app.stop());
  assert.equal((await folderOf(app, "skills")).newFile.allowed, false, "akm takes no file of its own there");
  assert.equal(value(await folder(app, { folder: "skills", name: "restore" })).path, "skills/restore");
  assert.ok((await fs.stat(path.join(app.root, "personal/skills/restore"))).isDirectory());
  const refused = await folder(app, { folder: "env", name: "x" });
  assert.equal(refused.status, 400);
  assert.equal(refused.body.error, (await folderOf(app, "env")).place.reason);
  assert.equal(await exists(path.join(app.root, "personal/env/x")), false);
  assert.equal((await folder(app, { folder: "skills", name: "restore" })).body.code, "RESOURCE_ALREADY_EXISTS");
  assert.equal((await folder(app, { folder: "", name: "a/b" })).status, 400);
});

test("an empty folder and a file that is no asset are deleted; an asset and a full folder are not", async (t) => {
  const app = await launchFixture({
    configureFixture: async (fixture) => {
      await fs.mkdir(path.join(fixture.root, "personal/notes"));
      await fs.writeFile(path.join(fixture.root, "personal/notes/todo.txt"), "one\n");
      await fs.mkdir(path.join(fixture.root, "personal/empty"));
    },
  });
  t.after(() => app.stop());
  const refusals = [
    ["knowledge/restore-laptop.md", app.documentPath],
    ["notes", path.join(app.root, "personal/notes/todo.txt")],
  ];
  for (const [inside, survivor] of refusals) {
    const dir = inside.includes("/") ? inside.slice(0, inside.lastIndexOf("/")) : "";
    const reason = (await folderOf(app, dir)).entries.find((entry) => entry.path === inside).actions.delete.reason;
    assert.ok(reason, inside);
    const refused = await remove(app, { path: inside });
    assert.equal(refused.status, 400);
    assert.equal(refused.body.error, reason);
    assert.ok(await exists(survivor));
  }
  value(await remove(app, { path: "notes/todo.txt" }));
  value(await remove(app, { path: "empty" }));
  value(await remove(app, { path: "notes" }));
  assert.equal(await exists(path.join(app.root, "personal/notes")), false);
  assert.equal(await exists(path.join(app.root, "personal/empty")), false);
});

test("the files akm hides from plain operations are untouched: .git, .akm and env", async (t) => {
  const app = await launchFixture({
    git: true,
    configureFixture: async (fixture) => {
      await fs.mkdir(path.join(fixture.root, "personal/env"), { recursive: true });
      await fs.writeFile(path.join(fixture.root, "personal/env/prod.env"), "TOKEN=synthetic\n");
    },
  });
  t.after(() => app.stop());
  for (const target of [".git", "env/prod.env"]) {
    assert.equal((await remove(app, { path: target })).status, 400, target);
    assert.equal((await move(app, { from: target, folder: "knowledge", name: "taken" })).status, 400, target);
  }
  assert.ok(await exists(path.join(app.root, "personal/.git/HEAD")));
  assert.equal(await fs.readFile(path.join(app.root, "personal/env/prod.env"), "utf8"), "TOKEN=synthetic\n");
});

test("links that still name the old place are listed, and one request rewrites them", async (t) => {
  const app = await launchFixture({
    configureFixture: async (fixture) => {
      await fs.writeFile(
        path.join(fixture.root, "personal/knowledge/linker.md"),
        "---\ndescription: Links to the checklist\nupdated: 2026-11-01\n---\n\nSee personal//knowledge/restore-laptop for details.\n",
      );
    },
  });
  t.after(() => app.stop());
  value(await folder(app, { folder: "knowledge", name: "archive" }));
  value(
    await move(app, { from: "knowledge/restore-laptop.md", folder: "knowledge/archive", name: "restore-laptop.md" }),
  );
  const listed = value(await app.call("/api/assets/moved-links"));
  assert.equal(listed.total, 1);
  const own = listed.bundles.find((entry) => entry.bundle === "personal");
  assert.equal(own.links[0].to, "personal//knowledge/archive/restore-laptop");
  const fixed = value(await app.call("/api/assets/update-moved-links", { bundle: "personal" }));
  assert.equal(fixed.rewritten, 1);
  assert.match(
    await fs.readFile(path.join(app.root, "personal/knowledge/linker.md"), "utf8"),
    /personal\/\/knowledge\/archive\/restore-laptop/,
  );
  assert.equal(value(await app.call("/api/assets/moved-links")).total, 0);
});

test("a copy is a new file at the chosen folder, in the same bundle or another; the original stays", async (t) => {
  const app = await launchFixture();
  t.after(() => app.stop());
  const copy = (body) => app.call("/api/desktop/files/copy", { bundle: "personal", ...body });
  const same = value(await copy({ from: "skills/backup-check", folder: "skills", name: "backup-check-2" }));
  assert.equal(same.done, true);
  assert.ok(await exists(path.join(app.root, "personal/skills/backup-check/SKILL.md")));
  assert.ok(await exists(path.join(app.root, "personal/skills/backup-check-2/references/checklist.md")));
  const across = value(
    await copy({
      from: "knowledge/restore-laptop.md",
      toBundle: "shared",
      folder: "knowledge",
      name: "restore-laptop.md",
    }),
  );
  assert.deepEqual(across.assets, [{ ref: "shared//knowledge/restore-laptop", type: "knowledge" }]);
  assert.ok(await exists(app.documentPath));
  const taken = await copy({ from: "knowledge/restore-laptop.md", folder: "knowledge", name: "restore-laptop.md" });
  assert.equal(taken.body.code, "RESOURCE_ALREADY_EXISTS");
  const intoVendor = await copy({
    from: "knowledge/restore-laptop.md",
    toBundle: "vendor",
    folder: "knowledge",
    name: "copy.md",
  });
  assert.equal(intoVendor.status, 400);
  assert.equal(intoVendor.body.error, (await folderOf(app, "knowledge", "vendor")).place.reason);
  assert.equal(await exists(path.join(app.root, "vendor/knowledge/copy.md")), false);
});

test("a skill's support file is moved like any file, and showing a file in the file manager needs the desktop app", async (t) => {
  const app = await launchFixture();
  t.after(() => app.stop());
  const moved = value(
    await move(app, {
      from: "skills/backup-check/references/checklist.md",
      folder: "skills/backup-check/references",
      name: "checklist-v2.md",
    }),
  );
  assert.equal(moved.to, "skills/backup-check/references/checklist-v2.md");
  assert.ok(await exists(path.join(app.root, "personal/skills/backup-check/references/checklist-v2.md")));
  assert.equal(await exists(path.join(app.root, "personal/skills/backup-check/references/checklist.md")), false);
  const reveal = await app.call("/api/desktop/files/reveal", {
    bundle: "personal",
    path: "knowledge/restore-laptop.md",
  });
  assert.deepEqual([reveal.status, reveal.body.code], [400, "REVEAL_FAILED"]);
  assert.match(reveal.body.error, /AKM Desktop app/);
  assert.equal(
    (await app.call("/api/desktop/files/reveal", { bundle: "personal", path: "knowledge/none.md" })).status,
    400,
  );
});
