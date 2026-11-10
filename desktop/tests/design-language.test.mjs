// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import AxeBuilder from "@axe-core/playwright";
import { chromium, expect } from "@playwright/test";
import { launchFixture, tabStops } from "./support.mjs";

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
  // A file that is not an asset and a protected one, for the two plain file views.
  await writeFile(path.join(fixture.root, "personal/knowledge/plain-note.txt"), "A plain note.\n");
  await mkdir(path.join(fixture.root, "personal/env"), { recursive: true });
  await writeFile(
    path.join(fixture.root, "personal/env/example.env"),
    'EXAMPLE_KEY="synthetic-key-not-a-credential"\n',
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

  // The page must not scroll while its panes do: one scroll owner at the native minimum (and below). Files is ready
  // when its rows are.
  for (const [route, ready] of [
    ["/library/files?bundle=personal&path=knowledge", ".folder-table tbody tr"],
    [`/library/edit?ref=${longRef}`, 'textarea[name="content"]'],
    [`/review/${app.proposals.fresh}`, ".change-preview"],
  ]) {
    await open(route, ready);
    const geometry = await page.evaluate(() => ({
      pageHeight: document.documentElement.scrollHeight,
      viewport: innerHeight,
    }));
    assert.ok(
      geometry.pageHeight <= geometry.viewport,
      `${route}: the workspace shell must fit a ${geometry.viewport}px window exactly, not scroll the page (${geometry.pageHeight}px)`,
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

  // A long title wraps inside the editor pane; the return link keeps one line and stays in view.
  for (const viewport of [
    { width: 900, height: 593 },
    { width: 1024, height: 600 },
  ]) {
    await page.setViewportSize(viewport);
    await open(`/library/edit?ref=${longRef}`, 'textarea[name="content"]');
    const header = await page.evaluate(() => {
      const pane = document.querySelector(".files-content");
      const link = document.querySelector(".editor-return a");
      const r = link.getBoundingClientRect();
      const style = getComputedStyle(link);
      const inner = r.height - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
      return {
        sideways: pane.scrollWidth - pane.clientWidth,
        linkRight: Math.round(r.right),
        linkLines: Math.round(inner / parseFloat(style.lineHeight)),
        viewport: innerWidth,
      };
    });
    assert.ok(
      header.sideways <= 0,
      `${viewport.width}: the editor pane must not scroll sideways (${header.sideways}px)`,
    );
    assert.ok(
      header.linkRight <= header.viewport,
      `${viewport.width}: Back to file must be on screen: ${JSON.stringify(header)}`,
    );
    assert.ok(
      header.linkLines <= 1,
      `${viewport.width}: Back to file must stay on one line: ${JSON.stringify(header)}`,
    );
  }
  await page.setViewportSize({ width: 900, height: 593 });

  // The asset menu fits the native minimum window without a scrollbar of its own.
  await open(`/library/search?ref=${encodeURIComponent(app.refs.document)}`, ".markdown");
  await page.getByRole("button", { name: "More", exact: true }).click();
  const menu = await page.locator(".action-menu").evaluate((e) => ({
    scrolls: e.scrollHeight - e.clientHeight,
    bottom: Math.round(e.getBoundingClientRect().bottom),
    viewport: innerHeight,
  }));
  assert.ok(
    menu.scrolls <= 0 && menu.bottom <= menu.viewport,
    `the asset menu must fit the window without scrolling: ${JSON.stringify(menu)}`,
  );
});

// The same window, with the keyboard only. Focus follows the order things are read in, an overlay does not stay open
// over the control that took focus from it and hands focus back when it is dismissed, changing the view does not drop
// focus on the page, and the automated accessibility rules pass where the usability suite does not run them.
test("keyboard order, focus hand-back and names at the shortest windows", { timeout: 240000 }, async (t) => {
  const app = await launchFixture({ proposals: true, metrics: true, configureFixture: longDocument });
  t.after(() => app.stop());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 900, height: 593 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(app.url);
  await expect(page.locator(".home-attention")).toBeVisible();
  const open = async (route, ready) => {
    await page.goto(`${app.origin}${route}`);
    await expect(page.locator(ready).first()).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
  };
  const longRef = encodeURIComponent(`personal//knowledge/${longName}`);
  const out = (stops, key) => stops.filter((stop) => stop[key]).map((stop) => `${stop.name}: ${stop[key]}`);

  // Review: Tab never moves up, or left on the same row, from the control before; and no focus ring is cut.
  await open(`/review/${app.proposals.fresh}`, ".dcol.inline");
  const proposal = await tabStops(page, ".review-pane");
  assert.ok(proposal.length >= 5, `the proposal pane has its controls in the tab order (${proposal.length})`);
  assert.deepEqual(out(proposal, "moved"), [], "Review, short window: focus order is reading order in the proposal");
  assert.deepEqual(out(proposal, "clipped"), [], "Review, short window: no focus ring is cut in the proposal");
  // The diff is announced once: one named region around it, whichever layout it is in.
  const diffRegions = () =>
    page.evaluate(() => {
      const named = '[role="region"], section[aria-label], section[aria-labelledby]';
      let count = 0;
      for (let node = document.querySelector(".review-scroll .dcol"); node && !node.matches(".review-scroll"); ) {
        if (node.matches(named)) count++;
        node = node.parentElement;
      }
      return count;
    });
  assert.equal(await diffRegions(), 1, "the inline diff is in one named region");
  await open(`/review/${app.proposals.stale}`, ".dcol.inline");
  await page.getByRole("button", { name: "Side by side", exact: true }).click();
  await expect(page.locator(".sbs")).toBeVisible();
  assert.equal(await diffRegions(), 1, "the side-by-side diff is in one named region");
  await open("/review", '[aria-label="Queue summary"]');
  const heading = await tabStops(page, ".review-top");
  assert.ok(heading.length >= 5, `the Review heading has its controls in the tab order (${heading.length})`);
  assert.deepEqual(out(heading, "moved"), [], "Review: focus order is reading order across the heading row");
  const queue = await tabStops(page, ".review-list");
  assert.deepEqual(out(queue, "clipped"), [], "Review: no focus ring is cut in the queue");
  // Opening a proposal with the keyboard puts focus on it: here the queue it was opened from is no longer shown.
  await page.locator(".review-item").first().focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".proposal-title h2")).toBeFocused();

  // The filter panel: a named group; Escape and Apply hand focus back to Filters; tabbing out of it closes it.
  await open("/library/search", ".library-hit-content");
  const filters = page.locator(".search-filters > summary");
  const filterPanel = page.locator(".search-filters");
  const openFilters = async () => {
    if ((await filterPanel.getAttribute("open")) !== null) await page.keyboard.press("Escape");
    await filters.focus();
    await page.keyboard.press("Enter");
  };
  await openFilters();
  await expect(page.getByRole("group", { name: "Filters", exact: true })).toBeVisible();
  const unlabelled = await page.evaluate(
    () =>
      [...document.querySelectorAll(".filter-panel :is(select, input)")].filter(
        (field) => !field.labels?.length || ![...field.labels].some((label) => label.textContent.trim()),
      ).length,
  );
  assert.equal(unlabelled, 0, "every filter field has a visible label");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Escape");
  await expect(filters).toBeFocused();
  await expect(filterPanel).not.toHaveAttribute("open", "");
  await openFilters();
  await page.getByRole("button", { name: "Cancel", exact: true }).focus();
  await page.keyboard.press("Tab");
  await expect(filterPanel, "tabbing out of the filter panel closes it").not.toHaveAttribute("open", "");
  await openFilters();
  await page.locator(".library-filters select").first().selectOption("personal");
  await page.getByRole("button", { name: "Apply filters", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(filters, "Apply filters hands focus back to Filters").toBeFocused();
  await expect(filters).toContainText("(1)");
  await openFilters();
  await page.getByRole("link", { name: "Clear filters", exact: true }).focus();
  await page.keyboard.press("Enter");
  await page.waitForURL((url) => !url.search);
  await expect(filters).not.toContainText("(1)");
  await expect(filters, "Clear filters hands focus back to Filters").toBeFocused();

  // The asset menu: Escape hands focus back to More; tabbing out of it closes it.
  await open(`/library/search?ref=${encodeURIComponent(app.refs.document)}`, ".markdown");
  const more = page.getByRole("button", { name: "More", exact: true });
  const menu = page.locator("#asset-actions");
  await more.focus();
  await page.keyboard.press("Enter");
  await expect(menu).toBeVisible();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(more).toBeFocused();
  await page.keyboard.press("Enter");
  // Retire, the last button, is enabled by a request of its own. Enabled between the focus and the Tab, it would be the
  // next stop and the menu would stay open, so the menu is settled before its last button is chosen.
  const lastAction = menu.locator("button").last();
  await expect(lastAction).toBeEnabled();
  await lastAction.focus();
  await page.keyboard.press("Tab");
  await expect(menu, "tabbing out of the asset menu closes it").toBeHidden();

  // A view change keeps focus on the tab that made it; a section link shows the section it moves focus to.
  await open("/activity/overview", "#attention-title");
  const tabs = await tabStops(page, ".activity-tabs");
  assert.deepEqual(out(tabs, "clipped"), [], "Activity: no focus ring is cut on the view tabs");
  const runs = page.locator(".activity-tabs a", { hasText: "Runs" });
  await runs.focus();
  await page.keyboard.press("Enter");
  await expect(runs).toHaveAttribute("aria-current", "page");
  await expect(runs, "a view tab keeps focus when it is followed").toBeFocused();
  // Refresh is disabled while it loads, which drops focus: it has focus again when the page is back.
  for (const [route, ready, name, request] of [
    ["/activity/overview", "#attention-title", "Refresh activity", "/api/overview"],
    ["/settings/bundles", "#configured-bundles", "Refresh settings", "/api/config"],
  ]) {
    await open(route, ready);
    const refresh = page.getByRole("button", { name, exact: true });
    await refresh.focus();
    const reloaded = page.waitForResponse((response) => new URL(response.url()).pathname === request);
    await page.keyboard.press("Enter");
    await reloaded;
    await expect(refresh).toBeEnabled();
    await expect(refresh, `${name} has focus again once the page is back`).toBeFocused();
  }
  await open("/activity/improve", ".impact-links");
  await page.locator(".impact-links a", { hasText: "Review flow" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#flow")).toBeFocused();
  await expect(page.locator("#flow"), "the section a link moves focus to is on screen").toBeInViewport();

  // Every page has one h1, here where the section's own heading is not shown: a document, a file or the editor open in
  // Files, the reader, and a proposal in this short window.
  const files = "/library/files?bundle=personal&path=";
  const opened = encodeURIComponent(app.refs.document);
  for (const [state, route, ready] of [
    ["reader", `/library/search?ref=${opened}`, ".markdown"],
    ["document in Files", `${files}knowledge&file=knowledge%2Frestore-laptop.md&ref=${opened}&open=1`, ".markdown"],
    ["plain file in Files", `${files}knowledge&file=knowledge%2Fplain-note.txt&open=1`, "pre.code"],
    ["protected file in Files", `${files}env&file=env%2Fexample.env&open=1`, ".sensitive-reader header"],
    ["new protected file", "/library/new-sensitive?kind=env&bundle=personal", ".sensitive-editor form"],
    ["editor", `/library/edit?ref=${longRef}`, 'textarea[name="content"]'],
    ["folder in Files", `${files}knowledge`, ".folder-table tbody tr"],
    ["proposal", `/review/${app.proposals.fresh}`, ".change-preview"],
  ]) {
    await open(route, ready);
    const headings = await page.evaluate(() =>
      [...document.querySelectorAll("main h1")]
        .filter((h1) => h1.getClientRects().length)
        .map((h1) => h1.textContent.trim()),
    );
    assert.equal(headings.length, 1, `${state}: one h1 on the page, found ${JSON.stringify(headings)}`);
  }
  // In Files: the folder filter has a label that is shown, and the icon-only button says what it is on hover too.
  await open(`${files}knowledge`, ".folder-table tbody tr");
  const filterLabelled = await page
    .locator('.folder-tools input[type="search"]')
    .evaluate((input) => [...input.labels].some((label) => label.getClientRects().length && label.textContent.trim()));
  assert.ok(filterLabelled, "Filter this folder has a visible label");
  await expect(page.getByRole("searchbox", { name: "Filter this folder", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Other file types", exact: true })).toHaveAttribute(
    "title",
    "Other file types",
  );

  await open("/settings/bundles", "#configured-bundles");
  const card = await tabStops(page, "form.settings-card");
  assert.ok(card.length >= 4, `the add-bundle form has its controls in the tab order (${card.length})`);
  assert.deepEqual(out(card, "clipped"), [], "Settings: no focus ring is cut in the add-bundle form");

  // axe at the native minimum, on the pages this window changed and with each overlay open. Software is left to
  // software-ui.test.mjs: the page runs the host's own tools, which can outlive this test and write into its fixture.
  const violations = [];
  const audit = async (state) => {
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
    violations.push(...results.violations.map(({ id, nodes }) => `${state}: ${id} ${nodes[0].target}`));
  };
  for (const [state, route, ready] of [
    ["files", "/library/files?bundle=personal&path=knowledge", ".folder-table tbody tr"],
    ["editor", `/library/edit?ref=${longRef}`, 'textarea[name="content"]'],
    ["review queue", "/review", '[aria-label="Queue summary"]'],
    ["review proposal", `/review/${app.proposals.fresh}`, ".change-preview"],
    ["activity runs", "/activity/overview?view=runs", ".activity-tabs"],
    ["activity improve", "/activity/improve", ".impact-links"],
    ["settings bundles", "/settings/bundles", "#configured-bundles"],
  ]) {
    await open(route, ready);
    await audit(state);
  }
  await open("/library/search", ".library-hit-content");
  await filters.click();
  await audit("filter panel open");
  await open(`/library/search?ref=${encodeURIComponent(app.refs.document)}`, ".markdown");
  await more.click();
  await audit("asset menu open");
  assert.deepEqual(violations, [], "axe at 900×593");
  assert.deepEqual(errors, [], "no browser runtime errors");
});
