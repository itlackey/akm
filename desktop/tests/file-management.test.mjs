import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { launchFixture } from './support.mjs';

const value = result => { assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body.data; };
const synthetic = '# Synthetic only\r\nAPI_KEY=fixture-private-value\r\nURL=https://user:fixture-password@example.test/\r\n';
async function fixture() {
  return launchFixture({ proposals: true, configureFixture: async fixture => {
    // HOME does not isolate the native crontab. Use a real executable fixture,
    // so the existing core rename can never inspect or modify the host scheduler.
    const bin = path.join(fixture.root, 'bin'); await fs.mkdir(bin);
    await fs.writeFile(path.join(bin, 'crontab'), `#!${process.execPath}\nprocess.exit(process.argv.includes('-l') ? 1 : 0);\n`, { mode: 0o755 });
    fixture.env.PATH = bin + path.delimiter + fixture.env.PATH;
  } });
}

test('env and secret CRUD keeps exact bytes, permissions, stale guards, marker cleanup and redacted receipts', async t => {
  const app = await fixture(); t.after(() => app.stop());
  for (const file of ['env/team/example.env', 'secrets/team/example-key']) {
    const selector = { bundle: 'personal', file };
    const created = value(await app.call('/api/asset/sensitive/create', { ...selector, content: synthetic }));
    assert.equal(created.file, file);
    assert.ok(!JSON.stringify(created).includes('fixture-private-value'));
    const disk = path.join(app.root, 'personal', file);
    assert.equal(await fs.readFile(disk, 'utf8'), synthetic);
    assert.equal((await fs.stat(disk)).mode & 0o777, 0o600);
    assert.equal((await app.call('/api/asset/sensitive/create', { ...selector, content: 'overwrite' })).status, 400);
    const read = value(await app.call('/api/asset/reveal', selector));
    const updated = synthetic + '# Updated\r\n';
    value(await app.call('/api/asset/sensitive/save', { ...selector, content: updated, revision: read.revision }));
    assert.equal(await fs.readFile(disk, 'utf8'), updated);
    for (const action of ['save', 'delete']) assert.equal((await app.call('/api/asset/sensitive/' + action, { ...selector, revision: read.revision, ...(action === 'save' ? { content: 'stale' } : {}) })).status, 409);
    const masked = value(await app.call('/api/asset/sensitive?' + new URLSearchParams(selector)));
    assert.equal(masked.writable, true);
    assert.ok(!JSON.stringify(masked).includes('fixture-private-value'));
    const search = value(await app.call('/api/search?' + new URLSearchParams({ q: '', type: file.startsWith('env/') ? 'env' : 'secret', bundle: 'personal' })));
    // Like the CLI, env/secret writes do not touch the index; the file opens by path and appears in search after `akm index`.
    assert.ok(!JSON.stringify(search).includes('fixture-private-value'));
    const marker = file.startsWith('env/') ? disk.replace(/\.env$/, '.sensitive') : disk + '.sensitive';
    await fs.writeFile(marker, '');
    value(await app.call('/api/asset/sensitive/delete', { ...selector, revision: masked.revision }));
    await assert.rejects(fs.stat(disk), { code: 'ENOENT' }); await assert.rejects(fs.stat(marker), { code: 'ENOENT' });
  }
  for (const file of ['../outside', 'env/../../outside.env', 'knowledge/example.md'])
    assert.notEqual((await app.call('/api/asset/sensitive/create', { bundle: 'personal', file, content: synthetic })).status, 200);
  assert.notEqual((await app.call('/api/asset/sensitive/create', { bundle: 'vendor', file: 'env/readonly.env', content: synthetic })).status, 200);
  await fs.symlink(path.join(app.root, 'shared'), path.join(app.root, 'personal/env/linked'));
  assert.notEqual((await app.call('/api/asset/sensitive/create', { bundle: 'personal', file: 'env/linked/outside.env', content: synthetic })).status, 200);
  const selector = { bundle: 'personal', file: 'secrets/marker-conflict' };
  value(await app.call('/api/asset/sensitive/create', { ...selector, content: synthetic }));
  await fs.mkdir(path.join(app.root, 'personal/secrets/marker-conflict.sensitive'));
  const read = value(await app.call('/api/asset/reveal', selector));
  assert.notEqual((await app.call('/api/asset/sensitive/delete', { ...selector, revision: read.revision })).status, 200);
  assert.equal(await fs.readFile(path.join(app.root, 'personal/secrets/marker-conflict'), 'utf8'), synthetic);
  for (const headers of [{}, { Cookie: app.cookie, Origin: 'https://outside.test' }]) {
    const response = await fetch(app.origin + '/api/asset/sensitive/create', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ bundle: 'personal', file: 'secrets/refused', content: synthetic }) });
    assert.notEqual(response.status, 200);
    assert.ok(!(await response.text()).includes('fixture-private-value'));
  }
  assert.ok(!app.logs().includes('fixture-private-value'));
});

test('bundle rename previews and applies core identity migration without moving folders or rewriting content', async t => {
  const app = await fixture(); t.after(() => app.stop());
  const oldConfig = await fs.readFile(path.join(app.env.AKM_CONFIG_DIR, 'config.json'), 'utf8');
  const before = await fs.readFile(app.documentPath, 'utf8');
  const queue = value(await app.call('/api/proposals?status=pending'));
  const plan = value(await app.call('/api/bundles/rename', { bundle: 'personal', name: 'my-library', dryRun: true }));
  assert.equal(plan.applied, false); assert.ok(plan.index.entries > 0);
  assert.equal(await fs.readFile(path.join(app.env.AKM_CONFIG_DIR, 'config.json'), 'utf8'), oldConfig);
  for (const name of ['shared', 'Invalid Name', '../outside', 'personal'])
    assert.notEqual((await app.call('/api/bundles/rename', { bundle: 'personal', name })).status, 200);
  const result = value(await app.call('/api/bundles/rename', { bundle: 'personal', name: 'my-library' }));
  assert.equal(result.applied, true); assert.equal(result.taskSync.ok, true);
  const config = JSON.parse(await fs.readFile(path.join(app.env.AKM_CONFIG_DIR, 'config.json'), 'utf8'));
  assert.equal(config.defaultBundle, 'my-library'); assert.equal(config.defaultWriteTarget, 'my-library');
  assert.equal(config.bundles['my-library'].path, path.join(app.root, 'personal')); assert.equal(config.bundles.personal, undefined);
  assert.equal(await fs.readFile(app.documentPath, 'utf8'), before);
  const read = value(await app.call('/api/asset?ref=' + encodeURIComponent('my-library//knowledge/restore-laptop')));
  assert.equal(read.location.bundle, 'my-library');
  const after = value(await app.call('/api/proposals?status=pending'));
  assert.equal(after.fullCount, queue.fullCount);
  assert.deepEqual(after.proposals.map(item => item.id), queue.proposals.map(item => item.id));
});

test('human can create, edit, cancel, protect an unsaved secret, delete it, then rename a bundle', async t => {
  const app = await fixture(); t.after(() => app.stop());
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await context.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const shots = '/tmp/akm-desktop-007'; await fs.mkdir(shots, { recursive: true });
  await page.goto(app.url);
  for (const [kind, file] of [['Environment file', 'service.env'], ['Secret', 'service-key']]) {
    await page.evaluate(() => { location.hash = '#/files?bundle=personal'; });
    await page.getByRole('button', { name: 'Other file types', exact: true }).click();
    await page.getByRole('group', { name: 'Create file', exact: true }).getByRole('link', { name: kind, exact: true }).click();
    await page.getByRole('textbox', { name: 'File name', exact: true }).fill(file);
    await page.getByRole('textbox', { name: 'File contents', exact: true }).fill(synthetic.replaceAll('\r\n', '\n'));
    await page.getByRole('button', { name: 'Create file', exact: true }).click();
    await expect(page.getByRole('heading', { name: file, exact: true })).toBeVisible();
    await expect(page.getByLabel('Values masked', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    const editor = page.getByRole('textbox', { name: 'File contents', exact: true });
    await expect(editor).toHaveValue(/fixture-private-value/);
    await editor.fill('REPLACED=fixture-updated-value\n');
    assert.ok(!JSON.stringify(await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } }))).includes('fixture-updated-value'));
    await page.getByRole('navigation', { name: 'Primary navigation' }).getByRole('link', { name: 'Settings', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.getByRole('button', { name: 'Keep editing', exact: true }).click();
    await expect(editor).toHaveValue('REPLACED=fixture-updated-value\n');
    for (const width of [1280, 900, 600]) {
      await page.setViewportSize({ width, height: 860 });
      const box = await editor.boundingBox(), form = await page.locator('.sensitive-editor form').boundingBox();
      assert.ok(box.width >= form.width * 0.95, 'The source editor must use the available form width.');
      assert.ok(box.x + box.width <= width, 'The source editor must not overflow.');
      const scan = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
      assert.deepEqual(scan.violations.map(item => item.id), []);
    }
    await page.setViewportSize({ width: 1280, height: 860 });
    await page.screenshot({ path: path.join(shots, 'edit-' + file + '.png'), fullPage: true });
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(page.getByLabel('Values masked', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await editor.fill('DO_NOT_SAVE=fixture-discarded-value\n');
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('button', { name: 'Discard changes', exact: true }).click();
    await expect(page.getByLabel('Values masked', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Show', exact: true }).click();
    await expect(page.locator('.secret-content')).toContainText('fixture-updated-value');
    await page.getByRole('button', { name: 'Hide', exact: true }).click();
    const scan = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    assert.deepEqual(scan.violations.map(item => item.id), []);
    await page.getByRole('button', { name: 'Delete…', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Delete file', exact: true })).toContainText(file);
    await page.getByRole('button', { name: 'Keep file', exact: true }).click();
    await page.getByRole('button', { name: 'Delete…', exact: true }).click();
    await page.getByRole('button', { name: 'Delete file', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'File deleted', exact: true })).toBeVisible();
  }
  // Ordinary files can be managed before the next index run, too. Refreshing
  // the tree after a mutation must not destroy the reader's completion receipt.
  const unindexed = path.join(app.root, 'personal/secrets/unindexed-key');
  await fs.writeFile(unindexed, 'synthetic-unindexed-value');
  await page.evaluate(() => { location.hash = '#/files?bundle=personal&path=secrets&file=secrets%2Funindexed-key&open=1'; });
  await expect(page.getByRole('heading', { name: 'unindexed-key', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByRole('textbox', { name: 'File contents', exact: true }).fill('synthetic-updated-value');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByText('Changes saved.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Delete…', exact: true }).click();
  await page.getByRole('button', { name: 'Delete file', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'File deleted', exact: true })).toBeVisible();
  await assert.rejects(fs.stat(unindexed), { code: 'ENOENT' });
  await page.evaluate(() => { location.hash = '#/bundles?manage=personal'; });
  await page.getByRole('button', { name: 'Rename bundle…', exact: true }).click();
  await page.getByRole('textbox', { name: 'New bundle name', exact: true }).fill('my-library');
  await page.getByRole('button', { name: 'Preview rename', exact: true }).click();
  await expect(page.getByLabel('Rename preview', { exact: true })).toBeVisible();
  await page.screenshot({ path: path.join(shots, 'rename-bundle.png'), fullPage: true });
  await page.getByRole('button', { name: 'Rename bundle', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Manage my-library', exact: true })).toBeVisible();
  await page.getByRole('navigation', { name: 'Primary navigation' }).getByRole('link', { name: 'Library', exact: true }).click();
  await expect(page.getByRole('treeitem', { name: 'my-library', exact: true })).toBeVisible();
  const folderUrl = page.url();
  await expect(page.getByRole('link', { name: 'New knowledge', exact: true })).toHaveAttribute('href', /bundle=my-library/);
  await page.getByRole('button', { name: 'Other file types', exact: true }).click();
  await page.getByRole('group', { name: 'Create file', exact: true }).getByRole('link', { name: 'Secret', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'New secret', exact: true })).toBeVisible();
  const createUrl = page.url();
  await page.getByRole('textbox', { name: 'File contents', exact: true }).fill('synthetic-discard-on-back');
  await page.goBack();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Discard changes', exact: true }).click();
  await expect(page).toHaveURL(folderUrl);
  await page.goForward();
  await expect(page).toHaveURL(createUrl);
  await expect(page.getByRole('textbox', { name: 'File contents', exact: true })).toHaveValue('');
  assert.deepEqual(errors, []);
});
