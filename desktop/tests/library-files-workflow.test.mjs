import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';
import { launchFixture } from './support.mjs';

test('Library task views use actual filesystem listings, canonical assets, and retained navigation', { timeout: 180000 }, async t => {
  const server = await launchFixture({ proposals: true, assetCount: 30 }); t.after(() => server.stop());
  await writeFile(path.join(server.root, 'personal/knowledge/rehearsal-notes.txt'), 'Unindexed synthetic source, not an AKM asset.\n');
  await mkdir(path.join(server.root, 'personal/knowledge/not-opened'), { recursive: true });
  await writeFile(path.join(server.root, 'personal/knowledge/not-opened/note.txt'), 'Do not enumerate this directory until requested.');
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  const failures = [], listings = [];
  page.on('pageerror', error => failures.push(error.message));
  page.on('request', request => { if (request.url().includes('/api/bundles/files?')) listings.push(new URL(request.url()).searchParams); });
  const hash = async value => page.evaluate(value => { location.hash = value; }, value);
  await page.goto(server.url + '#/search');
  const screenshot = async name => {
    if (!process.env.AKM_DESKTOP_SCREENSHOTS) return;
    await mkdir(process.env.AKM_DESKTOP_SCREENSHOTS, { recursive: true });
    console.log(name, await page.evaluate(() => ({ viewport: innerHeight, scrollY, page: document.documentElement.scrollHeight, body: document.body.scrollHeight, shell: document.querySelector('.desktop-shell').getBoundingClientRect().height, main: document.querySelector('main').getBoundingClientRect().height })));
    await page.screenshot({ path: path.join(process.env.AKM_DESKTOP_SCREENSHOTS, name), fullPage: true, animations: 'disabled' });
  };

  await t.test('Search restores real page scroll and link focus after focused reading', async () => {
    const links = page.locator('.library-hit-content');
    await expect.poll(() => links.count()).toBeGreaterThan(30);
    const last = links.last();
    const reference = await last.getAttribute('href');
    await last.scrollIntoViewIfNeeded();
    const scroll = await page.evaluate(() => window.scrollY);
    assert.ok(scroll > 0, 'the real search page, not an artificial list scroller, was scrolled');
    await last.click();
    await expect(page.locator('.document-body')).toBeVisible();
    await expect(page.locator('.reading-inspector .asset-heading h2')).toBeFocused();
    await page.getByRole('link', { name: 'Search results', exact: true }).click();
    await expect(page.locator(`a.library-hit-content[href=${JSON.stringify(reference)}]`)).toBeFocused();
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(scroll);
  });

  await t.test('Search reads as a page; View in folder reveals the real file without recursive scanning', async () => {
    await expect(page.getByRole('region', { name: 'Search results', exact: true })).toBeVisible();
    assert.equal(listings.length, 0, 'ordinary search does not scan files');
    await page.getByRole('region', { name: 'Search results', exact: true }).getByRole('link').filter({ hasText: 'restore laptop' }).click();
    await expect(page.locator('.document-body')).toContainText('Verify the checksum');
    await expect(page.getByRole('tree', { name: 'Bundle files' })).toHaveCount(0);
    await expect(page.getByRole('navigation', { name: 'Library views' })).toHaveCount(0);
    await page.getByRole('link', { name: 'View in folder', exact: true }).click();
    const contents = page.getByRole('region', { name: 'Folder contents' });
    await expect(contents.getByRole('button', { name: 'restore-laptop.md', exact: true })).toBeVisible();
    await expect(contents.locator('tr.selected')).toContainText('restore-laptop.md');
    await expect(contents.locator('tr.selected')).toBeInViewport();
    const breadcrumbs = page.getByRole('navigation', { name: 'File location' });
    await expect(breadcrumbs.getByRole('button')).toHaveText(['personal', 'knowledge']);
    await expect(breadcrumbs.getByRole('button', { name: 'knowledge', exact: true })).toHaveAttribute('aria-current', 'location');
    const unindexed = contents.getByRole('row').filter({ hasText: 'rehearsal-notes.txt' });
    await expect(unindexed).toContainText('Not indexed');
    assert.ok(listings.every(params => params.get('bundle') === 'personal' && ['', 'knowledge'].includes(params.get('path') || '')), 'only the selected ancestor chain is loaded');
    assert.ok(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight + 1), 'tree live region cannot escape its scroll pane and add blank document space');
    await screenshot('files-real-desktop.png');
    await page.setViewportSize({ width: 390, height: 844 });
    const filterHeight = await page.getByRole('searchbox', { name: 'Filter this folder', exact: true }).evaluate(element => element.getBoundingClientRect().height);
    assert.ok(filterHeight >= 40 && filterHeight <= 48, `folder search must remain a one-line control, not a ${filterHeight}px flex column`);
    await screenshot('files-mobile-folder.png');
    await page.setViewportSize({ width: 1280, height: 860 });
    await unindexed.getByRole('button', { name: 'rehearsal-notes.txt', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Asset workspace' })).toContainText('not an indexed asset');
    assert.equal(new URLSearchParams(page.url().split('?').at(-1)).has('ref'), false, 'unindexed entry has no invented ref');
    await page.getByRole('link', { name: 'Back to folder', exact: true }).click();
  });

  await t.test('tree keyboard focus, expansion, and editor positions do not navigate or replace a draft', async () => {
    await page.getByRole('region', { name: 'Folder contents' }).getByRole('button', { name: 'restore-laptop.md', exact: true }).click();
    await page.getByRole('link', { name: 'Edit page', exact: true }).click();
    const editor = page.getByRole('textbox', { name: 'Markdown source, including optional frontmatter', exact: true });
    const draft = (await editor.inputValue()) + '\nRetained synthetic source.\n'.repeat(30);
    await editor.fill(draft);
    await editor.evaluate(el => { el.setSelectionRange(20, 34); el.scrollTop = 180; });
    const before = await editor.evaluate(el => ({ start: el.selectionStart, end: el.selectionEnd, scroll: el.scrollTop }));
    const originalUrl = page.url();
    const root = page.getByRole('treeitem', { name: 'shared', exact: true });
    await root.focus(); await page.keyboard.press('ArrowRight');
    await expect(root).toHaveAttribute('aria-expanded', 'true');
    assert.equal(page.url(), originalUrl, 'expanding navigation does not navigate');
    assert.equal(await editor.inputValue(), draft);
    assert.deepEqual(await editor.evaluate(el => ({ start: el.selectionStart, end: el.selectionEnd, scroll: el.scrollTop })), before);
    await page.keyboard.press('ArrowDown');
    assert.equal(page.url(), originalUrl, 'arrow focus is not selection');
    await expect(page.getByRole('dialog', { name: 'Leave this draft?' })).not.toBeVisible();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog', { name: 'Leave this draft?' })).toBeVisible();
    await page.getByRole('button', { name: 'Stay in editor', exact: true }).click();
    await expect(page).toHaveURL(originalUrl);
    assert.equal(await editor.inputValue(), draft);
    assert.deepEqual(await editor.evaluate(el => ({ start: el.selectionStart, end: el.selectionEnd, scroll: el.scrollTop })), before);
    // Native history must use the same guard, without replacing Kit's history
    // bookkeeping or bouncing the editor through a transient reader render.
    await page.goBack();
    await expect(page.getByRole('dialog', { name: 'Leave this draft?' })).toBeVisible();
    await expect(page).toHaveURL(originalUrl);
    await page.getByRole('button', { name: 'Stay in editor', exact: true }).click();
    assert.equal(await editor.inputValue(), draft);
    await page.goBack();
    await expect(page.getByRole('dialog', { name: 'Leave this draft?' })).toBeVisible();
    await page.getByRole('button', { name: 'Leave and keep draft', exact: true }).click();
    await expect(page.locator('.document-body')).toContainText('Verify the checksum');
    await expect(page).toHaveURL(/#\/files\?/);
    await page.getByRole('link', { name: 'Edit page', exact: true }).click();
    await expect(editor).toHaveValue(draft);
    await expect(page.locator('.editor-status')).toContainText('Restored unsaved draft');
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(page.locator('.document-body')).toContainText('Retained synthetic source');
    await expect(page).toHaveURL(/#\/files\?/);
    await expect(page.getByRole('navigation', { name: 'File location' })).toContainText('restore-laptop.md');
    await expect(page.getByRole('treeitem', { name: 'shared', exact: true })).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByRole('treeitem', { name: 'knowledge', exact: true })).toHaveCount(2);
    assert.match(await readFile(server.documentPath, 'utf8'), /Retained synthetic source/);
    await page.getByRole('link', { name: 'Back to reading', exact: true }).first().click();
    await expect(page.locator('.document-body')).toContainText('Retained synthetic source');
    await expect(page.getByRole('tree', { name: 'Bundle files' })).toHaveCount(0);
    await page.keyboard.press('Control+k');
    await expect(page.getByRole('searchbox', { name: 'Search library', exact: true })).toBeFocused();
    await page.getByRole('region', { name: 'Search results', exact: true }).getByRole('link').filter({ hasText: 'restore laptop' }).click();
  });

  await t.test('compare candidates persist while traversing another bundle; inline is the default', async () => {
    await page.getByRole('button', { name: 'More', exact: true }).click();
    await page.getByRole('button', { name: 'Compare with another asset', exact: true }).click();
    await expect(page.locator('.comparison-selection')).toContainText('restore laptop');
    await expect(page.getByRole('region', { name: 'Search results', exact: true })).toBeVisible();
    await expect(page.getByRole('tree', { name: 'Bundle files' })).toHaveCount(0);
    // Comparing a Search page stays in Search; moving to Files is an explicit
    // user choice and keeps the first candidate across that transition.
    await page.getByRole('navigation', { name: 'Library views' }).getByRole('link', { name: 'Files', exact: true }).click();
    await page.getByRole('treeitem', { name: 'shared', exact: true }).click();
    await page.getByRole('region', { name: 'Folder contents' }).getByRole('button', { name: 'knowledge', exact: true }).click();
    await page.getByRole('checkbox', { name: 'Compare shared-backup.md', exact: true }).check();
    await page.locator('.comparison-selection').getByRole('link', { name: 'Compare', exact: true }).click();
    await expect(page.locator('.comparison-identities')).toContainText('Shared backup');
    await expect(page.locator('.comparison-identities')).toContainText('Restore a laptop');
    const comparisonHrefs = await page.locator('.comparison-identities a').evaluateAll(links => links.map(link => new URLSearchParams(link.hash.split('?')[1]).get('ref')));
    assert.deepEqual(new Set(comparisonHrefs), new Set([server.refs.document, server.refs.shared]));
    await expect(page.locator('.comparison-selection')).toHaveCount(0);
    await expect(page.locator('.dcol.inline')).toHaveCount(1);
    await expect(page.locator('.change-preview')).toContainText('Keep the original disk');
    await page.getByRole('link', { name: 'Close comparison', exact: true }).click();
    await page.getByRole('button', { name: 'Cancel comparison', exact: true }).click();
    await expect(page).not.toHaveURL(/compare=/);
  });

  await t.test('reloaded editor returns to the exact reading/search context and refocuses the result', async () => {
    await page.keyboard.press('Control+k');
    await page.getByRole('searchbox', { name: 'Search library', exact: true }).fill('backup');
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await expect(page).toHaveURL(/q=backup/);
    const result = page.locator('.library-hit-content').filter({ hasText: 'restore laptop' });
    await result.click();
    await expect(page.locator('.document-body')).toContainText('Verify the checksum');
    const readingUrl = page.url();
    await page.getByRole('link', { name: 'Edit page', exact: true }).click();
    const editor = page.getByRole('textbox', { name: 'Markdown source, including optional frontmatter', exact: true });
    const before = await editor.inputValue();
    await editor.fill(before + '\nUnsaved reload fixture.\n');
    await page.reload();
    await expect(editor).toHaveValue(before + '\nUnsaved reload fixture.\n');
    await page.getByRole('button', { name: 'Discard draft…', exact: true }).click();
    await page.getByRole('button', { name: 'Discard draft', exact: true }).click();
    await page.getByRole('link', { name: 'Back to file', exact: true }).click();
    await expect(page.locator('.document-body')).toContainText('Verify the checksum');
    await page.getByRole('link', { name: 'Back to reading', exact: true }).click();
    await expect(page).toHaveURL(readingUrl);
    await page.getByRole('link', { name: 'Search results', exact: true }).click();
    await expect(page).toHaveURL(/q=backup/);
    await expect(result).toBeFocused();
  });

  await t.test('Review return uses its full context; narrow Files is a single workspace', async () => {
    const back = '#/proposals?status=pending&source=feedback&age=30d';
    await hash('#/asset?' + new URLSearchParams({ ref: server.refs.document, view: 'files', returnTo: back }));
    await expect(page.locator('.document-body')).toContainText('Verify the checksum');
    await expect(page.getByRole('link', { name: 'Back to review', exact: true })).toHaveAttribute('href', back);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole('tree', { name: 'Bundle files' })).toBeHidden();
    await page.getByRole('button', { name: 'Folders', exact: true }).click();
    await expect(page.getByRole('tree', { name: 'Bundle files' })).toBeVisible();
    await expect(page.locator('.files-main')).toBeHidden();
    await page.locator('.tree-scroll').evaluate(element => element.scrollTop = element.scrollHeight);
    await expect(page.getByRole('button', { name: 'Close', exact: true })).toBeInViewport();
    await expect(page.getByRole('checkbox', { name: 'Show hidden entries', exact: true })).toBeInViewport();
    await screenshot('files-real-mobile-tree.png');
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  });
  await t.test('an unavailable bundle deep link has an actionable state, not a permanent loading indicator', async () => {
    await hash('#/files?' + new URLSearchParams({ bundle: 'retired-fixture', path: 'knowledge', file: 'knowledge/missing.md', open: '1' }));
    await expect(page.locator('.files-content')).toContainText('This bundle is disabled or no longer configured.');
    await expect(page.getByRole('link', { name: 'Bundle settings', exact: true })).toHaveAttribute('href', '#/bundles');
    await expect(page.locator('.files-content')).not.toContainText('Checking file');
  });
  assert.deepEqual(failures, []);
});
