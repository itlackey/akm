// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** What every visual spec shares: reaching a route on a profile's server, settling it and capturing it (plan 8.7, 11.2). */

import { expect, type Locator, type Page } from "@playwright/test";
import { FIXED_NOW, PROFILES, type Profile, VISUAL_TOKEN } from "./constants";

export interface RouteSpec {
  hash: string;
  /** A request pattern for the route's main API call, which the error and loading states intercept. */
  api: RegExp;
}

const SEED_GUIDE = encodeURIComponent("stash//knowledge/deploy-guide");

/** Every route of today's client, in the order the matrix reports them. */
export const ROUTES = {
  overview: { hash: "#/overview", api: /\/api\/overview\?/ },
  bundles: { hash: "#/bundles", api: /\/api\/bundles(\?|$)/ },
  config: { hash: "#/config", api: /\/api\/config(\?|$)/ },
  "proposals-pending": { hash: "#/proposals", api: /\/api\/proposals\?/ },
  "proposals-recent": { hash: "#/proposals?status=recent", api: /\/api\/proposals\?/ },
  "proposal-edit": {
    hash: "#/proposals/p-pending-reflect",
    api: /\/api\/proposals\/p-pending-reflect/,
  },
  "proposal-create": {
    hash: "#/proposals/p-pending-create",
    api: /\/api\/proposals\/p-pending-create/,
  },
  "proposal-retire": {
    hash: "#/proposals/p-pending-retire",
    api: /\/api\/proposals\/p-pending-retire/,
  },
  "proposal-noop": {
    hash: "#/proposals/p-pending-noop",
    api: /\/api\/proposals\/p-pending-noop/,
  },
  changes: { hash: "#/changes", api: /\/api\/changes\?/ },
  "search-results": { hash: "#/search?q=deploy", api: /\/api\/search\?/ },
  "search-browse": { hash: "#/search", api: /\/api\/search\?/ },
  "asset-knowledge": { hash: `#/asset?ref=${SEED_GUIDE}`, api: /\/api\/asset\?/ },
  "asset-command": {
    hash: `#/asset?ref=${encodeURIComponent("stash//commands/release-notes")}`,
    api: /\/api\/asset\?/,
  },
  edit: { hash: `#/edit?ref=${SEED_GUIDE}`, api: /\/api\/asset\/source\?/ },
  new: { hash: "#/new", api: /\/api\/bundles(\?|$)/ },
} as const satisfies Record<string, RouteSpec>;

export type RouteName = keyof typeof ROUTES;

/** The page content that means a route has finished drawing, whatever state it ended in. */
const DRAWN = "main > :not(noscript):not(.state-loading)";

/** Open `hash` on a profile's server with the clock frozen; resolves once the page has drawn and settled. */
export async function visit(page: Page, hash: string, profile: Profile = "loaded", fail?: RegExp): Promise<void> {
  await open(page, hash, profile, fail);
  await expect(page.locator(DRAWN).first()).toBeVisible();
  // The client falls back to Pending for an unknown status, so a wrong address would shoot the wrong view.
  if (hash === ROUTES["proposals-recent"].hash)
    await expect(page.getByRole("link", { name: "Recent" })).toHaveAttribute("aria-current", "page");
  await settle(page);
}

/** The server's version and host name decide how the sidebar footer wraps, so the specs pin them. */
async function pinMeta(page: Page): Promise<void> {
  await page.route(/\/api\/meta(\?|$)/, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({
      response,
      json: { ...body, data: { ...body.data, version: "0.0.0", hostname: "visual-host" } },
    });
  });
}

/**
 * Navigate without waiting for the route to draw, for states that hold or fail the request.
 * `fail` is registered last so that it wins over the shared intercepts (the last route runs first).
 */
export async function open(page: Page, hash: string, profile: Profile = "loaded", fail?: RegExp): Promise<void> {
  const origin = `http://127.0.0.1:${PROFILES[profile]}`;
  await page.clock.setFixedTime(FIXED_NOW);
  await pinMeta(page);
  if (fail) await failApi(page, fail);
  await page.goto(`${origin}/?token=${VISUAL_TOKEN}${hash}`);
}

async function settle(page: Page): Promise<void> {
  await expect(page.locator("main")).not.toHaveAttribute("aria-busy", "true");
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => document.fonts.ready);
}

/** Regions whose text depends on the host or the release: `[data-volatile]` and the installed-version health message. */
export function volatileMasks(page: Page): Locator[] {
  return [
    page.locator("[data-volatile]").filter({ visible: true }),
    page.locator(".check-msg", { hasText: /akm v[\d.]+ is installed/ }).filter({ visible: true }),
  ];
}

/** The baseline for `<name>.png` in this project, with the volatile regions masked. */
export async function shoot(page: Page, name: string): Promise<void> {
  await expect(page).toHaveScreenshot(`${name}.png`, { fullPage: true, mask: volatileMasks(page) });
}

/** Fail the main API call of a route with the server's own error shape. */
export async function failApi(page: Page, pattern: RegExp): Promise<void> {
  await page.route(pattern, (route) =>
    route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, code: "INTERNAL_ERROR", error: "The index could not be read." }),
    }),
  );
}

/** Hold a request without answering it, so the route stays in its loading state. */
export async function holdApi(page: Page, pattern: RegExp): Promise<void> {
  await page.route(pattern, () => {});
}
