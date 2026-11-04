import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { launchFixture } from './support.mjs';

// Visual judgement still needs screenshots. These checks prevent specific
// regressions: noisy control chrome, font-glyph icons, and an oversized shell.
test('desktop chrome and action groups share one readable control language', { timeout: 120000 }, async t => {
  const app = await launchFixture({ proposals: true, metrics: true, git: true });
  t.after(() => app.stop());
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 900, height: 620 } });
  await page.goto(app.url);
  await expect(page.locator('.home-attention')).toBeVisible();
  const routes = [
    ['#/home', '.home-attention'],
    ['#/search', '.library-hit-content'],
    [`#/search?ref=${encodeURIComponent(app.refs.document)}`, '.markdown'],
    [`#/edit?ref=${encodeURIComponent(app.refs.document)}`, 'textarea[name="content"]'],
    [`#/proposals/${app.proposals.fresh}`, '.change-preview'],
    ['#/config', '#library-settings']
  ];
  for (const [route, ready] of routes) {
    await page.goto(`${app.origin}/${route}`);
    await expect(page.locator(ready).first()).toBeVisible();
    const result = await page.evaluate(() => {
      const visible = e => Boolean(e.getClientRects().length) && !e.closest('[hidden]');
      const groups = [...document.querySelectorAll('.btn-row, .editor-tabs, .decision-row .btn-row')].filter(visible);
      const controls = [...document.querySelectorAll('button, a.btn')].filter(visible);
      return {
        headerHeight: document.querySelector('.desktop-topbar').getBoundingClientRect().height,
        groupedHeights: groups.map(group => [...group.querySelectorAll(':scope > button, :scope > a.btn')].filter(visible).map(e => ({ label:e.textContent.trim(), height:e.getBoundingClientRect().height }))).filter(group => group.length > 1),
        heavyBorders: controls.filter(e => Number.parseFloat(getComputedStyle(e).borderTopWidth) > 1).map(e => e.textContent.trim()),
        glyphControls: controls.filter(e => /^[\s←→↔⌄›▾▸×✕⋮]+$/.test(e.textContent) && !e.querySelector('svg')).map(e => e.textContent.trim()),
        crampedIcons: controls.filter(e => e.querySelector(':scope > svg') && e.textContent.trim() && !(Number.parseFloat(getComputedStyle(e).columnGap) >= 6)).map(e => e.textContent.trim()),
        labels: [...document.querySelectorAll('.field-label')].filter(visible).map(e => ({ transform:getComputedStyle(e).textTransform, font:getComputedStyle(e).fontFamily }))
      };
    });
    assert.ok(result.headerHeight <= 72, `${route}: desktop topbar must not consume two rows at the native minimum width`);
    assert.deepEqual(result.heavyBorders, [], `${route}: controls must not return to heavy double-width frames`);
    assert.deepEqual(result.glyphControls, [], `${route}: use the shared SVG icon vocabulary, not glyph-only controls`);
    assert.deepEqual(result.crampedIcons, [], `${route}: icons need consistent separation from action labels`);
    for (const group of result.groupedHeights) assert.ok(Math.max(...group.map(e => e.height)) - Math.min(...group.map(e => e.height)) <= 1, `${route}: action group heights differ: ${JSON.stringify(group)}`);
    for (const label of result.labels) { assert.notEqual(label.transform, 'uppercase'); assert.ok(!/mono/i.test(label.font)); }
  }
});
