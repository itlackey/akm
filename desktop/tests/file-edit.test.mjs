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
const read = (app, query) => app.call(`/api/desktop/file?${new URLSearchParams(query)}`);
const save = (app, body) => app.call("/api/desktop/file/save", body);
const skillFile = "skills/backup-check/scripts/check.sh";

test("a skill support file is read and saved with plain file operations; the mode survives", async (t) => {
  const app = await launchFixture();
  t.after(() => app.stop());
  const file = path.join(app.root, "personal", skillFile);
  await fs.chmod(file, 0o755);
  const source = value(await read(app, { bundle: "personal", file: skillFile }));
  assert.equal(source.content, '#!/bin/sh\nprintf "Synthetic only\\n"\n');
  assert.equal(source.ref, undefined, "a support file is no asset");
  const saved = value(
    await save(app, {
      bundle: "personal",
      file: skillFile,
      revision: source.revision,
      content: `${source.content}# edited\n`,
    }),
  );
  assert.equal(saved.unchanged, false);
  assert.match(await fs.readFile(file, "utf8"), /# edited/);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o755);
  assert.deepEqual(
    (await fs.readdir(path.dirname(file))).filter((name) => name.endsWith(".tmp")),
    [],
    "the atomic write leaves no temporary file",
  );
  // The same text is a no-op.
  const again = value(await read(app, { bundle: "personal", file: skillFile }));
  assert.equal(
    value(await save(app, { bundle: "personal", file: skillFile, revision: again.revision, content: again.content }))
      .unchanged,
    true,
  );
});

test("a file that is no asset, outside every asset directory, is editable too", async (t) => {
  const app = await launchFixture({
    configureFixture: async (fixture) => {
      await fs.mkdir(path.join(fixture.root, "personal/notes"));
      await fs.writeFile(path.join(fixture.root, "personal/notes/todo.txt"), "one\n");
    },
  });
  t.after(() => app.stop());
  const source = value(await read(app, { bundle: "personal", file: "notes/todo.txt" }));
  value(
    await save(app, {
      bundle: "personal",
      file: "notes/todo.txt",
      revision: source.revision,
      content: "one\ntwo\n",
      unrelated: "ignored",
    }),
  );
  assert.equal(await fs.readFile(path.join(app.root, "personal/notes/todo.txt"), "utf8"), "one\ntwo\n");
});

test("a save over bytes that changed since they were read is refused and writes nothing", async (t) => {
  const app = await launchFixture();
  t.after(() => app.stop());
  const file = path.join(app.root, "personal", skillFile);
  const source = value(await read(app, { bundle: "personal", file: skillFile }));
  await fs.appendFile(file, "# someone else\n");
  const stale = await save(app, {
    bundle: "personal",
    file: skillFile,
    revision: source.revision,
    content: "overwrite\n",
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, "ASSET_CONTENT_CHANGED");
  assert.match(await fs.readFile(file, "utf8"), /someone else/);
  assert.doesNotMatch(await fs.readFile(file, "utf8"), /overwrite/);
});

test("a link or path that leaves the bundle is refused; protected files have their own view", async (t) => {
  const app = await launchFixture({
    configureFixture: async (fixture) => {
      await fs.writeFile(path.join(fixture.root, "outside.md"), "outside\n");
      await fs.symlink(path.join(fixture.root, "outside.md"), path.join(fixture.root, "personal/knowledge/escape.md"));
      await fs.mkdir(path.join(fixture.root, "personal/env"));
      await fs.writeFile(path.join(fixture.root, "personal/env/prod.env"), "TOKEN=synthetic\n");
      await fs.symlink(
        path.join(fixture.root, "personal/env/prod.env"),
        path.join(fixture.root, "personal/knowledge/prod.md"),
      );
    },
  });
  t.after(() => app.stop());
  for (const file of [
    "knowledge/escape.md",
    "../shared/knowledge/shared-backup.md",
    path.join(app.root, "outside.md"),
    "env/prod.env",
    "knowledge/../env/prod.env",
    "knowledge/prod.md",
  ]) {
    assert.equal((await read(app, { bundle: "personal", file })).status, 400, file);
    assert.equal(
      (await save(app, { bundle: "personal", file, revision: "x", content: "planted\n" })).status,
      400,
      file,
    );
  }
  assert.equal(await fs.readFile(path.join(app.root, "outside.md"), "utf8"), "outside\n");
  assert.equal(await fs.readFile(path.join(app.root, "personal/env/prod.env"), "utf8"), "TOKEN=synthetic\n");
  assert.equal((await read(app, { bundle: "missing", file: "knowledge/x.md" })).status, 400);
  assert.equal((await read(app, {})).status, 400);
});

test("after an asset save the index finds the new text", async (t) => {
  const app = await launchFixture();
  t.after(() => app.stop());
  const ref = "personal//commands/check-recovery",
    marker = "zirconmarker";
  const search = async () => value(await app.call(`/api/search?q=${marker}&belief=all`)).hits.map((hit) => hit.ref);
  assert.deepEqual(await search(), []);
  const source = value(await read(app, { ref }));
  assert.equal(source.ref, ref);
  assert.equal(
    value(await save(app, { ref, revision: source.revision, content: `${source.content}\nThe ${marker} step.\n` }))
      .indexed,
    true,
  );
  assert.ok(
    (await search()).some((found) => found.endsWith("commands/check-recovery")),
    "the saved text is searchable at once",
  );
});

test("knowledge is saved like any other file", async (t) => {
  const app = await launchFixture();
  t.after(() => app.stop());
  const source = value(await read(app, { ref: app.refs.document }));
  assert.equal(source.writable, true);
  assert.equal(
    value(
      await save(app, { ref: app.refs.document, revision: source.revision, content: `${source.content}\nChecked.\n` }),
    ).indexed,
    true,
  );
  assert.match(await fs.readFile(app.documentPath, "utf8"), /Checked\./);
});

test("a bundle akm does not write to is readable, and a save into it is refused", async (t) => {
  const app = await launchFixture();
  t.after(() => app.stop());
  const before = await fs.readFile(app.vendorPath, "utf8");
  const source = value(await read(app, { ref: app.refs.vendor }));
  assert.equal(source.writable, false);
  const refused = await save(app, { ref: app.refs.vendor, revision: source.revision, content: "planted\n" });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /read-only/);
  assert.equal(await fs.readFile(app.vendorPath, "utf8"), before);
});

test("a filesystem failure is a 500 that names its cause", {
  skip: process.getuid?.() === 0 && "root reads any file",
}, async (t) => {
  const app = await launchFixture();
  const file = path.join(app.root, "personal", skillFile);
  // Hooks run in the order registered: restore the mode before the fixture is removed.
  t.after(() => fs.chmod(file, 0o644));
  t.after(() => app.stop());
  await fs.chmod(file, 0o000);
  const failed = await read(app, { bundle: "personal", file: skillFile });
  assert.equal(failed.status, 500);
  assert.equal(failed.body.code, "INTERNAL_ERROR");
  assert.match(failed.body.error, /EACCES/);
});

test("every status comes from one mapping, and the moved routes answer only under /api/desktop", async (t) => {
  const app = await launchFixture();
  t.after(() => app.stop());
  assert.equal((await read(app, {})).status, 400, "usage");
  assert.equal((await app.call("/api/proposals/nonexistent/accept", {})).status, 404, "not found");
  const source = value(await read(app, { bundle: "personal", file: skillFile }));
  await fs.appendFile(path.join(app.root, "personal", skillFile), "#\n");
  assert.equal(
    (await save(app, { bundle: "personal", file: skillFile, revision: source.revision, content: "x" })).status,
    409,
    "conflict",
  );
  const selector = { bundle: "personal", file: "env/example.env" };
  for (const old of [
    "/api/asset/reveal",
    "/api/asset/sensitive/create",
    "/api/asset/sensitive/save",
    "/api/asset/sensitive/delete",
  ])
    assert.equal((await app.call(old, selector)).status, 404, old);
  assert.equal((await app.call(`/api/asset/sensitive?${new URLSearchParams(selector)}`)).status, 404);
  assert.equal(
    (await app.call("/api/desktop/sensitive/reveal", selector)).status,
    404,
    "the new route exists and reports the missing file",
  );
});
