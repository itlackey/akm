// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The interaction states the client has today (plan 11.2). None of them submits a write, so the shared
 * server is never changed. The split view, detail panel, shortcut dialog, reject chips and status bar
 * arrive with the redesign and get their baselines in the PR that adds them.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { ROUTES, shoot, visit, volatileMasks } from "./support";

const ASSET_REF = encodeURIComponent("stash//knowledge/deploy-guide");

test("health groups open", async ({ page }) => {
  await visit(page, ROUTES.overview.hash);
  for (const summary of await page.locator("details.group > summary").all()) await summary.click();
  // The section alone: the full page's height shifts by a few px while a full-page capture resizes the viewport.
  await expect(page.locator("section", { has: page.getByRole("heading", { name: "Health checks" }) })).toHaveScreenshot(
    "overview--health-open.png",
    { mask: volatileMasks(page) },
  );
});

// B-06, B-07, B-08 and B-10 are drawn only inside these disclosures, and so are the charts' table equivalents.
test("overview details open", async ({ page }) => {
  await visit(page, ROUTES.overview.hash);
  // The health groups have their own shot above.
  for (const summary of await page.locator("main details:not(.group, .group *) > summary").all()) await summary.click();
  const sections = {
    metrics: "At a glance",
    activity: "Activity",
    "model-utilization": "Model utilization",
    "retrieval-health": "Retrieval health",
    "automation-reliability": "Automation reliability",
  };
  // One element per shot: the full page's height shifts by a few px while a full-page capture resizes the viewport.
  for (const [slug, heading] of Object.entries(sections)) {
    await expect(
      page.locator("main section", { has: page.getByRole("heading", { level: 2, name: heading }) }),
    ).toHaveScreenshot(`overview--details-open-${slug}.png`, { mask: volatileMasks(page) });
  }
  await expect(page.locator("details.chart-notes")).toHaveScreenshot("overview--details-open-measurement-coverage.png");
});

test("mobile menu open", async ({ page }) => {
  test.skip((page.viewportSize()?.width ?? 0) > 600, "The menu button only exists on narrow screens.");
  await visit(page, ROUTES.overview.hash);
  await page.locator("[data-menu]").click();
  await expect(page.locator("[data-menu]")).toHaveAttribute("aria-expanded", "true");
  await shoot(page, "overview--menu-open");
});

test("proposals selection bar", async ({ page }) => {
  await visit(page, ROUTES["proposals-pending"].hash);
  await page.locator("[data-select]").first().check();
  await expect(page.locator("[data-batch-bar]")).toBeVisible();
  await shoot(page, "proposals-pending--selection-bar");
});

for (const action of ["accept", "reject"] as const) {
  test(`proposal ${action} confirm`, async ({ page }) => {
    await visit(page, ROUTES["proposal-edit"].hash);
    await page.locator(`[data-act=${action}]`).click();
    await expect(page.locator(`[data-act=${action}-confirm]`)).toBeVisible();
    await shoot(page, `proposal-edit--${action}-confirm`);
  });
}

for (const mode of ["side", "inline"] as const) {
  test(`proposal diff ${mode}`, async ({ page }) => {
    await visit(page, ROUTES["proposal-edit"].hash);
    await page.locator(`[data-diff-mode=${mode}]`).click();
    await expect(page.locator(`[data-diff-mode=${mode}]`)).toHaveAttribute("aria-pressed", "true");
    await shoot(page, `proposal-edit--diff-${mode}`);
  });
}

test("asset document history", async ({ page }) => {
  await visit(page, `#/asset?ref=${ASSET_REF}&history=1`);
  await expect(page.getByRole("heading", { name: "Document history" })).toBeVisible();
  await shoot(page, "asset-knowledge--history");
});

test("editor unsaved guard", async ({ page }) => {
  await visit(page, ROUTES.edit.hash);
  await page.locator('[name="content"]').fill("# Deploy guide\n\nA draft that was never saved.\n");
  // The nav links sit behind the menu on a phone, so leave the way a link does: through the hash.
  await page.evaluate(() => {
    location.hash = "#/overview";
  });
  await expect(page.locator("#unsaved")).toBeVisible();
  await shoot(page, "edit--unsaved-guard");
});

// The [hidden] contract: a hidden panel must not be displayed, focusable or exposed (WCAG 1.3.2, 2.4.3).
test("editor preview toggle hides the inactive panel", async ({ page }) => {
  await visit(page, ROUTES.edit.hash);
  const source = page.locator("[data-source-panel]");
  const preview = page.locator("[data-preview-panel]");
  await expect(source).toBeVisible();
  await expect(preview).toBeHidden();
  await page.getByRole("tab", { name: "Preview" }).click();
  await expect(page.getByRole("tab", { name: "Preview" })).toHaveAttribute("aria-selected", "true");
  await expect(source).toBeHidden();
  await expect(source).toHaveCSS("display", "none");
  await expect(preview).toBeVisible();
  await page.getByRole("tab", { name: "Write" }).click();
  await expect(source).toBeVisible();
  await expect(preview).toBeHidden();
  await expect(preview).toHaveCSS("display", "none");
});

// The folder picker lists folders through the server and fills the field with the one chosen (no screenshot, so the
// shared server is not changed and the folders come from this run's own temp directory).
test("bundle folder picker fills the source field", async ({ page }) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akm-picker-"));
  fs.mkdirSync(path.join(root, "team-skills"));
  fs.mkdirSync(path.join(root, ".hidden"));
  try {
    await visit(page, ROUTES.bundles.hash);
    await page.locator("#ba-source").fill(root);
    await page.getByRole("button", { name: "Browse…" }).click();
    const dialog = page.getByRole("dialog", { name: "Choose a folder" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: "team-skills" })).toBeVisible();
    await expect(dialog.getByRole("button", { name: ".hidden" })).toHaveCount(0);
    await dialog.getByRole("button", { name: "team-skills" }).click();
    await expect(dialog.locator("[data-location]")).toHaveText(path.join(root, "team-skills"));
    await dialog.getByRole("button", { name: "Use this folder" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.locator("#ba-source")).toHaveValue(path.join(root, "team-skills"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
