// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The accessibility ratchet (plan 8.6, 11.4, S-30). Every route of today's client is checked with axe (WCAG 2.0 to 2.2
 * A/AA plus best practice, which includes target size), at 1280 and 320, in both schemes, and for reflow at 320 and 640,
 * text spacing, and focus not obscured (2.4.11). Three cross-route checks cover the route announcement, focus after a
 * route change and focus during an asynchronous action.
 *
 * Today's findings are recorded in `a11y-known.json` under `findings`, each with its plan bug id. A finding the file does
 * not record, or one that is larger than recorded, fails; a recorded finding that is gone or smaller also fails, so the
 * file can only shrink. Record today's findings, or lower them after a fix, with
 * `UPDATE_A11Y_KNOWN=1 bun run test:ui-visual:docker -- --project a11y`. The file must be empty by P5-9.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { ROUTES, type RouteName, visit } from "./support";

const root = path.join(import.meta.dirname, "../..");
const KNOWN_FILE = path.join(import.meta.dirname, "a11y-known.json");
const UPDATE = process.env.UPDATE_A11Y_KNOWN === "1";

type Entry = { count: number; ref: string };
type Findings = Record<string, Entry>;
type Known = { tokens?: unknown; findings?: Record<string, Findings> };

const SCHEMES = ["light", "dark"] as const;
const AXE_WIDTHS = [1280, 320] as const;
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];
/** How many Tab stops the 2.4.11 check visits on a route. */
const TAB_STOPS = 40;
const UNTRIAGED = "untriaged (Phase 1)";

/** The plan bug that explains a finding; anything else is triaged when Phase 1 reaches it. */
const REFS: [RegExp, string][] = [
  [/^axe .* target-size$/, "B-24, B-59, B-60"],
  [/^axe .* scrollable-region-focusable$/, "B-40"],
  [/^axe .* (page-has-heading-one|heading-order)$/, "B-41"],
  [/^axe .* landmark-/, "B-30"],
  [/^axe .* region$/, "B-30"],
  [/^axe .* aria-allowed-attr$/, "B-44"],
  [/^reflow /, "B-23"],
  [/^route-status/, "B-19"],
  [/^focus-after-route/, "B-21"],
  [/^focus-async overview/, "B-22"],
  [/^focus-async proposal/, "B-27"],
  [/^focus-obscured /, "B-63"],
];
const refFor = (key: string) => REFS.find(([pattern]) => pattern.test(key))?.[1] ?? UNTRIAGED;

const readKnown = (): Known => JSON.parse(fs.readFileSync(KNOWN_FILE, "utf8"));

/** Compare `found` for `scope` with the ratchet, or record it when updating. */
function ratchet(scope: string, found: Record<string, number>): void {
  const known = readKnown();
  const recorded = known.findings?.[scope] ?? {};
  if (UPDATE) {
    const next: Findings = {};
    for (const key of Object.keys(found).sort()) {
      next[key] = { count: found[key] as number, ref: recorded[key]?.ref ?? refFor(key) };
    }
    const findings = { ...known.findings };
    if (Object.keys(next).length > 0) findings[scope] = next;
    else delete findings[scope];
    const sorted = Object.fromEntries(Object.entries(findings).sort(([a], [b]) => a.localeCompare(b)));
    fs.writeFileSync(KNOWN_FILE, `${JSON.stringify({ ...known, findings: sorted }, null, 2)}\n`);
    execFileSync(path.join(root, "node_modules/.bin/biome"), ["format", "--write", KNOWN_FILE], { cwd: root });
    return;
  }
  const grew = Object.entries(found)
    .filter(([key, count]) => count > (recorded[key]?.count ?? 0))
    .map(([key, count]) => `${key}: ${count} (recorded ${recorded[key]?.count ?? 0})`);
  const shrank = Object.entries(recorded)
    .filter(([key, entry]) => (found[key] ?? 0) < entry.count)
    .map(([key, entry]) => `${key}: ${found[key] ?? 0} (recorded ${entry.count}, ${entry.ref})`);
  expect(grew, "new accessibility findings; fix them rather than record them").toEqual([]);
  expect(shrank, "fixed or reduced; lower or remove them in tests/visual/a11y-known.json").toEqual([]);
}

/** Let a viewport or scheme change take effect: layout, then any chart that redraws on resize. */
async function resize(page: Page, width: number, height = 800): Promise<void> {
  await page.setViewportSize({ width, height });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function axeFindings(page: Page, prefix: string, found: Record<string, number>): Promise<void> {
  const { violations } = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  for (const violation of violations) found[`axe ${prefix} ${violation.id}`] = violation.nodes.length;
}

/** WCAG 1.4.12 override values; the page must lose nothing when a reader applies them. */
const TEXT_SPACING = `
  * { line-height: 1.5 !important; letter-spacing: .12em !important; word-spacing: .16em !important; }
  p { margin-block-end: 2em !important; }`;

async function textSpacingFindings(page: Page): Promise<number> {
  const style = await page.addStyleTag({ content: TEXT_SPACING });
  try {
    return await page.evaluate(() => {
      // Sideways scrolling of the page, plus text cut off by a box that neither grows nor scrolls.
      let lost = document.documentElement.scrollWidth > document.documentElement.clientWidth ? 1 : 0;
      for (const element of document.body.querySelectorAll<HTMLElement>("*")) {
        const style = getComputedStyle(element);
        if (!element.textContent?.trim() || style.display === "none" || style.display === "inline") continue;
        const clips = (value: string) => value === "hidden" || value === "clip";
        const clippedX = clips(style.overflowX) && element.scrollWidth > element.clientWidth + 1;
        const clippedY = clips(style.overflowY) && element.scrollHeight > element.clientHeight + 1;
        if (clippedX || clippedY) lost++;
      }
      return lost;
    });
  } finally {
    await style.evaluate((node) => (node as Element).remove());
  }
}

/** Tab through the route and count the stops whose focus indicator is hidden behind other content (WCAG 2.4.11). */
async function obscuredStops(page: Page): Promise<number> {
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
    window.scrollTo(0, 0);
  });
  let obscured = 0;
  for (let stop = 0; stop < TAB_STOPS; stop++) {
    await page.keyboard.press("Tab");
    const state = await page.evaluate(() => {
      const element = document.activeElement;
      if (!element || element === document.body) return "body";
      const box = element.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) return "hidden";
      const points = [
        [box.left + box.width / 2, box.top + box.height / 2],
        [box.left + 2, box.top + 2],
        [box.right - 2, box.bottom - 2],
      ] as const;
      const visible = points.some(([x, y]) => {
        if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return false;
        const top = document.elementFromPoint(x, y);
        return top !== null && (top === element || element.contains(top) || top.contains(element));
      });
      return visible ? "ok" : "obscured";
    });
    if (state === "body") break; // Focus left the page: the tab order has wrapped.
    if (state === "obscured") obscured++;
  }
  return obscured;
}

test.describe.configure({ mode: "serial" });
test.setTimeout(180_000);

for (const name of Object.keys(ROUTES) as RouteName[]) {
  test(`${name} stays within the accessibility ratchet`, async ({ page }) => {
    const found: Record<string, number> = {};
    await visit(page, ROUTES[name].hash);

    for (const width of AXE_WIDTHS) {
      await resize(page, width);
      for (const scheme of SCHEMES) {
        await page.emulateMedia({ colorScheme: scheme });
        await axeFindings(page, `${scheme} ${width}`, found);
      }
    }
    await page.emulateMedia({ colorScheme: "light" });

    for (const width of [320, 640]) {
      await resize(page, width);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      if (overflow > 0) found[`reflow ${width}`] = overflow;
    }
    for (const width of [1280, 320]) {
      await resize(page, width);
      const lost = await textSpacingFindings(page);
      if (lost > 0) found[`text-spacing ${width}`] = lost;
      const obscured = await obscuredStops(page);
      if (obscured > 0) found[`focus-obscured ${width}`] = obscured;
    }
    ratchet(name, found);
  });
}

test("the route announcement is one polite region, and the page is not live", async ({ page }) => {
  await visit(page, ROUTES.overview.hash);
  const found: Record<string, number> = {};
  const regions = await page.locator("#route-status").count();
  if (regions !== 1) found["route-status regions"] = Math.abs(regions - 1);
  // The whole page announced on every route is B-19.
  const live = await page.locator("main[aria-live]").count();
  if (live > 0) found["route-status main-is-live"] = live;
  ratchet("_route-status", found);
});

test("focus never falls to the body after a route change", async ({ page }) => {
  const found: Record<string, number> = {};
  await visit(page, ROUTES.bundles.hash);
  for (const name of Object.keys(ROUTES) as RouteName[]) {
    // From a different route, so that the change is a navigation and not a first load.
    await page.evaluate(() => {
      location.hash = "#/config";
    });
    await expect(page.locator("main")).not.toHaveAttribute("aria-busy", "true");
    await page.waitForLoadState("networkidle");
    await page.evaluate((hash) => {
      location.hash = hash;
    }, ROUTES[name].hash);
    await expect(page.locator("main > :not(noscript):not(.state-loading)").first()).toBeVisible();
    await expect(page.locator("main")).not.toHaveAttribute("aria-busy", "true");
    await page.waitForLoadState("networkidle");
    const onBody = await page.evaluate(() => document.activeElement === document.body);
    if (onBody) found[`focus-after-route ${name}`] = 1;
  }
  ratchet("_focus-after-route", found);
});

test("focus survives an asynchronous action", async ({ page }) => {
  const found: Record<string, number> = {};

  // Changing the Overview window redraws the route: focus must not fall to the body (B-22).
  await visit(page, ROUTES.overview.hash);
  await page.locator("select[name=metric-window]").selectOption("7d");
  await expect(page.locator("main")).not.toHaveAttribute("aria-busy", "true");
  await page.waitForLoadState("networkidle");
  if (await page.evaluate(() => document.activeElement === document.body)) found["focus-async overview window"] = 1;

  // Confirming Accept while the server is slow (B-27). The request is held, so nothing is accepted.
  const proposal = await page.context().newPage();
  await proposal.route(/\/api\/proposals\/p-pending-reflect\/accept/, () => {});
  await visit(proposal, ROUTES["proposal-edit"].hash);
  await proposal.getByRole("button", { name: "Accept", exact: true }).click();
  await proposal.getByRole("button", { name: "Confirm accept" }).click();
  await expect(proposal.getByText("Accepting")).toBeVisible();
  if (await proposal.evaluate(() => document.activeElement === document.body)) found["focus-async proposal accept"] = 1;
  await proposal.close();

  ratchet("_focus-async", found);
});
