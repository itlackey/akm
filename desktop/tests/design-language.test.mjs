// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { chromium, expect } from "@playwright/test";
import { launchFixture } from "./support.mjs";

// Visual judgement still needs screenshots. These checks prevent specific
// regressions: noisy control chrome, font-glyph icons, and an oversized shell.
test("desktop chrome and action groups share one readable control language", { timeout: 120000 }, async (t) => {
  const app = await launchFixture({ proposals: true, metrics: true, git: true });
  t.after(() => app.stop());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 900, height: 620 } });
  await page.goto(app.url);
  await expect(page.locator(".home-attention")).toBeVisible();
  const routes = [
    ["/", ".home-attention"],
    ["/library/search", ".library-hit-content"],
    [`/library/search?ref=${encodeURIComponent(app.refs.document)}`, ".markdown"],
    [`/library/edit?ref=${encodeURIComponent(app.refs.document)}`, 'textarea[name="content"]'],
    [`/review/${app.proposals.fresh}`, ".change-preview"],
    ["/settings/config", "#library-settings"],
  ];
  for (const [route, ready] of routes) {
    await page.goto(`${app.origin}${route}`);
    await expect(page.locator(ready).first()).toBeVisible();
    const result = await page.evaluate(() => {
      const visible = (e) => Boolean(e.getClientRects().length) && !e.closest("[hidden]");
      const groups = [...document.querySelectorAll(".btn-row, .editor-tabs, .decision-row .btn-row")].filter(visible);
      const controls = [...document.querySelectorAll("button, a.btn")].filter(visible);
      return {
        headerHeight: document.querySelector(".desktop-topbar").getBoundingClientRect().height,
        groupedHeights: groups
          .map((group) =>
            [...group.querySelectorAll(":scope > button, :scope > a.btn")]
              .filter(visible)
              .map((e) => ({ label: e.textContent.trim(), height: e.getBoundingClientRect().height })),
          )
          .filter((group) => group.length > 1),
        heavyBorders: controls
          .filter((e) => Number.parseFloat(getComputedStyle(e).borderTopWidth) > 1)
          .map((e) => e.textContent.trim()),
        glyphControls: controls
          .filter((e) => /^[\s←→↔⌄›▾▸×✕⋮]+$/.test(e.textContent) && !e.querySelector("svg"))
          .map((e) => e.textContent.trim()),
        crampedIcons: controls
          .filter(
            (e) =>
              e.querySelector(":scope > svg") &&
              e.textContent.trim() &&
              !(Number.parseFloat(getComputedStyle(e).columnGap) >= 6),
          )
          .map((e) => e.textContent.trim()),
        labels: [...document.querySelectorAll(".field-label")]
          .filter(visible)
          .map((e) => ({ transform: getComputedStyle(e).textTransform, font: getComputedStyle(e).fontFamily })),
      };
    });
    assert.ok(
      result.headerHeight <= 72,
      `${route}: desktop topbar must not consume two rows at the native minimum width`,
    );
    assert.deepEqual(result.heavyBorders, [], `${route}: controls must not return to heavy double-width frames`);
    assert.deepEqual(result.glyphControls, [], `${route}: use the shared SVG icon vocabulary, not glyph-only controls`);
    assert.deepEqual(result.crampedIcons, [], `${route}: icons need consistent separation from action labels`);
    for (const group of result.groupedHeights)
      assert.ok(
        Math.max(...group.map((e) => e.height)) - Math.min(...group.map((e) => e.height)) <= 1,
        `${route}: action group heights differ: ${JSON.stringify(group)}`,
      );
    for (const label of result.labels) {
      assert.notEqual(label.transform, "uppercase");
      assert.ok(!/mono/i.test(label.font));
    }
  }
});

// A knowledge document with a long title and an unbreakable token, for the headers that must wrap it.
const longName = "a-very-long-knowledge-file-name-that-keeps-going-for-breadcrumb-and-title-truncation-checks";
async function longDocument(fixture) {
  await writeFile(
    path.join(fixture.root, `personal/knowledge/${longName}.md`),
    `---\ntitle: Long reference with a wide table, long code and an unbreakable identifier ${"Z".repeat(40)}\ndescription: Synthetic long title\n---\n# Long reference\n\nBody.\n`,
  );
  execFileSync(process.execPath, [fixture.launcher, "index", "--full", "--format=json", "-q"], {
    env: fixture.env,
    stdio: "pipe",
  });
}

// The native window's minimum is 900×620; its content area is 593px tall on Linux. Short laptop browsers are shorter
// still. These are the sizes where the workspace pages, the review pane, the filter panel and the asset menu broke.
test("workspace pages, panels and menus fit the shortest windows", { timeout: 180000 }, async (t) => {
  const app = await launchFixture({ proposals: true, configureFixture: longDocument });
  t.after(() => app.stop());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 900, height: 593 } });
  await page.goto(app.url);
  await expect(page.locator(".home-attention")).toBeVisible();
  const open = async (route, ready) => {
    await page.goto(`${app.origin}${route}`);
    await expect(page.locator(ready).first()).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
  };
  const longRef = encodeURIComponent(`personal//knowledge/${longName}`);

  // The page must not scroll while its panes do: one scroll owner at the native minimum (and below).
  for (const [route, ready] of [
    ["/library/files?bundle=personal&path=knowledge", ".folder-table"],
    [`/library/edit?ref=${longRef}`, 'textarea[name="content"]'],
    [`/review/${app.proposals.fresh}`, ".change-preview"],
  ]) {
    await open(route, ready);
    const geometry = await page.evaluate(() => ({
      pageHeight: document.documentElement.scrollHeight,
      viewport: innerHeight,
    }));
    assert.ok(
      geometry.pageHeight <= geometry.viewport + 1,
      `${route}: the workspace shell must fit a ${geometry.viewport}px window, not scroll the page (${geometry.pageHeight}px)`,
    );
  }

  // The inline diff wraps a proposal's prose inside its box instead of running sideways.
  await open(`/review/${app.proposals.fresh}`, ".dcol.inline");
  const inline = await page
    .locator(".dcol.inline")
    .evaluate((e) => ({ scrollWidth: e.scrollWidth, clientWidth: e.clientWidth }));
  assert.ok(
    inline.scrollWidth <= inline.clientWidth + 1,
    `the inline diff must wrap long lines, not scroll sideways: ${JSON.stringify(inline)}`,
  );

  // Short and wide (a laptop browser, the native minimum): the proposed change is readable without scrolling the pane.
  for (const viewport of [
    { width: 900, height: 593 },
    { width: 1280, height: 600 },
  ]) {
    await page.setViewportSize(viewport);
    await open(`/review/${app.proposals.fresh}`, ".dcol.inline");
    const visibleRows = await page.evaluate(() => {
      const pane = document.querySelector(".review-scroll").getBoundingClientRect();
      return [...document.querySelectorAll(".dcol .drow")].filter((row) => {
        const r = row.getBoundingClientRect();
        return r.top >= pane.top && r.bottom <= pane.bottom;
      }).length;
    });
    assert.ok(
      visibleRows >= 5,
      `${viewport.width}×${viewport.height}: at least five diff rows must be visible without scrolling, saw ${visibleRows}`,
    );
  }
  await page.setViewportSize({ width: 900, height: 593 });

  // The filter panel's footer is reachable without scrolling the page at the native minimum.
  await open("/library/search", ".library-hit-content");
  await page.locator("summary", { hasText: "Filters" }).click();
  const apply = await page
    .getByRole("button", { name: "Apply filters", exact: true })
    .evaluate((e) => ({ bottom: Math.round(e.getBoundingClientRect().bottom), viewport: innerHeight }));
  assert.ok(apply.bottom <= apply.viewport, `Apply filters must be inside the window: ${JSON.stringify(apply)}`);
});
