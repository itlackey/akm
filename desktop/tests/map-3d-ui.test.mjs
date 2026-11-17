// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import assert from "node:assert/strict";
import { test } from "node:test";
import AxeBuilder from "@axe-core/playwright";
import { chromium, expect } from "@playwright/test";
import { go, launchFixture, open } from "./support.mjs";

// The 3D library map: choosing a point, and what a choice shows.
// Ten assets in two groups by meaning, joined in a line (0-1-2-3-4-5-6-7) with 8 and 9 apart: three levels from 0.
const N = 10;
const chain = {
  available: true,
  note: "Synthetic library.",
  types: ["knowledge"],
  bundles: ["wiki"],
  beliefs: [],
  use: null,
  feedback: null,
  kinds: ["xref"],
  nodes: {
    ref: Array.from({ length: N }, (_, i) => `wiki//knowledge/chain/n${i}`),
    type: new Array(N).fill(0),
    bundle: new Array(N).fill(0),
    belief: new Array(N).fill(-1),
    shows: new Array(N).fill(0),
    lastShownAt: new Array(N).fill(null),
    modifiedAt: new Array(N).fill(null),
    positive: new Array(N).fill(0),
    negative: new Array(N).fill(0),
    tags: new Array(N).fill([0]),
  },
  links: { from: [0, 1, 2, 3, 4, 5, 6], to: [1, 2, 3, 4, 5, 6, 7], kind: new Array(7).fill(0) },
  tags: ["chain"],
  duplicates: null,
  groups: {
    count: 2,
    group: [0, 0, 0, 0, 0, 1, 1, 1, 1, 1],
    x: [0, 14, -14, 28, -28, 60, 74, 46, 88, 32],
    y: [0, 10, -10, 20, -20, 0, 10, -10, 20, -20],
    z: [0, 6, -6, 12, -12, 0, 6, -6, 12, -12],
  },
};

test("the 3D library map", { timeout: 150000 }, async (t) => {
  const server = await launchFixture({});
  t.after(() => server.stop());
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const fresh = async (payload = chain) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => message.type() === "error" && errors.push(message.text()));
    await page.route("**/api/graph", (route) => route.fulfill({ json: { ok: true, data: payload } }));
    return { page, errors };
  };
  /** Move over the 3D map, outward from its middle, until a point is under the pointer, and say where. */
  const findPoint = async (page) => {
    const box = await page.locator(".stage-3d canvas").boundingBox();
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    for (let r = 0; r < 200; r += 8)
      for (let a = 0; a < (r ? 12 : 1); a++) {
        const x = cx + r * Math.cos((a * Math.PI) / 6);
        const y = cy + r * Math.sin((a * Math.PI) / 6);
        await page.mouse.move(x, y);
        await page.waitForTimeout(40);
        if (await page.locator(".stage-3d .tip").count()) return { x, y };
      }
    throw new Error("no point found on the map");
  };
  const status = (page) => page.getByRole("status").filter({ hasText: "Selected" });

  await t.test("a point is chosen from beside it, named by a label that stays, and the arrow keys step", async () => {
    const { page, errors } = await fresh();
    await open(page, server, "/library/map");
    await expect(page.locator(".stage-3d canvas")).toBeVisible();
    await page.waitForTimeout(500);
    const at = await findPoint(page);
    await expect(page.locator(".stage-3d .tip")).toContainText("wiki//knowledge/chain/n");
    await page.mouse.click(at.x, at.y);
    const label = page.locator(".stage-3d .pick-label");
    await expect(label).toBeVisible();
    const first = await label.textContent();
    await expect(status(page)).toContainText(first);
    // The arrow keys change the choice without the mouse, and say so.
    await page.locator(".stage-3d").focus();
    await page.keyboard.press("ArrowRight");
    await expect(label).not.toHaveText(first);
    const second = await label.textContent();
    await expect(status(page)).toContainText(second);
    await page.keyboard.press("ArrowLeft");
    await expect(label).toHaveText(first);
    await page.keyboard.press("Escape");
    await expect(label).toHaveCount(0);
    assert.deepEqual(errors, []);
    await page.close();
  });

  /** The assets `steps` joins from asset `from` in the chain 0-1-...-7 (8 and 9 are joined to nothing). */
  const inChain = (from, steps) =>
    from > 7 ? 0 : [...Array(8).keys()].filter((i) => Math.abs(i - from) === steps).length;

  await t.test("a chosen asset's legend names three levels with the assets at each", async () => {
    const { page, errors } = await fresh();
    await open(page, server, "/library/map");
    await expect(page.locator(".stage-3d canvas")).toBeVisible();
    await page.waitForTimeout(500);
    const at = await findPoint(page);
    await page.mouse.click(at.x, at.y);
    const from = Number((await page.locator(".stage-3d .pick-label").textContent()).match(/n(\d)$/)[1]);
    const levels = page.locator(".levels li");
    await expect(levels).toHaveCount(3);
    // The map, its key and the new controls pass the same accessibility rules as the rest of the app.
    const results = await new AxeBuilder({ page })
      .include(".map-page")
      .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
      .analyze();
    assert.deepEqual(
      results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(" ")}`),
      [],
    );
    for (const [k, name] of ["1st level", "2nd level", "3rd level"].entries()) {
      const n = inChain(from, k + 1);
      await expect(levels.nth(k)).toHaveText(`${name}: ${n} ${n === 1 ? "asset" : "assets"}`);
    }
    // Nothing is cut or off the map here, so the legend says neither.
    await expect(page.locator(".levels")).not.toContainText("not shown");
    await expect(page.locator(".levels")).not.toContainText("not on this map");
    await page.close();
    assert.deepEqual(errors, []);
  });

  await t.test("a level that reaches more assets than the cap says how many it did not show", async () => {
    const LEAVES = 305;
    const total = LEAVES + 1;
    const ref = [
      "wiki//knowledge/chain/a-hub",
      ...Array.from({ length: LEAVES }, (_, i) => `wiki//knowledge/chain/z-leaf-${i}`),
    ];
    const rnd = (i, k) => ((Math.sin(i * 12.9898 + k * 78.233) * 43758.5453) % 1) * 40;
    const hub = {
      ...chain,
      nodes: {
        ref,
        type: new Array(total).fill(0),
        bundle: new Array(total).fill(0),
        belief: new Array(total).fill(-1),
        shows: new Array(total).fill(0),
        lastShownAt: new Array(total).fill(null),
        modifiedAt: new Array(total).fill(null),
        positive: new Array(total).fill(0),
        negative: new Array(total).fill(0),
        tags: new Array(total).fill([0]),
      },
      links: {
        from: new Array(LEAVES).fill(0),
        to: Array.from({ length: LEAVES }, (_, i) => i + 1),
        kind: new Array(LEAVES).fill(0),
      },
      groups: {
        count: 1,
        group: new Array(total).fill(0),
        x: ref.map((_, i) => (i ? rnd(i, 1) : 0)),
        y: ref.map((_, i) => (i ? rnd(i, 2) : 0)),
        z: ref.map((_, i) => (i ? rnd(i, 3) : 0)),
      },
    };
    const { page, errors } = await fresh(hub);
    await open(page, server, "/library/map");
    await expect(page.locator(".stage-3d canvas")).toBeVisible();
    await page.locator(".stage-3d").focus();
    await page.keyboard.press("ArrowRight");
    await expect(page.locator(".stage-3d .pick-label")).toHaveText("wiki//knowledge/chain/a-hub");
    await expect(page.locator(".levels li").nth(0)).toHaveText(
      "1st level: 300 assets, 5 more not shown (a level shows its 300 most joined assets)",
    );
    await expect(page.locator(".levels li").nth(1)).toHaveText("2nd level: 0 assets");
    await page.close();
    assert.deepEqual(errors, []);
  });

  await t.test(
    "Replay: 2D is the default, 3D plays the same events on the 3D map, says what has no place, and is remembered",
    async () => {
      // Asset 9 has no group by meaning, so no place on the 3D map; "wiki//gone" is not in the index at all.
      const noPlace = { ...chain, groups: { ...chain.groups, group: [0, 0, 0, 0, 0, 1, 1, 1, 1, -1] } };
      const hours = (h) => new Date(Date.now() - h * 3_600_000).toISOString();
      const event = (id, h, eventType, ref, extra = {}) => ({
        id,
        at: hours(h),
        eventType,
        ref,
        source: "user",
        byPerson: true,
        ...extra,
      });
      const { page, errors } = await fresh(noPlace);
      await page.route("**/api/events?since=24h", (route) =>
        route.fulfill({
          json: {
            ok: true,
            data: {
              available: true,
              truncated: false,
              window: { since: hours(24), until: hours(0) },
              events: [
                event(1, 6, "show", "wiki//knowledge/chain/n0"),
                event(2, 5, "search", "wiki//knowledge/chain/n1"),
                event(3, 4, "feedback", "wiki//knowledge/chain/n2", { signal: "positive" }),
                event(4, 3, "show", "wiki//knowledge/chain/n9"),
                event(5, 2, "show", "wiki//gone"),
              ],
            },
          },
        }),
      );
      await open(page, server, "/activity/replay");
      const replay = page.getByRole("region", { name: "Activity replay", exact: true });
      const drawing = replay.getByRole("group", { name: "Map drawing" });
      await expect(drawing.getByRole("button", { name: "2D" })).toHaveAttribute("aria-pressed", "true");
      await expect(replay.locator(".mind-map")).toBeVisible();
      await expect(replay.locator(".stage-3d")).toHaveCount(0);
      await drawing.getByRole("button", { name: "3D" }).click();
      await expect(drawing.getByRole("button", { name: "3D" })).toHaveAttribute("aria-pressed", "true");
      await expect(replay.locator(".stage-3d canvas")).toBeVisible();
      await expect(replay.locator(".mind-map")).toHaveCount(0);
      // The same controls and figures as 2D.
      await expect(replay.getByRole("combobox", { name: "Speed" })).toBeVisible();
      await expect(replay.getByRole("combobox", { name: "Events by" })).toBeVisible();
      await expect(replay.getByRole("slider", { name: "Playhead" })).toBeVisible();
      await expect(replay.locator(".figures")).toContainText("4events");
      const results = await new AxeBuilder({ page })
        .include(".replay")
        .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
        .analyze();
      assert.deepEqual(
        results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(" ")}`),
        [],
      );
      // The key names every mark, and what has no place is counted, not dropped.
      const key = replay.getByRole("list", { name: "Key to the 3D map" });
      for (const name of ["Used so far", "Not used yet", "Read, just now", "Returned by a search, just now"])
        await expect(key).toContainText(name);
      await expect(replay).toContainText("1 event so far touched assets with no place on this map");
      await expect(replay).toContainText("1 event so far touched assets the index no longer lists");
      // Play runs in 3D, with no errors, and pauses.
      await replay.getByRole("button", { name: /^Play/ }).click();
      await expect(replay.getByRole("button", { name: "Pause" })).toBeVisible();
      await replay.getByRole("button", { name: "Pause" }).click();
      // The choice is kept for the session: leave the page and come back inside the app.
      await go(page, "/activity");
      await go(page, "/activity/replay");
      await expect(replay.locator(".stage-3d canvas")).toBeVisible();
      await drawing.getByRole("button", { name: "2D" }).click();
      await expect(replay.locator(".mind-map")).toBeVisible();
      assert.deepEqual(errors, []);
      await page.close();
    },
  );
});
