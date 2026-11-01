// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** One screenshot per route and project: overview, proposals and an asset (plan 8.7, 11.2). */

import { expect, type Page, test } from "@playwright/test";
import { FIXED_NOW, VISUAL_TOKEN } from "./constants";

const ROUTES = [
  { name: "overview", hash: "#/overview", heading: "Overview" },
  { name: "proposals", hash: "#/proposals", heading: "Proposals" },
  {
    name: "asset",
    hash: `#/asset?ref=${encodeURIComponent("stash//knowledge/deploy-guide")}`,
    heading: "Deploy guide",
  },
  {
    name: "asset-command",
    hash: `#/asset?ref=${encodeURIComponent("stash//commands/release-notes")}`,
    heading: "release-notes",
  },
  { name: "bundles", hash: "#/bundles", heading: "Bundles" },
  { name: "bundles-working-stash", hash: "#/bundles", heading: "Bundles", workingStashOnly: true },
] as const;

/** The harness stash is a configured bundle; answer as a stash with no configured bundles so the Working stash card renders. */
async function withoutConfiguredBundles(page: Page): Promise<void> {
  await page.route("**/api/bundles", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({
      response,
      json: {
        ...body,
        data: {
          ...body.data,
          bundles: [],
          defaultBundle: null,
          defaultWriteTarget: null,
          workingStash: { path: body.data.bundles[0].path, git: null },
          automaticWriteTarget: { name: "stash", path: body.data.bundles[0].path },
        },
      },
    });
  });
}

async function openRoute(page: Page, hash: string, heading: string): Promise<void> {
  await page.clock.setFixedTime(FIXED_NOW);
  await page.goto(`/?token=${VISUAL_TOKEN}${hash}`);
  await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
  await expect(page.locator("main")).not.toHaveAttribute("aria-busy", "true");
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => document.fonts.ready);
}

for (const route of ROUTES) {
  test(`${route.name} matches its baseline`, async ({ page }) => {
    if ("workingStashOnly" in route) await withoutConfiguredBundles(page);
    await openRoute(page, route.hash, route.heading);
    await expect(page).toHaveScreenshot(`${route.name}--loaded.png`, {
      fullPage: true,
      mask: [page.locator("[data-volatile]").filter({ visible: true })],
    });
  });
}
