// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import AxeBuilder from "@axe-core/playwright";
import { chromium, expect } from "@playwright/test";
import { launchFixture, projectsAndConnections } from "./support.mjs";

// Automated floor, not a substitute for independent task/keyboard/visual review.
// Populated real AKM APIs; all sources and writes are confined to the fixture.
test("populated workspace accessibility and reflow across both themes", { timeout: 300000 }, async (t) => {
  const app = await launchFixture({
    proposals: true,
    metrics: true,
    assetCount: 30,
    git: true,
    configureFixture: projectsAndConnections,
  });
  t.after(() => app.stop());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await context.newPage();
  const output = process.env.AKM_DESKTOP_UX_OUTPUT || path.join(app.root, "usability");
  await mkdir(output, { recursive: true });
  const ref = encodeURIComponent(app.refs.document);
  const states = [
    { id: "home", route: "/", ready: ".home-attention" },
    { id: "library", route: "/library/search", ready: ".library-hit-content" },
    { id: "asset", route: `/library/search?ref=${ref}`, ready: ".markdown" },
    { id: "files", route: "/library/files?bundle=personal&path=knowledge", ready: '[role="tree"]' },
    { id: "editor", route: `/library/edit?ref=${ref}`, ready: 'textarea[name="content"]' },
    { id: "create", route: "/library/new", ready: 'textarea[name="content"]' },
    { id: "review-queue", route: "/review", ready: '[aria-label="Queue summary"]' },
    { id: "review-detail", route: `/review/${app.proposals.stale}`, ready: ".change-preview" },
    { id: "activity", route: "/activity/overview", ready: "#attention-title" },
    { id: "retrieval", route: "/activity/overview?view=retrieval", ready: "#activity-retrieval-rate svg" },
    { id: "impact", route: "/activity/improve", ready: ".impact-links" },
    { id: "bundles", route: "/settings/bundles", ready: "#configured-bundles" },
    { id: "projects", route: "/projects", ready: ".project-grid" },
    { id: "project", route: "/projects/docs", ready: "#applies" },
    { id: "project-assets", route: "/projects/notes/assets", ready: ".asset-row" },
    { id: "project-edit", route: "/projects/docs/edit", ready: ".project-form" },
    { id: "connections", route: "/settings/connections", ready: ".conn-list" },
    { id: "connection", route: "/settings/connections?name=lab", ready: ".conn-facts" },
    { id: "connection-edit", route: "/settings/connections?name=lab&edit", ready: ".connection-form" },
    { id: "config", route: "/settings/config", ready: "#library-settings" },
    { id: "setup", route: "/setup", ready: "#setup-try" },
  ];
  const observations = [],
    failures = [],
    errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(app.url);
  for (const theme of ["light", "dark"]) {
    for (const state of states) {
      await page.goto(`${app.origin}${state.route}`);
      await expect(page.locator(state.ready).first()).toBeVisible();
      await page.getByRole("combobox", { name: "Appearance" }).selectOption(theme);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      for (const width of [320, 360, 375, 390, 414, 480, 640, 768, 900, 1024, 1280, 1440]) {
        await page.setViewportSize({ width, height: 860 });
        await page.evaluate(
          () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
        );
        await page.evaluate(() => window.scrollTo(0, 0));
        const geometry = await page.evaluate(() => ({
          width: innerWidth,
          scrollWidth: document.documentElement.scrollWidth,
        }));
        const label = `${state.id}-${theme}-${width}`;
        if (geometry.scrollWidth > width + 1) failures.push({ state: label, rule: "document-overflow", ...geometry });
        // Chart text stays inside its drawing: an axis title cut at the left edge is unreadable.
        const clipped = await page.evaluate(() =>
          [...document.querySelectorAll("main svg")].flatMap((svg) => {
            const box = svg.getBoundingClientRect();
            return [...svg.querySelectorAll("text")]
              .filter((text) => {
                const r = text.getBoundingClientRect();
                return (
                  r.width > 0 &&
                  (r.left < box.left - 1 || r.right > box.right + 1 || r.top < box.top - 1 || r.bottom > box.bottom + 1)
                );
              })
              .map((text) => text.textContent);
          }),
        );
        if (clipped.length) failures.push({ state: label, rule: "chart-text-clipped", clipped });
        let violations = [];
        if (width === 390 || width === 1280) {
          const results = await new AxeBuilder({ page })
            .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
            .analyze();
          violations = results.violations.map(({ id, impact, description, nodes }) => ({
            id,
            impact,
            description,
            nodes: nodes.map(({ target, failureSummary }) => ({ target, failureSummary })),
          }));
          failures.push(
            ...violations.map((violation) => ({ state: label, rule: violation.id, nodes: violation.nodes })),
          );
        }
        if ([390, 900, 1280].includes(width))
          await page.screenshot({ path: path.join(output, `${label}.png`), animations: "disabled", fullPage: false });
        observations.push({ state: state.id, theme, width, geometry, violations });
      }
      console.info(`Usability floor: ${state.id}, ${theme}`);
    }
  }
  await writeFile(
    path.join(output, "findings.json"),
    JSON.stringify({ generatedAt: new Date().toISOString(), observations, failures, errors }, null, 2),
  );
  console.info(`Usability evidence: ${output}`);
  assert.deepEqual(errors, [], "No browser runtime errors");
  assert.deepEqual(failures, [], `Accessibility/reflow failures; see ${output}/findings.json`);
});
