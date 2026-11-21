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
    const label = page.locator(".stage-3d .pick-label .ref");
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
    const from = Number((await page.locator(".stage-3d .pick-label .ref").textContent()).match(/n(\d)$/)[1]);
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
    await expect(page.locator(".stage-3d .pick-label .ref")).toHaveText("wiki//knowledge/chain/a-hub");
    await expect(page.locator(".levels li").nth(0)).toHaveText(
      "1st level: 300 assets, 5 more not shown (a level shows its 300 most joined assets)",
    );
    await expect(page.locator(".levels li").nth(1)).toHaveText("2nd level: 0 assets");
    await page.close();
    assert.deepEqual(errors, []);
  });

  // The same ten assets with recorded use and feedback, and the first of them superseded.
  const days = (d) => new Date(Date.now() - d * 86_400_000).toISOString();
  const used = {
    ...chain,
    beliefs: ["superseded"],
    use: { since: days(90), source: "user" },
    feedback: { since: days(90), source: "user" },
    nodes: {
      ...chain.nodes,
      belief: [0, ...new Array(N - 1).fill(-1)],
      shows: new Array(N).fill(3),
      lastShownAt: new Array(N).fill(days(2)),
      modifiedAt: new Array(N).fill(days(10)),
    },
  };
  const depthPick = (page) => page.getByRole("combobox", { name: "Depth shows" });
  const depthKey = (page) => page.locator(".stage-3d .depth-key");
  const sizeKey = (page) => page.locator(".stage-3d .size-key");
  const drawing = (page, name) =>
    page.getByRole("group", { name: "Drawing" }).getByRole("button", { name, exact: true });
  const chip = (page, name) => page.getByRole("group", { name: "Filters" }).getByRole("button", { name });
  const showing = (page) => page.getByRole("status").filter({ hasText: "Showing" });
  /** How far the scene's front points at the viewer: 1 facing, -1 facing away. */
  const toward = async (page) => Number(await page.locator(".stage-3d .depth-marker").getAttribute("data-toward"));
  const ready = async (page) => {
    await open(page, server, "/library/map");
    await expect(page.locator(".stage-3d canvas")).toBeVisible();
    await page.waitForTimeout(500);
  };
  const axe = async (page) => {
    const results = await new AxeBuilder({ page })
      .include(".map-page")
      .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
      .analyze();
    assert.deepEqual(
      results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(" ")}`),
      [],
    );
  };

  /** The filters offered, in order: the first is the view's answer, drawn as tiles with its question. */
  const offered = (page) =>
    page
      .getByRole("group", { name: "Filters" })
      .getByRole("group")
      .evaluateAll((all) => all.map((el) => el.getAttribute("aria-label")));

  await t.test("each view answers its question with counts that filter, and filters carry across views", async () => {
    const { page, errors } = await fresh(used);
    await ready(page);
    // Contents: what is in it and how it connects.
    assert.deepEqual(await offered(page), ["Type", "Links"]);
    await expect(page.locator(".tiles")).toContainText("What is in the library?");
    await expect(chip(page, "Knowledge")).toHaveText("10Knowledge");
    await expect(chip(page, "Linked")).toHaveText("Linked8");
    await expect(showing(page)).toHaveCount(0);
    await chip(page, "No links").click();
    await expect(chip(page, "No links")).toHaveAttribute("aria-pressed", "true");
    await expect(showing(page)).toHaveText("Showing 2 of 10 assets");
    // Problems: what is wrong, and whether it is still read. The Links choice still applies and says so.
    await page.getByRole("tab", { name: "Problems" }).click();
    assert.deepEqual(await offered(page), ["Problem", "Reads", "Type", null]);
    const carried = chip(page, "Links: No links");
    await expect(carried).toBeVisible();
    // No unlinked asset is outdated, so that class cannot be chosen until Links is lifted.
    await expect(chip(page, "Superseded")).toBeDisabled();
    await carried.click();
    await expect(showing(page)).toHaveCount(0);
    await chip(page, "Superseded").click();
    await chip(page, "Still read").click();
    await expect(showing(page)).toHaveText("Showing 1 of 10 assets");
    // What the filters show is listed beside the map, most read first.
    const shown = page.locator(".map-side section").first();
    await expect(shown).toContainText("Shown on the map, most reads first");
    await expect(shown.getByRole("link")).toHaveText("knowledge/chain/n0");
    await axe(page);
    // Use: when it was last read, and what people made of it.
    await page.getByRole("tab", { name: "Use" }).click();
    assert.deepEqual(await offered(page), ["Last read", "Feedback", "Type", null]);
    await expect(chip(page, "Read in the last 30 days")).toHaveText("1Read in the last 30 days");
    await page.getByRole("button", { name: "Clear filters" }).click();
    await expect(showing(page)).toHaveCount(0);
    await expect(chip(page, "Read in the last 30 days")).toHaveText("10Read in the last 30 days");
    // Reset clears filters too.
    await chip(page, "Knowledge").click();
    await expect(showing(page)).toHaveText("Showing 10 of 10 assets");
    await page.getByRole("button", { name: "Reset" }).click();
    await expect(showing(page)).toHaveCount(0);
    assert.deepEqual(errors, []);
    await page.close();
  });

  await t.test("a filter akm has no figures for is not offered", async () => {
    const { page, errors } = await fresh();
    await ready(page);
    await page.getByRole("tab", { name: "Use" }).click();
    assert.deepEqual(await offered(page), ["Type"]);
    await page.getByRole("tab", { name: "Problems" }).click();
    assert.deepEqual(await offered(page), ["Problem", "Type"]);
    assert.deepEqual(errors, []);
    await page.close();
  });

  await t.test(
    "size is links in Contents and reads in Use and Problems, with a key; labels give the figure",
    async () => {
      const { page, errors } = await fresh(used);
      await ready(page);
      await expect(sizeKey(page)).toContainText("Size: links");
      await expect(sizeKey(page).locator("li")).toHaveText(["0", "1", "2"]);
      await page.locator(".stage-3d").focus();
      await page.keyboard.press("ArrowRight");
      await expect(page.locator(".stage-3d .pick-label .value")).toContainText(/ · \d links?$/);
      await page.keyboard.press("Escape");
      await page.getByRole("tab", { name: "Use" }).click();
      await expect(sizeKey(page)).toContainText("Size: reads");
      await expect(sizeKey(page).locator("li")).toHaveText(["0", "1", "3"]);
      await findPoint(page);
      await expect(page.locator(".stage-3d .tip")).toContainText("read 3 times, last 2 days ago");
      await page.getByRole("tab", { name: "Problems" }).click();
      await expect(sizeKey(page)).toContainText("Size: reads");
      assert.deepEqual(errors, []);
      await page.close();
    },
  );

  await t.test("depth is akm's own until a figure is chosen for it; a view never moves the points", async () => {
    const { page, errors } = await fresh(used);
    await ready(page);
    const reverse = page.getByRole("button", { name: "Reverse" });
    await expect(depthPick(page)).toHaveValue("meaning");
    await expect(depthKey(page)).toHaveCount(0);
    await expect(reverse).toHaveCount(0);
    for (const name of ["Use", "Problems"]) {
      await page.getByRole("tab", { name }).click();
      await expect(depthPick(page)).toHaveValue("meaning");
    }
    await depthPick(page).selectOption({ label: "Age and status" });
    await expect(depthKey(page).locator("li")).toHaveText([
      "edited in the last 180 daysfront",
      "edited longer ago",
      "superseded, contradicted or deprecatedback",
    ]);
    await reverse.click();
    await expect(reverse).toHaveAttribute("aria-pressed", "true");
    await expect(depthKey(page).locator("li").first()).toHaveText("superseded, contradicted or deprecatedfront");
    // The choice stays when the view changes, and the labels add its figure.
    await page.getByRole("tab", { name: "Use" }).click();
    await expect(depthPick(page)).toHaveValue("lifecycle");
    await page.locator(".stage-3d").focus();
    await page.keyboard.press("ArrowRight");
    await expect(page.locator(".stage-3d .pick-label .value")).toContainText("read 3 times, last 2 days ago · ");
    await expect(page.locator(".stage-3d .pick-label .value")).toContainText("edited ");
    await axe(page);
    assert.deepEqual(errors, []);
    await page.close();
  });

  await t.test("a depth akm has no figures for cannot be chosen, and its option says why", async () => {
    const { page, errors } = await fresh();
    await ready(page);
    const option = depthPick(page).locator("option", { hasText: "Last read" });
    await expect(option).toHaveAttribute("disabled", "");
    await expect(option).toHaveText("Last read (no usage history is available)");
    assert.deepEqual(errors, []);
    await page.close();
  });

  await t.test(
    "the marker names the front from any angle; keys and the map's buttons turn, zoom and face front",
    async () => {
      const { page, errors } = await fresh(used);
      await ready(page);
      assert.ok((await toward(page)) > 0.9);
      await expect(page.locator(".stage-3d .depth-marker")).toContainText("Front, facing you");
      const stage = page.locator(".stage-3d");
      await stage.focus();
      // Twelve turns of a twelfth of a half circle: the back now faces the viewer.
      for (let k = 0; k < 12; k++) await page.keyboard.press("Shift+ArrowRight");
      await expect.poll(() => toward(page)).toBeLessThan(-0.9);
      await expect(page.locator(".stage-3d .depth-marker")).toContainText("Back, facing you");
      await page.keyboard.press("ArrowUp");
      await page.keyboard.press("ArrowUp");
      await expect.poll(() => toward(page)).toBeGreaterThan(-0.9);
      // Zooming moves a name away from the middle of the view; the direction is kept.
      const nameAt = () =>
        page
          .locator(".stage-3d .group-name")
          .last()
          .evaluate((el) => el.style.transform);
      let before = await nameAt();
      const turned = await toward(page);
      await page.keyboard.press("+");
      await expect.poll(nameAt).not.toBe(before);
      before = await nameAt();
      await page.getByRole("button", { name: "Zoom out" }).click();
      await expect.poll(nameAt).not.toBe(before);
      assert.ok(Math.abs((await toward(page)) - turned) < 0.05);
      // Facing front keeps the choice, by key and by button.
      await stage.focus();
      await page.keyboard.press("ArrowRight");
      await expect(page.locator(".stage-3d .pick-label")).toBeVisible();
      await page.keyboard.press("0");
      await expect.poll(() => toward(page)).toBeGreaterThan(0.99);
      for (let k = 0; k < 4; k++) await page.keyboard.press("Shift+ArrowLeft");
      await expect.poll(() => toward(page)).toBeLessThan(0.9);
      await page.getByRole("button", { name: "Front view" }).click();
      await expect.poll(() => toward(page)).toBeGreaterThan(0.99);
      await expect(page.locator(".stage-3d .pick-label")).toBeVisible();
      // The arrow keys alone still step through the group.
      const label = page.locator(".stage-3d .pick-label .ref");
      const first = await label.textContent();
      await stage.focus();
      await page.keyboard.press("ArrowRight");
      await expect(label).not.toHaveText(first);
      assert.deepEqual(errors, []);
      await page.close();
    },
  );

  await t.test("2D draws the same points in one plane: no turning, no depth, and the choices survive it", async () => {
    const { page, errors } = await fresh(used);
    await ready(page);
    await page.getByRole("tab", { name: "Use" }).click();
    await chip(page, "Read in the last 30 days").click();
    const stage = page.locator(".stage-3d");
    await stage.focus();
    await page.keyboard.press("ArrowRight");
    const picked = await page.locator(".stage-3d .pick-label .ref").textContent();
    for (let k = 0; k < 4; k++) await page.keyboard.press("Shift+ArrowRight");
    await expect.poll(() => toward(page)).toBeLessThan(0.9);
    await drawing(page, "2D").click();
    await expect(drawing(page, "2D")).toHaveAttribute("aria-pressed", "true");
    await expect(depthPick(page)).toHaveCount(0);
    await expect(page.locator(".stage-3d .depth-marker")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Front view" })).toHaveCount(0);
    await expect(sizeKey(page)).toContainText("Size: reads");
    // Neither a drag nor the turning keys turn it: back in 3D, the view still faces the front.
    await page.waitForTimeout(900);
    const box = await page.locator(".stage-3d canvas").boundingBox();
    await page.mouse.move(box.x + 40, box.y + 40);
    await page.mouse.down();
    await page.mouse.move(box.x + 340, box.y + 140, { steps: 8 });
    await page.mouse.up();
    await stage.focus();
    await page.keyboard.press("Shift+ArrowRight");
    await page.keyboard.press("ArrowUp");
    await drawing(page, "3D").click();
    await expect(page.locator(".stage-3d .depth-marker")).toHaveCount(1);
    assert.ok((await toward(page)) > 0.99);
    // The pick, the view and the filter are as they were.
    await expect(page.locator(".stage-3d .pick-label .ref")).toHaveText(picked);
    await expect(page.getByRole("tab", { name: "Use" })).toHaveAttribute("aria-selected", "true");
    await expect(chip(page, "Read in the last 30 days")).toHaveAttribute("aria-pressed", "true");
    assert.deepEqual(errors, []);
    await page.close();
  });

  await t.test("with reduced motion a pick, a change of depth and facing front are there at once", async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, reducedMotion: "reduce" });
    const page = await context.newPage();
    await page.route("**/api/graph", (route) => route.fulfill({ json: { ok: true, data: used } }));
    await ready(page);
    const frames = (n) =>
      page.evaluate(
        (count) =>
          new Promise((done) => {
            const next = (left) => (left ? requestAnimationFrame(() => next(left - 1)) : done());
            next(count);
          }),
        n,
      );
    const labelAt = () => page.locator(".stage-3d .pick-label").evaluate((el) => el.style.transform);
    const settled = async () => {
      await frames(3);
      const at = await labelAt();
      await page.waitForTimeout(900);
      assert.equal(await labelAt(), at);
    };
    await page.locator(".stage-3d").focus();
    await page.keyboard.press("ArrowRight");
    await expect(page.locator(".stage-3d .pick-label")).toBeVisible();
    await settled();
    await depthPick(page).selectOption({ label: "Age and status" });
    await settled();
    await page.locator(".stage-3d").focus();
    for (let k = 0; k < 3; k++) await page.keyboard.press("Shift+ArrowRight");
    await page.keyboard.press("0");
    await frames(3);
    assert.ok((await toward(page)) > 0.99);
    await context.close();
  });

  await t.test(
    "Replay: Tags is the default, 3D plays the same events on the 3D map, says what has no place, and is remembered",
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
      await expect(drawing.getByRole("button", { name: "Tags" })).toHaveAttribute("aria-pressed", "true");
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
      // Size is the events on an asset over the period; depth is akm's own until a figure is chosen; 2D has no depth.
      await expect(replay.locator(".stage-3d .size-key")).toContainText("Size: events in the period");
      await expect(replay.locator(".stage-3d .depth-key")).toHaveCount(0);
      await replay.getByRole("combobox", { name: "Depth shows" }).selectOption({ label: "Age and status" });
      await expect(replay.locator(".stage-3d .depth-key")).toContainText("front");
      await drawing.getByRole("button", { name: "2D" }).click();
      await expect(replay.locator(".stage-3d .depth-key")).toHaveCount(0);
      await expect(replay.locator(".stage-3d canvas")).toBeVisible();
      // 2D draws only what has been used so far: a group is named once one of its assets is used, and not before.
      const seek = (share) =>
        replay.getByRole("slider", { name: "Playhead" }).evaluate((el, part) => {
          el.value = String(Number(el.min) + (Number(el.max) - Number(el.min)) * part);
          el.dispatchEvent(new Event("input", { bubbles: true }));
        }, share);
      await expect(replay.locator(".stage-3d .group-name")).toHaveCount(1);
      await seek(0);
      await expect(replay.locator(".stage-3d .group-name")).toHaveCount(0);
      await seek(1);
      await expect(replay.locator(".stage-3d .group-name")).toHaveCount(1);
      await drawing.getByRole("button", { name: "3D" }).click();
      // The timeline key plays only the kinds chosen, and everything on the page counts only those.
      await replay.getByRole("button", { name: "Feedback" }).click();
      await expect(replay.locator(".figures")).toContainText("1events");
      await replay.getByRole("button", { name: "All events" }).click();
      await expect(replay.locator(".figures")).toContainText("4events");
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
      await drawing.getByRole("button", { name: "Tags" }).click();
      await expect(replay.locator(".mind-map")).toBeVisible();
      assert.deepEqual(errors, []);
      await page.close();
    },
  );
});
