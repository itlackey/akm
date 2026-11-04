import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';
import { launchFixture } from './support.mjs';

test('page actions escape the reader scroll container and retain native dismissal and focus', { timeout: 90000 }, async t => {
  const server = await launchFixture(); t.after(() => server.stop());
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(server.url + '#/search');
  for (const [width, height] of [[900, 620], [1250, 700], [390, 700], [900, 400]]) {
    await page.setViewportSize({ width, height });
    for (const view of ['search', 'files']) {
      const route = view === 'search' ? `#/search?ref=${encodeURIComponent(server.refs.document)}` : '#/files?' + new URLSearchParams({ bundle: 'personal', path: 'knowledge', file: 'knowledge/restore-laptop.md', ref: server.refs.document, open: '1' });
      await page.goto(`${server.origin}/${route}`);
      await expect(page.locator('.document-body')).toContainText('Verify the checksum');
      const trigger = page.getByRole('button', { name: 'More', exact: true });
      const menu = page.getByRole('group', { name: 'Page actions', exact: true });
      const before = await page.locator('.inspector').evaluate(element => ({ scrollHeight: element.scrollHeight, scrollTop: element.scrollTop }));
      await trigger.click();
      await expect(menu).toBeVisible();
      const geometry = await menu.evaluate(element => {
        const rect = element.getBoundingClientRect();
        return { topLayer: element.matches(':popover-open'), top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left, width: innerWidth, height: innerHeight };
      });
      assert.equal(geometry.topLayer, true, 'menu must be in the native top layer');
      assert.ok(geometry.top >= 0 && geometry.left >= 0 && geometry.right <= width && geometry.bottom <= height, `${view} ${width}×${height}: ${JSON.stringify(geometry)}`);
      if (process.env.AKM_DESKTOP_SCREENSHOTS) {
        await mkdir(process.env.AKM_DESKTOP_SCREENSHOTS, { recursive: true });
        await page.screenshot({ path: path.join(process.env.AKM_DESKTOP_SCREENSHOTS, `page-actions-${view}-${width}x${height}.png`) });
      }
      for (const item of await menu.getByRole('button').all()) {
        await item.scrollIntoViewIfNeeded();
        assert.equal(await item.evaluate(element => { const r = element.getBoundingClientRect(); return element.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); }), true, 'every action must be reachable without ancestor clipping');
      }
      assert.deepEqual(await page.locator('.inspector').evaluate(element => ({ scrollHeight: element.scrollHeight, scrollTop: element.scrollTop })), before, 'opening and scrolling the menu must not add article scrollbars');
      await menu.getByRole('button', { name: 'Copy to bundle…', exact: true }).focus();
      await page.keyboard.press('Escape');
      await expect(menu).toBeHidden();
      await expect(trigger).toBeFocused();
      await trigger.click(); await trigger.click();
      await expect(menu).toBeHidden();
      await trigger.click();
      await page.locator('.asset-heading h2').click();
      await expect(menu).toBeHidden();
      await trigger.focus(); await page.keyboard.press('Enter'); await page.keyboard.press('Tab');
      await expect(menu.getByRole('button', { name: 'Source', exact: true })).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(menu).toBeHidden();
      await expect(page.locator('.raw-source')).toContainText('Verify the checksum');
    }
  }
  // The app retains Library's DOM between primary sections. Browser Back must
  // dismiss its top-layer popup, rather than leaving it over another section.
  await page.setViewportSize({ width: 900, height: 620 });
  await page.getByRole('navigation', { name: 'Primary navigation' }).getByRole('link', { name: 'Settings', exact: true }).click();
  await page.getByRole('navigation', { name: 'Primary navigation' }).getByRole('link', { name: 'Library', exact: true }).click();
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await expect(page.locator('#asset-actions:popover-open')).toHaveCount(1);
  await page.goBack();
  await expect(page.locator('.library-page')).toBeHidden();
  await expect(page.locator('#asset-actions:popover-open')).toHaveCount(0);
  await page.goForward();
  await expect(page.getByRole('button', { name: 'More', exact: true })).toBeVisible();
  await expect(page.locator('#asset-actions')).toHaveCount(1);
  // Normal indexed folders have no empty status column. An actual unindexed
  // file introduces the column, and its warning remains visible.
  await page.goto(`${server.origin}/#/files?bundle=shared&path=knowledge`);
  await expect(page.getByRole('region', { name: 'Folder contents' })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'Status', exact: true })).toHaveCount(0);
  await writeFile(path.join(server.root, 'shared/knowledge/unindexed.txt'), 'Synthetic unindexed text.');
  await page.reload();
  await expect(page.getByRole('columnheader', { name: 'Status', exact: true })).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: 'unindexed.txt' })).toContainText('Not indexed');
});

test('search reordering preserves the identity of an existing result link', { timeout: 60000 }, async t => {
  const server = await launchFixture();
  t.after(() => server.stop());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(server.url + '#/search');
  const results = page.getByRole('region', { name: 'Search results' });
  const originalLink = await results.getByRole('link', { name: 'restore laptop', exact: true }).elementHandle();
  assert.ok(originalLink);
  const originalRef = await originalLink.evaluate(link => new URLSearchParams(link.hash.split('?')[1]).get('ref'));
  await page.getByRole('searchbox', { name: 'Search library' }).fill('backup');
  const response = page.waitForResponse(r => new URL(r.url()).pathname === '/api/search' && new URL(r.url()).searchParams.get('q') === 'backup');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await response;
  await expect(results).toHaveAttribute('aria-busy', 'false');
  // A keyed row must keep its file identity when ranking/filtering moves it.
  // Reusing a positional DOM node can send a click to a different asset.
  assert.equal(await originalLink.evaluate(link => link.isConnected), true);
  assert.equal(await originalLink.evaluate(link => new URLSearchParams(link.hash.split('?')[1]).get('ref')), originalRef);
  await originalLink.click();
  await expect(page.locator('.markdown')).toContainText('Verify the checksum');
});

// Read the actual response from the packaged engine, not a mock of our own DTO.
test('Library renders every AKM body field already supported by akm ui', { timeout: 90000 }, async t => {
  const server = await launchFixture();
  t.after(() => server.stop());
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(server.url + '#/search');
  for (const [name, type, field, body] of [
    ['restore-laptop', 'knowledge', 'content', 'Verify the checksum before restoring a backup.'],
    ['check-recovery', 'command', 'template', 'Review the recovery evidence for $ARGUMENTS before proceeding.'],
    ['recovery-reviewer', 'agent', 'prompt', 'Explain which recovery checks are incomplete.']
  ]) {
    await t.test(`${type}: ${field}`, async () => {
      if (await page.locator('.reader-navigation').count()) await page.locator('.reader-navigation').getByRole('link', { name: /Search results/ }).click();
      await page.getByRole('searchbox', { name: 'Search library' }).fill(name);
      const search = page.waitForResponse(r => r.url().includes('/api/search?'));
      await page.getByRole('button', { name: 'Search', exact: true }).click();
      await search;
      const response = page.waitForResponse(r => r.url().includes('/api/asset?'));
      await page.getByRole('region', { name: 'Search results' }).getByRole('link').filter({ hasText: name.replaceAll('-', ' ') }).click();
      const payload = (await (await response).json()).data;
      assert.equal(payload.asset.type, type);
      assert.ok(payload.asset[field].includes(body), 'The engine returned the actual body');
      await expect(page.locator('.markdown')).toContainText(body);
      await page.getByRole('button', { name: 'More', exact: true }).click();
      await page.getByRole('button', { name: 'Source', exact: true }).click();
      await expect(page.getByRole('region', { name: 'Asset workspace' }).locator('.raw-source')).toContainText(body);
    });
  }
  await t.test('failed reads stop loading and offer an explicit retry', async () => {
    await page.evaluate(() => { location.hash = '#/asset?ref=personal%2F%2Fknowledge%2Frestore-laptop'; });
    await expect(page.locator('.document-body')).toContainText('Verify the checksum');
    await page.route('**/api/asset?*', route => route.fulfill({
      status: 503, contentType: 'application/json',
      body: JSON.stringify({ ok: false, code: 'TEMPORARY_READ_ERROR', error: 'Temporary read failure' })
    }), { times: 1 });
    await page.evaluate(() => { location.hash = '#/asset?ref=personal%2F%2Fagents%2Frecovery-reviewer'; });
    const inspector = page.getByRole('region', { name: 'Asset workspace' });
    await expect(inspector.getByRole('alert')).toContainText('Temporary read failure');
    await expect(inspector.getByText('Loading asset…')).toHaveCount(0);
    await inspector.getByRole('button', { name: 'Retry loading asset' }).click();
    await expect(inspector.locator('.markdown')).toContainText('Explain which recovery checks are incomplete.');
  });
  await t.test('comparison includes command templates and agent prompts', async () => {
    await page.locator('.reader-navigation').getByRole('link', { name: /Search results/ }).click();
    await page.getByRole('searchbox', { name: 'Search library' }).fill('');
    const search = page.waitForResponse(r => r.url().includes('/api/search?'));
    await page.getByRole('button', { name: 'Search', exact: true }).click(); await search;
    await page.getByRole('button', { name: 'Compare assets', exact: true }).click();
    await page.getByRole('checkbox', { name: 'Select check recovery for comparison', exact: true }).check();
    await page.getByRole('checkbox', { name: 'Select recovery reviewer for comparison', exact: true }).check();
    await page.getByRole('link', { name: 'Compare', exact: true }).click();
    await expect(page.locator('.change-preview')).toContainText('Review the recovery evidence for $ARGUMENTS');
    await expect(page.locator('.change-preview')).toContainText('Explain which recovery checks are incomplete.');
    await expect(page.locator('.dcol.inline')).toHaveCount(1);
  });
});
