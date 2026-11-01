// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** The route x state matrix of plan 11.2: one baseline per pair, in every width and scheme of the project. */

import { expect, test } from "@playwright/test";
import { LONG_NAME, LONG_QUERY, type Profile } from "./constants";
import { failApi, holdApi, open, ROUTES, type RouteName, shoot, visit } from "./support";

const LOADED: RouteName[] = Object.keys(ROUTES) as RouteName[];

/** Routes that still draw something meaningful on a fresh sandbox or a quiet one. */
const EMPTY: RouteName[] = [
  "overview",
  "bundles",
  "config",
  "proposals-pending",
  "proposals-recent",
  "history",
  "search-browse",
  "search-results",
  "new",
];
const LOW_DATA: RouteName[] = ["overview", "proposals-pending", "history", "search-results", "bundles"];
const FAILING: RouteName[] = [
  "overview",
  "bundles",
  "config",
  "proposals-pending",
  "proposal-edit",
  "history",
  "search-results",
  "asset-knowledge",
  "edit",
  "new",
];
const LOADING: RouteName[] = ["overview", "proposals-pending", "search-results", "asset-knowledge"];

for (const name of LOADED) {
  test(`${name} loaded`, async ({ page }) => {
    await visit(page, ROUTES[name].hash);
    await shoot(page, `${name}--loaded`);
  });
}

function onProfile(state: string, profile: Profile, names: RouteName[]): void {
  for (const name of names) {
    test(`${name} ${state}`, async ({ page }) => {
      await visit(page, ROUTES[name].hash, profile);
      await shoot(page, `${name}--${state}`);
    });
  }
}

onProfile("empty", "empty", EMPTY);
onProfile("low-data", "low-data", LOW_DATA);

// The long-content fixture: an 80-char ref, a 120-char query, a 6-digit count and a 40-segment path.
const LONG_REF = encodeURIComponent(`stash//knowledge/${LONG_NAME}`);
const LONG: Array<[string, string]> = [
  ["overview", "#/overview"],
  ["proposals-pending", "#/proposals"],
  ["search-results", `#/search?q=${encodeURIComponent(LONG_QUERY)}`],
  ["asset-knowledge", `#/asset?ref=${LONG_REF}`],
  ["bundles", "#/bundles"],
];
for (const [name, hash] of LONG) {
  test(`${name} long-content`, async ({ page }) => {
    await visit(page, hash, "long-content");
    await shoot(page, `${name}--long-content`);
  });
}

// The 40-segment path only shows once a commit's changed-path disclosure is open, so open them all and say it is there.
test("history long-content", async ({ page }) => {
  await visit(page, ROUTES.history.hash, "long-content");
  for (const summary of await page.locator("main details > summary").all()) await summary.click();
  await expect(page.locator("main li.wrap").filter({ hasText: "level-39/deep.md" })).toBeVisible();
  await shoot(page, "history--long-content");
});

// The Working stash card: the harness stash is a configured bundle, so answer /api/bundles as a stash with none.
test("bundles working-stash", async ({ page }) => {
  await page.route(ROUTES.bundles.api, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    const stash = body.data.bundles[0].path;
    await route.fulfill({
      response,
      json: {
        ...body,
        data: {
          ...body.data,
          bundles: [],
          defaultBundle: null,
          defaultWriteTarget: null,
          workingStash: { path: stash, git: null },
          automaticWriteTarget: { name: "stash", path: stash },
        },
      },
    });
  });
  await visit(page, ROUTES.bundles.hash);
  await expect(page.getByRole("heading", { level: 3, name: "Working stash" })).toBeVisible();
  await shoot(page, "bundles--working-stash");
});

for (const name of FAILING) {
  test(`${name} error`, async ({ page }) => {
    await failApi(page, ROUTES[name].api);
    await visit(page, ROUTES[name].hash);
    await expect(page.getByRole("alert")).toBeVisible();
    await shoot(page, `${name}--error`);
  });
}

// Partial error: /api/overview answers, but a section failed on the server. The page draws what loaded, drops the
// failed sections and says so in a warning disclosure (overview.js, `errors`). A failed /api/meta is a second,
// quieter degradation (the footer's version line is empty), so it is part of the same shot.
test("overview partial", async ({ page }) => {
  await page.route(ROUTES.overview.api, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    const data = {
      ...body.data,
      metrics: null,
      retrieval: null,
      errors: { metrics: "The usage store could not be read." },
    };
    await route.fulfill({ response, json: { ...body, data } });
  });
  await visit(page, ROUTES.overview.hash, "loaded", /\/api\/meta/);
  await expect(page.getByText("1 sections could not load")).toBeVisible();
  await expect(page.locator("#nav-meta")).toBeEmpty();
  await shoot(page, "overview--partial");
});

for (const name of LOADING) {
  test(`${name} loading`, async ({ page }) => {
    await holdApi(page, ROUTES[name].api);
    await open(page, ROUTES[name].hash);
    await expect(page.locator(".state-loading")).toBeVisible();
    await page.evaluate(() => document.fonts.ready); // aria-busy stays on by design while the request is held.
    await shoot(page, `${name}--loading`);
  });
}
