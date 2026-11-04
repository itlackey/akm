import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromium, expect } from '@playwright/test';
import { launchFixture } from './support.mjs';

const secret = 'synthetic-key-not-a-credential\nhttps://user:synthetic-password@example.test/?token=synthetic-token\n<script>window.__secretExecuted=true</script>\n';
const env = 'EXAMPLE_KEY="synthetic-key-not-a-credential"\nEXAMPLE_URL=https://user:synthetic-password@example.test/\n';
const value = result => { assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body.data; };
async function fixture() {
  return launchFixture({ configureFixture: async fixture => {
    for (const folder of ['env', 'secrets']) await fs.mkdir(path.join(fixture.root, 'personal', folder));
    await fs.writeFile(path.join(fixture.root, 'personal/secrets/example-key'), secret);
    await fs.writeFile(path.join(fixture.root, 'personal/env/example.env'), env);
    await fs.writeFile(path.join(fixture.root, 'personal/env/default.env'), env);
    execFileSync(process.execPath, [fixture.launcher, 'index', '--full', '--format=json', '-q'], { env: fixture.env, stdio: 'pipe' });
  } });
}

test('env and secrets open as metadata; only explicit authenticated reveal returns literal bytes', async t => {
  const app = await fixture(); t.after(() => app.stop());
  for (const [ref, expected] of [['personal//env/example', env], ['personal//env/default', env], ['personal//secrets/example-key', secret]]) {
    const masked = value(await app.call('/api/asset?ref=' + encodeURIComponent(ref)));
    assert.equal(masked.redacted, true); assert.ok(masked.asset.name); assert.ok(masked.location);
    assert.ok(!JSON.stringify(masked).includes('synthetic-password'));
    const revealed = value(await app.call('/api/asset/reveal', { ref }));
    assert.equal(revealed.content, expected);
    assert.notEqual((await fetch(app.origin + '/api/asset/reveal', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ref }) })).status, 200);
    const response = await fetch(app.origin + '/api/asset/reveal', { method: 'POST', headers: { 'Cookie': app.cookie, 'Origin': app.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ ref }) });
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.notEqual((await fetch(app.origin + '/api/asset/reveal', { method: 'POST', headers: { 'Cookie': app.cookie, 'Origin': 'https://outside.test', 'Content-Type': 'application/json' }, body: JSON.stringify({ ref }) })).status, 200);
  }
  assert.notEqual((await app.call('/api/asset/reveal?ref=personal%2F%2Fsecrets%2Fexample-key')).status, 200, 'GET cannot reveal');
  // A newly created file must also open from Files before an index rebuild.
  await fs.writeFile(path.join(app.root, 'personal/env/unindexed.env'), env);
  const unindexed = value(await app.call('/api/asset/sensitive?bundle=personal&file=env%2Funindexed.env'));
  assert.equal(unindexed.redacted, true);
  assert.equal(unindexed.asset.name, 'unindexed.env');
  assert.equal(value(await app.call('/api/asset/reveal', { bundle: 'personal', file: 'env/unindexed.env' })).content, env);
  for (const file of ['../shared/knowledge/shared-backup.md', 'knowledge/restore-laptop.md', 'env/../../config/config.json'])
    assert.notEqual((await app.call('/api/asset/reveal', { bundle: 'personal', file })).status, 200);
  await fs.symlink(app.documentPath, path.join(app.root, 'personal/secrets/linked'));
  assert.notEqual((await app.call('/api/asset/reveal', { bundle: 'personal', file: 'secrets/linked' })).status, 200);
  await fs.writeFile(path.join(app.root, 'personal/secrets/binary'), Buffer.from([0, 255]));
  assert.notEqual((await app.call('/api/asset/reveal', { bundle: 'personal', file: 'secrets/binary' })).status, 200);
  assert.ok(!app.logs().includes('synthetic-password'));
});

test('a dotenv-adapter bundle accepts env and secret writes, as the CLI does, and writes are not indexed', async t => {
  const app = await launchFixture({ configureFixture: async fixture => {
    const file = path.join(fixture.env.AKM_CONFIG_DIR, 'config.json');
    const config = JSON.parse(await fs.readFile(file, 'utf8'));
    await fs.mkdir(path.join(fixture.root, 'dotenvs'));
    config.bundles.dotenvs = { path: path.join(fixture.root, 'dotenvs'), writable: true, components: { main: { root: '.', adapter: 'dotenv', writable: true } } };
    await fs.writeFile(file, JSON.stringify(config));
  } }); t.after(() => app.stop());
  for (const file of ['env/service.env', 'secrets/service-key']) {
    const selector = { bundle: 'dotenvs', file };
    value(await app.call('/api/asset/sensitive/create', { ...selector, content: env }));
    assert.equal(await fs.readFile(path.join(app.root, 'dotenvs', file), 'utf8'), env);
    assert.equal((await fs.stat(path.join(app.root, 'dotenvs', file))).mode & 0o777, 0o600);
    const read = value(await app.call('/api/asset/reveal', selector));
    value(await app.call('/api/asset/sensitive/save', { ...selector, content: env + '# edited\n', revision: read.revision }));
    assert.equal(await fs.readFile(path.join(app.root, 'dotenvs', file), 'utf8'), env + '# edited\n');
  }
});

test('protected file UI masks, shows, hides and clears values on navigation without HTML execution', async t => {
  const app = await fixture(); t.after(() => app.stop());
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(app.url);
  for (const [ref, name] of [['personal//env/example', 'example.env'], ['personal//secrets/example-key', 'example-key']]) {
    await page.evaluate(ref => { location.hash = '#/files?ref=' + encodeURIComponent(ref) + '&open=1'; }, ref);
    await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
    await expect(page.getByLabel('Values masked', { exact: true })).toBeVisible();
    assert.ok(!(await page.content()).includes('synthetic-password'));
    await page.getByRole('button', { name: 'Show', exact: true }).click();
    await expect(page.locator('.secret-content')).toContainText('synthetic-password');
    assert.equal(await page.evaluate(() => window.__secretExecuted), undefined);
    await page.getByRole('button', { name: 'Hide', exact: true }).click();
    await expect(page.locator('.secret-content')).toHaveCount(0);
    await page.getByRole('button', { name: 'Show', exact: true }).click();
    await expect(page.locator('.secret-content')).toBeVisible();
    await page.getByRole('navigation', { name: 'Primary navigation' }).getByRole('link', { name: 'Settings', exact: true }).click();
    await expect(page.locator('.secret-content')).toHaveCount(0);
    await page.goBack();
    await expect(page.getByLabel('Values masked', { exact: true })).toBeVisible();
  }
  await fs.writeFile(path.join(app.root, 'personal/env/new-file.env'), env);
  await page.evaluate(() => { location.hash = '#/files?' + new URLSearchParams({ bundle: 'personal', path: 'env', file: 'env/new-file.env', open: '1' }); });
  await expect(page.getByRole('heading', { name: 'new-file.env', exact: true })).toBeVisible();
  await expect(page.getByLabel('Values masked', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Show', exact: true }).click();
  await expect(page.locator('.secret-content')).toContainText('synthetic-password');
  await page.getByRole('button', { name: 'Hide', exact: true }).click();
  await fs.mkdir('/tmp/akm-desktop-asset-management', { recursive: true });
  await page.screenshot({ path: '/tmp/akm-desktop-asset-management/secret-masked.png', fullPage: true });
  assert.deepEqual(errors, []);
});
