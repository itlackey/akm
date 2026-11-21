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
  const depthNote = (page) => page.locator(".stage-3d .depth-note");
  const depthPick = (page) => page.getByRole("combobox", { name: "Depth" });
  /** How far the scene's front points at the viewer: 1 facing, -1 facing away. */
  const toward = async (page) => Number(await page.locator(".stage-3d .depth-marker").getAttribute("data-toward"));
  const ready = async (page) => {
    await open(page, server, "/library/map");
    await expect(page.locator(".stage-3d canvas")).toBeVisible();
    await page.waitForTimeout(500);
  };

  await t.test(
    "depth is a lens: each view opens on its own, Problems flipped, and the key says what is in front",
    async () => {
      const { page, errors } = await fresh(used);
      await ready(page);
      const flip = page.getByRole("button", { name: "Flip", exact: true });
      await expect(depthPick(page)).toHaveValue("meaning");
      await expect(depthNote(page)).toHaveText("Depth is likeness in meaning, as left to right and up and down are.");
      await expect(flip).toBeDisabled();
      await page.getByRole("tab", { name: "Use" }).click();
      await expect(depthPick(page)).toHaveValue("recency");
      await expect(depthNote(page)).toContainText("read in the last 30 days at the front");
      await expect(flip).toHaveAttribute("aria-pressed", "false");
      // Problems brings what it is about to the front; Flip puts it back.
      await page.getByRole("tab", { name: "Problems" }).click();
      await expect(depthPick(page)).toHaveValue("lifecycle");
      await expect(flip).toHaveAttribute("aria-pressed", "true");
      await expect(depthNote(page)).toContainText("superseded, contradicted or deprecated at the front");
      await flip.click();
      await expect(depthNote(page)).toContainText("superseded, contradicted or deprecated at the back");
      // A chosen lens lasts until the view changes, and opens unflipped.
      await depthPick(page).selectOption({ label: "Feedback" });
      await expect(depthNote(page)).toContainText("more positive feedback than negative at the front");
      await page.getByRole("tab", { name: "Contents" }).click();
      await expect(depthPick(page)).toHaveValue("meaning");
      // With a lens and a pick, the map passes the same accessibility rules.
      await depthPick(page).selectOption({ label: "Last read" });
      await page.locator(".stage-3d").focus();
      await page.keyboard.press("ArrowRight");
      await expect(page.locator(".stage-3d .pick-label")).toBeVisible();
      const results = await new AxeBuilder({ page })
        .include(".map-page")
        .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
        .analyze();
      assert.deepEqual(
        results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(" ")}`),
        [],
      );
      assert.deepEqual(errors, []);
      await page.close();
    },
  );

  await t.test("a lens akm has no figures for cannot be chosen, and its option says why", async () => {
    const { page, errors } = await fresh();
    await ready(page);
    const option = depthPick(page).locator("option", { hasText: "Last read" });
    await expect(option).toHaveAttribute("disabled", "");
    await expect(option).toHaveText("Last read (no usage history is available)");
    // Use would open on Last read; without usage it stays on Meaning.
    await page.getByRole("tab", { name: "Use" }).click();
    await expect(depthPick(page)).toHaveValue("meaning");
    assert.deepEqual(errors, []);
    await page.close();
  });

  await t.test("hover and the pick name an asset with the figures its colour and depth stand for", async () => {
    const { page, errors } = await fresh(used);
    await ready(page);
    await page.getByRole("tab", { name: "Use" }).click();
    await findPoint(page);
    await expect(page.locator(".stage-3d .tip")).toContainText("read 3 times, last 2 days ago");
    // Colour and depth that say the same thing are said once; a second variable is added to it.
    await page.locator(".stage-3d").focus();
    await page.keyboard.press("ArrowRight");
    const value = page.locator(".stage-3d .pick-label .value");
    await expect(value).toHaveText(" · read 3 times, last 2 days ago");
    await depthPick(page).selectOption({ label: "Feedback" });
    await expect(value).toHaveText(" · read 3 times, last 2 days ago · 0 positive, 0 negative feedback");
    assert.deepEqual(errors, []);
    await page.close();
  });

  await t.test(
    "the marker names the front from any angle; the keyboard turns and zooms, and 0 faces the front",
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
      const before = await nameAt();
      const turned = await toward(page);
      await page.keyboard.press("+");
      await expect.poll(nameAt).not.toBe(before);
      assert.ok(Math.abs((await toward(page)) - turned) < 0.05);
      // Face front keeps the choice and the lens; so does the button.
      await page.getByRole("tab", { name: "Use" }).click();
      await stage.focus();
      await page.keyboard.press("ArrowRight");
      await expect(page.locator(".stage-3d .pick-label")).toBeVisible();
      await page.keyboard.press("0");
      await expect.poll(() => toward(page)).toBeGreaterThan(0.99);
      for (let k = 0; k < 4; k++) await page.keyboard.press("Shift+ArrowLeft");
      await expect.poll(() => toward(page)).toBeLessThan(0.9);
      await page.getByRole("button", { name: "Face front" }).click();
      await expect.poll(() => toward(page)).toBeGreaterThan(0.99);
      await expect(page.locator(".stage-3d .pick-label")).toBeVisible();
      await expect(depthPick(page)).toHaveValue("recency");
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

  await t.test(
    "Flatten draws the same points in one plane: no turning, no depth, and the choices survive it",
    async () => {
      const { page, errors } = await fresh(used);
      await ready(page);
      await page.getByRole("tab", { name: "Use" }).click();
      const stage = page.locator(".stage-3d");
      await stage.focus();
      await page.keyboard.press("ArrowRight");
      const picked = await page.locator(".stage-3d .pick-label .ref").textContent();
      for (let k = 0; k < 4; k++) await page.keyboard.press("Shift+ArrowRight");
      await expect.poll(() => toward(page)).toBeLessThan(0.9);
      const flatten = page.getByRole("button", { name: "Flatten" });
      await flatten.click();
      await expect(flatten).toHaveAttribute("aria-pressed", "true");
      await expect(depthNote(page)).toContainText("Flattened");
      await expect(depthPick(page)).toBeDisabled();
      await expect(depthPick(page)).toHaveAttribute("title", "Depth is off while flattened");
      await expect(page.getByRole("button", { name: "Flip", exact: true })).toBeDisabled();
      await expect(page.locator(".stage-3d .depth-marker")).toHaveCount(0);
      await expect(page.locator(".map-stage")).toContainText("turning is off while flattened");
      // Neither a drag nor the turning keys turn it: unflattened, the view still faces the front.
      await page.waitForTimeout(900);
      const box = await page.locator(".stage-3d canvas").boundingBox();
      await page.mouse.move(box.x + 40, box.y + 40);
      await page.mouse.down();
      await page.mouse.move(box.x + 340, box.y + 140, { steps: 8 });
      await page.mouse.up();
      await stage.focus();
      await page.keyboard.press("Shift+ArrowRight");
      await page.keyboard.press("ArrowUp");
      await flatten.click();
      await expect(page.locator(".stage-3d .depth-marker")).toHaveCount(1);
      assert.ok((await toward(page)) > 0.99);
      // The pick, the view and the lens are as they were.
      await expect(page.locator(".stage-3d .pick-label .ref")).toHaveText(picked);
      await expect(page.getByRole("tab", { name: "Use" })).toHaveAttribute("aria-selected", "true");
      await expect(depthPick(page)).toHaveValue("recency");
      await expect(depthPick(page)).toBeEnabled();
      assert.deepEqual(errors, []);
      await page.close();
    },
  );

  await t.test("with reduced motion a pick, a lens and Face front are there at once", async () => {
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
    await depthPick(page).selectOption({ label: "Lifecycle" });
    await settled();
    for (let k = 0; k < 3; k++) await page.keyboard.press("Shift+ArrowRight");
    await page.keyboard.press("0");
    await frames(3);
    assert.ok((await toward(page)) > 0.99);
    await context.close();
  });

  await t.test("the key and the Type filter narrow the map, and say how many assets they keep", async () => {
    const { page, errors } = await fresh(used);
    await ready(page);
    const kept = page.getByRole("status").filter({ hasText: "of 10 assets" });
    await expect(kept).toHaveCount(0);
    await page.getByRole("tab", { name: "Problems" }).click();
    const outdated = page.getByRole("button", { name: "Superseded, contradicted or deprecated" });
    await outdated.click();
    await expect(outdated).toHaveAttribute("aria-pressed", "true");
    await expect(kept).toHaveText("1 of 10 assets");
    await page.getByRole("button", { name: "No problem recorded" }).click();
    await expect(outdated).toHaveAttribute("aria-pressed", "false");
    await expect(kept).toHaveText("9 of 10 assets");
    // Choosing it again shows everything, and another view starts with nothing chosen.
    await page.getByRole("button", { name: "No problem recorded" }).click();
    await expect(kept).toHaveCount(0);
    await outdated.click();
    await page.getByRole("tab", { name: "Use" }).click();
    await expect(kept).toHaveCount(0);
    await page.getByRole("button", { name: "Read in the last 30 days" }).click();
    await expect(kept).toHaveText("10 of 10 assets");
    // Type lists only the families the bundle holds.
    const type = page.getByRole("combobox", { name: "Type" });
    await expect(type.locator("option")).toHaveText(["All types", "Knowledge"]);
    await type.selectOption({ label: "Knowledge" });
    await expect(kept).toHaveText("10 of 10 assets");
    await page.getByRole("button", { name: "Reset" }).click();
    await expect(type).toHaveValue("-1");
    await expect(kept).toHaveCount(0);
    assert.deepEqual(errors, []);
    await page.close();
  });

  await t.test("size stands for a figure the user chooses, and the key and the labels say which", async () => {
    const { page, errors } = await fresh(used);
    await ready(page);
    const size = page.getByRole("combobox", { name: "Size" });
    await expect(size).toHaveValue("same");
    await expect(depthNote(page)).not.toContainText("Size:");
    // Use opens sized by reads.
    await page.getByRole("tab", { name: "Use" }).click();
    await expect(size).toHaveValue("reads");
    await expect(depthNote(page)).toContainText(
      "Size: more reads, larger; the largest has 3 reads. A nearer point also draws larger.",
    );
    await size.selectOption({ label: "Links" });
    await expect(depthNote(page)).toContainText("Size: more links, larger; the largest has 2 links.");
    await page.locator(".stage-3d").focus();
    await page.keyboard.press("ArrowRight");
    await expect(page.locator(".stage-3d .pick-label .value")).toContainText(/ · \d links?$/);
    // Flattened, nothing is nearer than anything else.
    await page.getByRole("button", { name: "Flatten" }).click();
    await expect(depthNote(page)).toContainText("the largest has 2 links.");
    await expect(depthNote(page)).not.toContainText("nearer point");
    await page.getByRole("tab", { name: "Contents" }).click();
    await expect(size).toHaveValue("same");
    assert.deepEqual(errors, []);
    await page.close();
  });

  await t.test(
    "Replay: Tags is the default, Points plays the same events on the 3D map, says what has no place, and is remembered",
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
      await drawing.getByRole("button", { name: "Points" }).click();
      await expect(drawing.getByRole("button", { name: "Points" })).toHaveAttribute("aria-pressed", "true");
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
      // Depth is akm's own here until a lens is chosen, and the key says which.
      const depthNote = replay.locator(".stage-3d .depth-note");
      await expect(depthNote).toContainText("Depth is likeness in meaning");
      await replay.getByRole("combobox", { name: "Depth" }).selectOption({ label: "Lifecycle" });
      await expect(depthNote).toContainText("at the front");
      await replay.getByRole("button", { name: "Flatten" }).click();
      await expect(depthNote).toContainText("Flattened");
      await replay.getByRole("button", { name: "Flatten" }).click();
      await replay.getByRole("combobox", { name: "Size" }).selectOption({ label: "Events in the period" });
      await expect(depthNote).toContainText("Size: more events in the period, larger; the largest has 1.");
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
