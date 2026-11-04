import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { launchFixture } from "./support.mjs";

// A copy records where it came from in `sources`; everything else is the original's bytes.
const withoutProvenance = (text) => text.replace(/sources:\n(?:  - [^\n]*\n)+/, "");
const index = (fixture) =>
  execFileSync(process.execPath, [fixture.launcher, "index", "--full", "--format=json", "-q"], {
    env: fixture.env,
    stdio: "pipe",
  });
// A move is AKM's copy, then AKM's retire of the original (revertable from Review).
async function move(app, ref, newName, target = "shared") {
  const source = value(await app.call("/api/desktop/file?ref=" + encodeURIComponent(ref)));
  const copied = value(await app.call("/api/asset/copy", { sourceRef: ref, target, newName }));
  const receipt = value(await app.call("/api/asset/retire", { ref, revision: source.revision }));
  return { source, copied, receipt };
}
const value = (result) => {
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body.data;
};

test("stored cosine is exact, scoped, model-compatible and read-only", async (t) => {
  const app = await launchFixture({
    configureFixture: async (fixture) => {
      const db = new DatabaseSync(path.join(fixture.env.AKM_DATA_DIR, "index.db"));
      db.prepare("INSERT OR REPLACE INTO index_meta(key,value) VALUES('embeddingFingerprint','fixture')").run();
      const put = (ref, vector, model = "fixture") => {
        const row = db.prepare("SELECT id FROM entries WHERE item_ref=?").get(ref);
        assert.ok(row, ref);
        db.prepare("INSERT OR REPLACE INTO embeddings(id,embedding,model) VALUES(?,?,?)").run(
          row.id,
          Buffer.from(new Float32Array(vector).buffer),
          model,
        );
      };
      put(fixture.refs.document, [1, 0]);
      put(fixture.refs.shared, [0.9, 0.1]);
      put(fixture.refs.memory, [0, 1]);
      put(fixture.refs.vendor, [1, 0], "another-model");
      db.close();
    },
  });
  t.after(() => app.stop());
  const result = value(await app.call("/api/asset/related?ref=" + encodeURIComponent(app.refs.document)));
  assert.equal(result.available, true);
  assert.equal(result.matches[0].ref, app.refs.shared);
  assert.ok(Math.abs(result.matches[0].cosine - 0.9938837347) < 0.000001);
  assert.ok(!result.matches.some((match) => match.ref === app.refs.document || match.ref === app.refs.vendor));
  const scoped = value(await app.call("/api/asset/related?scope=bundle&ref=" + encodeURIComponent(app.refs.document)));
  assert.deepEqual(
    scoped.matches.map((match) => match.ref),
    [app.refs.memory],
  );
  const old = value(await app.call("/api/asset/related?ref=" + encodeURIComponent(app.refs.vendor)));
  assert.equal(old.available, false);
  assert.match(old.note, /older model/);
  const missing = value(await app.call("/api/asset/related?ref=" + encodeURIComponent(app.refs.skill)));
  assert.equal(missing.available, false);
  assert.match(missing.note, /No stored embedding/);
  const unauthorized = await fetch(app.origin + "/api/asset/related?ref=" + app.refs.document);
  assert.notEqual(unauthorized.status, 200);
});

test("a move copies to the new name, retires the original, and the retirement reverts", async (t) => {
  const app = await launchFixture();
  t.after(() => app.stop());
  const original = await fs.readFile(app.documentPath, "utf8");
  const { copied, receipt } = await move(app, app.refs.document, "recovery/restore");
  assert.equal(copied.destination.ref, "shared//knowledge/recovery/restore");
  const copy = await fs.readFile(path.join(app.root, "shared/knowledge/recovery/restore.md"), "utf8");
  assert.match(copy, /sources:\n  - personal\/\/knowledge\/restore-laptop\n/);
  assert.equal(withoutProvenance(copy), original);
  await assert.rejects(fs.stat(app.documentPath), { code: "ENOENT" });
  assert.equal((await app.call("/api/asset?ref=" + encodeURIComponent(copied.destination.ref))).status, 200);
  const listing = value(await app.call("/api/search?q=personal%2F%2Fknowledge%2F&belief=all"));
  assert.ok(!listing.hits.some((hit) => hit.ref === app.refs.document));
  // No link was rewritten, and nothing but the AKM operations touched the bundle: no Desktop backup store.
  await assert.rejects(fs.stat(path.join(app.root, "personal/.akm/desktop-moves")), { code: "ENOENT" });
  value(await app.call("/api/proposals/" + receipt.proposalId + "/revert", {}));
  assert.equal(await fs.readFile(app.documentPath, "utf8"), original);
});

test("a move never overwrites, and is refused for escapes and read-only sources", async (t) => {
  const app = await launchFixture();
  t.after(() => app.stop());
  const source = value(await app.call("/api/desktop/file?ref=" + encodeURIComponent(app.refs.document)));
  for (const body of [
    { sourceRef: app.refs.document, target: "shared", newName: "shared-backup" },
    { sourceRef: app.refs.document, target: "shared", newName: "../escape" },
    { sourceRef: app.refs.document, target: "vendor", newName: "copy" },
  ])
    assert.notEqual((await app.call("/api/asset/copy", body)).status, 200, JSON.stringify(body));
  await assert.rejects(fs.stat(path.join(app.root, "shared/escape.md")), { code: "ENOENT" });
  assert.equal(await fs.readFile(app.documentPath, "utf8"), source.content);
  // The original is retired only against the revision that was copied.
  value(await app.call("/api/asset/copy", { sourceRef: app.refs.document, target: "shared", newName: "moved" }));
  await fs.appendFile(app.documentPath, "\nNew work.\n");
  assert.equal(
    (await app.call("/api/asset/retire", { ref: app.refs.document, revision: source.revision })).status,
    409,
  );
  assert.match(await fs.readFile(app.documentPath, "utf8"), /New work/);
});

test("manual retirement is an accepted retire proposal; revert restores exact bytes and removes the archive", async (t) => {
  const app = await launchFixture();
  t.after(() => app.stop());
  const source = value(await app.call("/api/desktop/file?ref=" + encodeURIComponent(app.refs.document)));
  const receipt = value(await app.call("/api/asset/retire", { ref: app.refs.document, revision: source.revision }));
  const [archive] = receipt.archiveDirs.map((dir) => path.join(app.root, "personal", dir));
  assert.equal(await fs.readFile(path.join(archive, "knowledge/restore-laptop.md"), "utf8"), source.content);
  await assert.rejects(fs.stat(app.documentPath), { code: "ENOENT" });
  const row = value(await app.call("/api/proposals/" + receipt.proposalId));
  assert.equal(row.proposal.status, "accepted");
  assert.equal(row.proposal.isRetire, true);
  const db = new DatabaseSync(path.join(app.env.AKM_DATA_DIR, "index.db"));
  assert.equal(db.prepare("SELECT count(*) AS n FROM entries WHERE item_ref=?").get(app.refs.document).n, 0);
  db.close();
  const reverted = value(await app.call("/api/proposals/" + receipt.proposalId + "/revert", {}));
  assert.equal(reverted.proposal.status, "reverted");
  assert.equal(await fs.readFile(app.documentPath, "utf8"), source.content);
  await assert.rejects(fs.stat(archive), { code: "ENOENT" });
  assert.equal((await app.call("/api/asset?ref=" + encodeURIComponent(app.refs.document))).status, 200);
  value(await app.call("/api/proposals/" + receipt.proposalId + "/revert", {}));
  assert.equal(await fs.readFile(app.documentPath, "utf8"), source.content, "a second revert changes nothing");
});

test("retiring a memory carries its derived twin", async (t) => {
  const app = await launchFixture({
    configureFixture: async (fixture) => {
      await fs.writeFile(
        path.join(fixture.root, "personal/memories/backup-preference.derived.md"),
        "---\nderivedFrom: personal//memories/backup-preference\ndescription: Synthetic twin\n---\nDerived content.\n",
      );
      index(fixture);
    },
  });
  t.after(() => app.stop());
  const { receipt } = await move(app, app.refs.memory, "moved");
  assert.equal(receipt.archiveDirs.length, 2);
  await assert.rejects(fs.stat(path.join(app.root, "personal/memories/backup-preference.derived.md")), {
    code: "ENOENT",
  });
  value(await app.call("/api/proposals/" + receipt.proposalId + "/revert", {}));
  assert.ok((await fs.stat(path.join(app.root, "personal/memories/backup-preference.derived.md"))).isFile());
});

test("retirement rejects stale source, read-only assets, unsupported packages and duplicate requests", async (t) => {
  const app = await launchFixture();
  t.after(() => app.stop());
  for (const ref of [app.refs.vendor, app.refs.skill])
    assert.notEqual(
      (await app.call("/api/asset/retire", { ref, revision: "invalid", reason: "Obsolete" })).status,
      200,
    );
  const source = value(await app.call("/api/desktop/file?ref=" + encodeURIComponent(app.refs.document)));
  assert.notEqual(
    (await app.call("/api/asset/retire", { ref: app.refs.document, revision: "stale", reason: "Obsolete" })).status,
    200,
  );
  const request = { ref: app.refs.document, revision: source.revision, reason: "Obsolete" };
  value(await app.call("/api/asset/retire", request));
  assert.notEqual((await app.call("/api/asset/retire", request)).status, 200);
  await assert.rejects(fs.stat(app.documentPath), { code: "ENOENT" });
});

test("commands, workflows, scripts and tasks retain their native file formats when edited, moved and retired", async (t) => {
  const app = await launchFixture({
    configureFixture: async (fixture) => {
      for (const dir of ["workflows", "tasks", "scripts"]) await fs.mkdir(path.join(fixture.root, "personal", dir));
      await fs.writeFile(
        path.join(fixture.root, "personal/workflows/check.md"),
        "---\ntype: workflow\ndescription: Synthetic check\nsteps:\n  - id: review\n---\n# Check\n\n## review\n\nReview only.\n",
      );
      await fs.writeFile(
        path.join(fixture.root, "personal/tasks/check.yml"),
        "version: 4\nname: check\ndescription: Synthetic task\nrun: echo check\n",
      );
      await fs.writeFile(
        path.join(fixture.root, "personal/scripts/check.sh"),
        "#!/bin/sh\n# description: Synthetic check\necho check\n",
        { mode: 0o755 },
      );
      index(fixture);
    },
  });
  t.after(() => app.stop());
  for (const [old, from, name, file] of [
    ["commands/check-recovery", "commands/check-recovery.md", "renamed-command", "commands/renamed-command.md"],
    ["workflows/check", "workflows/check.md", "renamed-workflow", "workflows/renamed-workflow.md"],
    ["tasks/check", "tasks/check.yml", "renamed-task", "tasks/renamed-task.yml"],
    ["scripts/check.sh", "scripts/check.sh", "renamed-script.sh", "scripts/renamed-script.sh"],
  ]) {
    const ref = "personal//" + old,
      source = value(await app.call("/api/desktop/file?ref=" + encodeURIComponent(ref)));
    value(
      await app.call("/api/desktop/file/save", {
        ref,
        revision: source.revision,
        content: source.content + "\n# edited\n",
      }),
    );
    const edited = await fs.readFile(path.join(app.root, "personal", from), "utf8");
    assert.match(edited, /edited/);
    const { copied, receipt } = await move(app, ref, name);
    assert.equal(withoutProvenance(await fs.readFile(path.join(app.root, "shared", file), "utf8")), edited);
    if (file.endsWith(".sh")) assert.equal((await fs.stat(path.join(app.root, "shared", file))).mode & 0o777, 0o755);
    await assert.rejects(fs.stat(path.join(app.root, "personal", from)), { code: "ENOENT" });
    const moved = value(await app.call("/api/desktop/file?ref=" + encodeURIComponent(copied.destination.ref)));
    assert.equal(withoutProvenance(moved.content), edited);
    const copyBytes = await fs.readFile(path.join(app.root, "shared", file), "utf8");
    const retired = value(
      await app.call("/api/asset/retire", { ref: copied.destination.ref, revision: moved.revision }),
    );
    await assert.rejects(fs.stat(path.join(app.root, "shared", file)), { code: "ENOENT" });
    value(await app.call("/api/proposals/" + retired.proposalId + "/revert", {}));
    assert.equal(await fs.readFile(path.join(app.root, "shared", file), "utf8"), copyBytes);
    if (file.endsWith(".sh")) assert.equal((await fs.stat(path.join(app.root, "shared", file))).mode & 0o777, 0o755);
    value(await app.call("/api/proposals/" + receipt.proposalId + "/revert", {}));
    assert.equal(await fs.readFile(path.join(app.root, "personal", from), "utf8"), edited);
  }
});

test("a skill copies as a package and is not retired or moved; its SKILL.md saves like any asset", async (t) => {
  const app = await launchFixture();
  t.after(() => app.stop());
  const source = value(await app.call("/api/desktop/file?ref=" + encodeURIComponent(app.refs.skill)));
  value(
    await app.call("/api/desktop/file/save", {
      ref: app.refs.skill,
      revision: source.revision,
      content: source.content + "\nEdited.\n",
    }),
  );
  assert.match(await fs.readFile(path.join(app.root, "personal/skills/backup-check/SKILL.md"), "utf8"), /Edited\./);
  assert.equal(
    (await app.call("/api/desktop/file/save", { ref: app.refs.skill, revision: source.revision, content: "stale" }))
      .status,
    409,
  );
  value(await app.call("/api/asset/copy", { sourceRef: app.refs.skill, target: "shared", newName: "backup-check" }));
  assert.match(
    await fs.readFile(path.join(app.root, "shared/skills/backup-check/scripts/check.sh"), "utf8"),
    /Synthetic only/,
  );
  // A skill is not retired or moved; its support files are edited as plain files (see file-edit.test.mjs).
  assert.notEqual(
    (await app.call("/api/asset/retire", { ref: app.refs.skill, revision: source.revision })).status,
    200,
  );
});
