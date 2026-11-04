import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { launchFixture } from './support.mjs';

const index = fixture => execFileSync(process.execPath, [fixture.launcher, 'index', '--full', '--format=json', '-q'], { env: fixture.env, stdio: 'pipe' });
const move = (ref, name, bundle = 'personal') => ({ ref, name, bundle, fixLinks: true });
const value = result => { assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body.data; };

test('stored cosine is exact, scoped, model-compatible and read-only', async t => {
  const app = await launchFixture({ configureFixture: async fixture => {
    const db = new DatabaseSync(path.join(fixture.env.AKM_DATA_DIR, 'index.db'));
    db.prepare("INSERT OR REPLACE INTO index_meta(key,value) VALUES('embeddingFingerprint','fixture')").run();
    const put = (ref, vector, model = 'fixture') => {
      const row = db.prepare('SELECT id FROM entries WHERE item_ref=?').get(ref);
      assert.ok(row, ref);
      db.prepare('INSERT OR REPLACE INTO embeddings(id,embedding,model) VALUES(?,?,?)').run(row.id, Buffer.from(new Float32Array(vector).buffer), model);
    };
    put(fixture.refs.document, [1, 0]); put(fixture.refs.shared, [.9, .1]); put(fixture.refs.memory, [0, 1]);
    put(fixture.refs.vendor, [1, 0], 'another-model');
    db.close();
  } });
  t.after(() => app.stop());
  const result = value(await app.call('/api/asset/related?ref=' + encodeURIComponent(app.refs.document)));
  assert.equal(result.available, true); assert.equal(result.matches[0].ref, app.refs.shared);
  assert.ok(Math.abs(result.matches[0].cosine - .9938837347) < .000001);
  assert.ok(!result.matches.some(match => match.ref === app.refs.document || match.ref === app.refs.vendor));
  const scoped = value(await app.call('/api/asset/related?scope=bundle&ref=' + encodeURIComponent(app.refs.document)));
  assert.deepEqual(scoped.matches.map(match => match.ref), [app.refs.memory]);
  const old = value(await app.call('/api/asset/related?ref=' + encodeURIComponent(app.refs.vendor)));
  assert.equal(old.available, false); assert.match(old.note, /older model/);
  const missing = value(await app.call('/api/asset/related?ref=' + encodeURIComponent(app.refs.skill)));
  assert.equal(missing.available, false); assert.match(missing.note, /No stored embedding/);
  const unauthorized = await fetch(app.origin + '/api/asset/related?ref=' + app.refs.document);
  assert.notEqual(unauthorized.status, 200);
});

test('move previews, repairs qualified and relative links, preserves backups and refreshes the index', async t => {
  const app = await launchFixture({ configureFixture: async fixture => {
    await fs.appendFile(path.join(fixture.root, 'personal/memories/backup-preference.md'), '\n[Restore](../knowledge/restore-laptop.md)\n[[personal//knowledge/restore-laptop]]\n');
    await fs.appendFile(fixture.vendorPath, '\n[[personal//knowledge/restore-laptop]]\n'); index(fixture);
    await fs.appendFile(path.join(fixture.root, 'personal/memories/backup-preference.md'), '\n~~~text\npersonal//knowledge/restore-laptop\n~~~\nInline `personal//knowledge/restore-laptop` stays unchanged.\n');
  } });
  t.after(() => app.stop());
  const original = await fs.readFile(app.documentPath, 'utf8');
  const options = move(app.refs.document, 'recovery/restore');
  const preview = value(await app.call('/api/asset/move/preview', options));
  assert.equal(await fs.readFile(app.documentPath, 'utf8'), original);
  assert.equal(preview.changes.length, 2); assert.ok(preview.warnings.some(warning => warning.includes('vendor')));
  const result = value(await app.call('/api/asset/move', { ...options, revision: preview.revision }));
  assert.equal(result.complete, true, JSON.stringify(result));
  assert.equal(await fs.readFile(path.join(app.root, 'personal/knowledge/recovery/restore.md'), 'utf8'), original);
  assert.match(await fs.readFile(path.join(app.root, 'personal/memories/backup-preference.md'), 'utf8'), /\.\.\/knowledge\/recovery\/restore\.md/);
  assert.ok((await fs.readFile(path.join(app.root, 'personal/memories/backup-preference.md'), 'utf8')).includes('~~~text\npersonal//knowledge/restore-laptop\n~~~'));
  assert.ok((await fs.readFile(path.join(app.root, 'personal/memories/backup-preference.md'), 'utf8')).includes('`personal//knowledge/restore-laptop`'));
  assert.ok((await fs.readFile(path.join(result.recoveries[0], '0.md'), 'utf8')).includes('Restore a laptop'));
  assert.equal((await app.call('/api/asset?ref=' + encodeURIComponent(result.ref))).status, 200);
  const listing = value(await app.call('/api/search?q=personal%2F%2Fknowledge%2F&belief=all'));
  assert.ok(!listing.hits.some(hit => hit.ref === app.refs.document));
});

test('cross-bundle moves repair portable refs and reject stale previews, collisions, escapes and read-only sources', async t => {
  const app = await launchFixture(); t.after(() => app.stop());
  for (const options of [move(app.refs.document, '../escape'), move(app.refs.document, 'shared-backup', 'shared'), move(app.refs.vendor, 'copy'), move(app.refs.document, 'copy', 'vendor')])
    assert.notEqual((await app.call('/api/asset/move/preview', options)).status, 200);
  await fs.symlink(path.join(app.root, 'shared/knowledge'), path.join(app.root, 'personal/knowledge/linked'));
  assert.notEqual((await app.call('/api/asset/move/preview', move(app.refs.document, 'linked/escape'))).status, 200);
  const options = move(app.refs.document, 'moved', 'shared'), preview = value(await app.call('/api/asset/move/preview', options));
  await fs.appendFile(app.documentPath, '\nNew work.\n');
  assert.equal((await app.call('/api/asset/move', { ...options, revision: preview.revision })).status, 409);
  const fresh = value(await app.call('/api/asset/move/preview', options));
  const result = value(await app.call('/api/asset/move', { ...options, revision: fresh.revision }));
  assert.equal(result.ref, 'shared//knowledge/moved');
  assert.match(await fs.readFile(path.join(app.root, 'shared/knowledge/moved.md'), 'utf8'), /New work/);
  await assert.rejects(fs.stat(app.documentPath), { code: 'ENOENT' });
});

test('manual retirement is an accepted retire proposal; revert restores exact bytes and removes the archive', async t => {
  const app = await launchFixture(); t.after(() => app.stop());
  const source = value(await app.call('/api/asset/source?ref=' + encodeURIComponent(app.refs.document)));
  const receipt = value(await app.call('/api/asset/retire', { ref: app.refs.document, revision: source.revision }));
  const [archive] = receipt.archiveDirs.map(dir => path.join(app.root, 'personal', dir));
  assert.equal(await fs.readFile(path.join(archive, 'knowledge/restore-laptop.md'), 'utf8'), source.content);
  await assert.rejects(fs.stat(app.documentPath), { code: 'ENOENT' });
  const row = value(await app.call('/api/proposals/' + receipt.proposalId));
  assert.equal(row.proposal.status, 'accepted'); assert.equal(row.proposal.isRetire, true);
  const db = new DatabaseSync(path.join(app.env.AKM_DATA_DIR, 'index.db'));
  assert.equal(db.prepare('SELECT count(*) AS n FROM entries WHERE item_ref=?').get(app.refs.document).n, 0); db.close();
  const reverted = value(await app.call('/api/proposals/' + receipt.proposalId + '/revert', {}));
  assert.equal(reverted.proposal.status, 'reverted');
  assert.equal(await fs.readFile(app.documentPath, 'utf8'), source.content);
  await assert.rejects(fs.stat(archive), { code: 'ENOENT' });
  assert.equal((await app.call('/api/asset?ref=' + encodeURIComponent(app.refs.document))).status, 200);
  value(await app.call('/api/proposals/' + receipt.proposalId + '/revert', {}));
  assert.equal(await fs.readFile(app.documentPath, 'utf8'), source.content, 'a second revert changes nothing');
});

test('memory moves carry the derived twin and its parent ref even with optional link repair off', async t => {
  const app = await launchFixture({ configureFixture: async fixture => {
    await fs.writeFile(path.join(fixture.root, 'personal/memories/backup-preference.derived.md'), '---\nderivedFrom: personal//memories/backup-preference\ndescription: Synthetic twin\n---\nDerived content.\n'); index(fixture);
  } }); t.after(() => app.stop());
  const options = { ...move(app.refs.memory, 'moved', 'shared'), fixLinks: false };
  const preview = value(await app.call('/api/asset/move/preview', options));
  assert.equal(preview.changes.length, 2);
  const result = value(await app.call('/api/asset/move', { ...options, revision: preview.revision }));
  assert.equal(result.complete, true);
  assert.match(await fs.readFile(path.join(app.root, 'shared/memories/moved.derived.md'), 'utf8'), /derivedFrom: shared\/\/memories\/moved/);
  await assert.rejects(fs.stat(path.join(app.root, 'personal/memories/backup-preference.derived.md')), { code: 'ENOENT' });
});

test('retirement rejects stale source, read-only assets, unsupported packages and duplicate requests', async t => {
  const app = await launchFixture(); t.after(() => app.stop());
  for (const ref of [app.refs.vendor, app.refs.skill]) assert.notEqual((await app.call('/api/asset/retire', { ref, revision: 'invalid', reason: 'Obsolete' })).status, 200);
  const source = value(await app.call('/api/asset/source?ref=' + encodeURIComponent(app.refs.document)));
  assert.notEqual((await app.call('/api/asset/retire', { ref: app.refs.document, revision: 'stale', reason: 'Obsolete' })).status, 200);
  const request = { ref: app.refs.document, revision: source.revision, reason: 'Obsolete' };
  value(await app.call('/api/asset/retire', request));
  assert.notEqual((await app.call('/api/asset/retire', request)).status, 200);
  await assert.rejects(fs.stat(app.documentPath), { code: 'ENOENT' });
});

test('commands, workflows, scripts and tasks retain their native file formats when edited, moved and retired', async t => {
  const app = await launchFixture({ configureFixture: async fixture => {
    for (const dir of ['workflows', 'tasks', 'scripts']) await fs.mkdir(path.join(fixture.root, 'personal', dir));
    await fs.writeFile(path.join(fixture.root, 'personal/workflows/check.md'), '---\ntype: workflow\ndescription: Synthetic check\nsteps:\n  - id: review\n---\n# Check\n\n## review\n\nReview only.\n');
    await fs.writeFile(path.join(fixture.root, 'personal/tasks/check.yml'), 'version: 4\nname: check\ndescription: Synthetic task\nrun: echo check\n');
    await fs.writeFile(path.join(fixture.root, 'personal/scripts/check.sh'), '#!/bin/sh\n# description: Synthetic check\necho check\n', { mode: 0o755 });
    index(fixture);
  } }); t.after(() => app.stop());
  for (const [old, name, file] of [['commands/check-recovery', 'renamed-command', 'commands/renamed-command.md'], ['workflows/check', 'renamed-workflow', 'workflows/renamed-workflow.md'], ['tasks/check', 'renamed-task', 'tasks/renamed-task.yml'], ['scripts/check.sh', 'renamed-script.sh', 'scripts/renamed-script.sh']]) {
    const ref = 'personal//' + old, source = value(await app.call('/api/asset/source?ref=' + encodeURIComponent(ref)));
    value(await app.call('/api/asset/save', { ref, revision: source.revision, content: source.content + '\n' }));
    const options = move(ref, name, 'shared'), preview = value(await app.call('/api/asset/move/preview', options));
    const result = value(await app.call('/api/asset/move', { ...options, revision: preview.revision }));
    assert.equal(result.complete, true, JSON.stringify(result));
    assert.equal(await fs.readFile(path.join(app.root, 'shared', file), 'utf8'), source.content + '\n');
    if (file.endsWith('.sh')) assert.equal((await fs.stat(path.join(app.root, 'shared', file))).mode & 0o777, 0o755);
    const moved = value(await app.call('/api/asset/source?ref=' + encodeURIComponent(result.ref)));
    const receipt = value(await app.call('/api/asset/retire', { ref: result.ref, revision: moved.revision }));
    await assert.rejects(fs.stat(path.join(app.root, 'shared', file)), { code: 'ENOENT' });
    value(await app.call('/api/proposals/' + receipt.proposalId + '/revert', {}));
    assert.equal(await fs.readFile(path.join(app.root, 'shared', file), 'utf8'), source.content + '\n');
    if (file.endsWith('.sh')) assert.equal((await fs.stat(path.join(app.root, 'shared', file))).mode & 0o777, 0o755);
  }
});

test('skill moves preserve the entire directory including binary files, internal links and executable modes', async t => {
  const app = await launchFixture({ configureFixture: async fixture => {
    const root = path.join(fixture.root, 'personal/skills/backup-check');
    await fs.writeFile(path.join(root, 'references/diagram.bin'), Buffer.from([0, 255, 4, 10]));
    await fs.chmod(path.join(root, 'scripts/check.sh'), 0o755);
    await fs.mkdir(path.join(root, 'empty'));
  } }); t.after(() => app.stop());
  const options = move(app.refs.skill, 'backup-check', 'shared');
  const preview = value(await app.call('/api/asset/move/preview', options));
  assert.equal(preview.changes.length, 4);
  assert.ok(preview.changes.some(change => change.binary && change.before.startsWith('[Binary')));
  const result = value(await app.call('/api/asset/move', { ...options, revision: preview.revision }));
  assert.equal(result.complete, true, JSON.stringify(result));
  const root = path.join(app.root, 'shared/skills/backup-check');
  assert.deepEqual(await fs.readFile(path.join(root, 'references/diagram.bin')), Buffer.from([0, 255, 4, 10]));
  assert.equal((await fs.stat(path.join(root, 'scripts/check.sh'))).mode & 0o777, 0o755);
  assert.equal((await fs.stat(path.join(root, 'empty'))).isDirectory(), true);
  assert.match(await fs.readFile(path.join(root, 'SKILL.md'), 'utf8'), /\(references\/checklist.md\)/);
  await assert.rejects(fs.stat(path.join(app.root, 'personal/skills/backup-check')), { code: 'ENOENT' });
  assert.equal((await app.call('/api/asset?ref=' + encodeURIComponent(result.ref))).status, 200);
});

test('skill file editing uses revision guards and refuses escapes, symlinks, binary and private files', async t => {
  const app = await launchFixture(); t.after(() => app.stop());
  const file = 'skills/backup-check/scripts/check.sh', params = new URLSearchParams({ bundle: 'personal', file });
  const source = value(await app.call('/api/asset/source?' + params));
  assert.equal(source.markdown, false);
  value(await app.call('/api/asset/save', { bundle: 'personal', file, revision: source.revision, content: source.content + '# Edited\n' }));
  assert.equal((await app.call('/api/asset/save', { bundle: 'personal', file, revision: source.revision, content: 'stale' })).status, 409);
  assert.match(await fs.readFile(path.join(app.root, 'personal', file), 'utf8'), /# Edited/);
  await fs.symlink(app.documentPath, path.join(app.root, 'personal/skills/backup-check/references/link.md'));
  for (const file of ['../shared/knowledge/shared-backup.md', 'knowledge/restore-laptop.md', 'skills/backup-check/.env', 'skills/backup-check/references/link.md']) {
    assert.notEqual((await app.call('/api/asset/source?' + new URLSearchParams({ bundle: 'personal', file }))).status, 200);
  }
});
