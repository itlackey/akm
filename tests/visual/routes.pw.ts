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
] as const;

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
    await openRoute(page, route.hash, route.heading);
    await expect(page).toHaveScreenshot(`${route.name}--loaded.png`, {
      fullPage: true,
      mask: [page.locator("[data-volatile]").filter({ visible: true })],
    });
  });
}
