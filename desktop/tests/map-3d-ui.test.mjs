// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import assert from "node:assert/strict";
import { test } from "node:test";
import AxeBuilder from "@axe-core/playwright";
import { chromium, expect } from "@playwright/test";
import { go, launchFixture, open, pick } from "./support.mjs";

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

  await t.test("a chosen asset's legend names the levels that reach anything, with the assets at each", async () => {
    const { page, errors } = await fresh();
    await open(page, server, "/library/map");
    await expect(page.locator(".stage-3d canvas")).toBeVisible();
    await page.waitForTimeout(500);
    const at = await findPoint(page);
    await page.mouse.click(at.x, at.y);
    const from = Number((await page.locator(".stage-3d .pick-label .ref").textContent()).match(/n(\d)$/)[1]);
    const levels = page.locator(".levels li");
    // The map, its key and the new controls pass the same accessibility rules as the rest of the app.
    const results = await new AxeBuilder({ page })
      .include(".map-page")
      .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
      .analyze();
    assert.deepEqual(
      results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(" ")}`),
      [],
    );
    // A level that reaches nothing is not listed.
    await expect(levels).toHaveText(
      ["1st level", "2nd level", "3rd level"]
        .map((name, k) => [name, inChain(from, k + 1)])
        .filter(([, n]) => n)
        .map(([name, n]) => `${name}: ${n} ${n === 1 ? "asset" : "assets"}`),
    );
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
    // A level that reaches nothing is not listed.
    await expect(page.locator(".levels li")).toHaveCount(1);
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
  const filters = (page) => page.locator(".show-menu");
  const side = (page) => page.getByRole("complementary", { name: "Figures" });
  const drawing = (page, name) =>
    page.getByRole("group", { name: "Drawing" }).getByRole("button", { name, exact: true });
  /** Where the last group's name is drawn: it moves when the view turns, zooms or resets. */
  const nameAt = (page) =>
    page
      .locator(".stage-3d .group-name")
      .last()
      .evaluate((el) => el.style.transform);
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

  await t.test("a question's filter lights what it finds, counts it on each group and lists it", async () => {
    const { page, errors } = await fresh(used);
    await ready(page);
    // Contents opens with no filter: the groups, and a filter per asset type and for what nothing links to.
    assert.deepEqual(await filters(page).locator("label").allTextContents(), [
      "Knowledge10",
      "Not linked to anything2",
    ]);
    await expect(filters(page).locator("label:has(input:checked)")).toHaveCount(0);
    await expect(side(page).getByRole("heading", { level: 3 })).toHaveText("Groups by meaning");
    await expect(side(page).locator(".rows li")).toHaveCount(2);
    await pick(page, "Not linked to anything");
    await expect(side(page).locator(".read-row")).toHaveText([
      "knowledge/chain/n83 reads",
      "knowledge/chain/n93 reads",
    ]);
    // Both are in the second group: its name says so, and it is the only group listed under them.
    await expect(page.locator(".stage-3d .group-name", { hasText: "2 unlinked" })).toHaveCount(1);
    await expect(page.locator(".stage-3d .group-name", { hasText: "0 unlinked" })).toHaveCount(1);
    const where = side(page).locator("section", { hasText: "Where they are, by group" });
    await expect(where.locator("li")).toHaveText([/2 of 5$/]);
    // Problems opens on the outdated assets agents are still given; a filter akm has no figures for is not offered.
    await page.getByRole("tab", { name: "Problems" }).click();
    assert.deepEqual(await filters(page).locator("label").allTextContents(), [
      "Outdated, still read1",
      "Disliked0",
      "Outdated, unread0",
    ]);
    await expect(filters(page).locator("label:has(input:checked)")).toHaveText("Outdated, still read1");
    await expect(side(page).locator(".read-row")).toHaveText(["knowledge/chain/n0superseded · 3 reads"]);
    await axe(page);
    // Use opens on what there is to act on: nothing is unread here, so the most read.
    await page.getByRole("tab", { name: "Use" }).click();
    await expect(filters(page).locator("label:has(input:checked)")).toHaveText("Most read10");
    await expect(filters(page).locator("label", { hasText: /^Not read, untouched/ }).locator("input")).toBeDisabled();
    assert.deepEqual(errors, []);
    await page.close();
  });

  await t.test("without usage history Use offers no filter, and Problems only what it can tell", async () => {
    // One deprecated asset, and no usage: whether it is still read is not known, so it is listed as outdated only.
    const { page, errors } = await fresh({
      ...chain,
      beliefs: ["deprecated"],
      nodes: { ...chain.nodes, belief: [0, ...new Array(N - 1).fill(-1)] },
    });
    await ready(page);
    await page.getByRole("tab", { name: "Use" }).click();
    await expect(filters(page).locator("label")).toHaveCount(0);
    await page.getByRole("tab", { name: "Problems" }).click();
    assert.deepEqual(await filters(page).locator("label").allTextContents(), ["Outdated1"]);
    assert.deepEqual(errors, []);
    await page.close();
  });

  await t.test(
    "a chosen group scopes the filters and says so; a chosen asset shows what is wrong with it",
    async () => {
      const { page, errors } = await fresh(used);
      await ready(page);
      await side(page).getByRole("button").first().click();
      await expect(side(page).getByRole("heading", { level: 2 })).toBeVisible();
      await expect(side(page)).toContainText("Group by meaning · 5 assets");
      const scope = page.getByRole("button", { name: /^In / });
      await expect(scope).toBeVisible();
      await expect(filters(page).locator("label", { hasText: "Knowledge" })).toHaveText("Knowledge5");
      await scope.click();
      await expect(scope).toHaveCount(0);
      await expect(filters(page).locator("label", { hasText: "Knowledge" })).toHaveText("Knowledge10");
      // An asset: choosing it leaves the filters' scope alone and replaces the list with the asset.
      await page.getByRole("tab", { name: "Problems" }).click();
      await page.locator(".stage-3d").focus();
      await page.keyboard.press("ArrowRight");
      await expect(page.locator(".stage-3d .pick-label .ref")).toHaveText("wiki//knowledge/chain/n0");
      await expect(page.locator(".stage-3d .pick-label .value")).toContainText("read 3 times, last 2 days ago");
      await expect(scope).toHaveCount(0);
      await expect(side(page).getByRole("heading", { level: 2 })).toHaveText("knowledge/chain/n0");
      await expect(side(page).locator(".wrong")).toContainText(
        "Outdated: superseded. Open it to retire it or fix the link.",
      );
      await expect(side(page).getByRole("link", { name: "Open", exact: true })).toHaveAttribute(
        "href",
        /\/library\/search\?ref=/,
      );
      await expect(side(page).locator(".figures")).toContainText("read 3 times, last 2 days ago");
      await expect(side(page).locator(".figures")).toContainText("10 days ago");
      // No feedback was given, so none is shown.
      await expect(side(page).locator(".figures")).not.toContainText("Feedback");
      // Problems joins assets only by replacement, contradiction and near-identity, and this one has none of those.
      await expect(side(page).locator("section", { hasText: "Joined to" })).toHaveCount(0);
      await axe(page);
      await side(page).getByRole("button", { name: "Close" }).click();
      await expect(side(page).locator(".read-row")).toHaveText(["knowledge/chain/n0superseded · 3 reads"]);
      assert.deepEqual(errors, []);
      await page.close();
    },
  );

  await t.test("size is links in Contents and reads in Use and Problems, with a key on the map", async () => {
    const { page, errors } = await fresh(used);
    await ready(page);
    const sizeKey = page.locator(".stage-3d .size-key");
    await expect(sizeKey).toContainText("Size: links");
    await expect(sizeKey.locator("li")).toHaveText(["0", "1", "2"]);
    for (const name of ["Use", "Problems"]) {
      await page.getByRole("tab", { name }).click();
      await expect(sizeKey).toContainText("Size: reads");
      await expect(sizeKey.locator("li")).toHaveText(["0", "1", "3"]);
    }
    assert.deepEqual(errors, []);
    await page.close();
  });

  await t.test("the map opens in 2D, which cannot be turned; 3D turns; keys and buttons zoom and reset", async () => {
    const { page, errors } = await fresh(used);
    await ready(page);
    await expect(drawing(page, "2D")).toHaveAttribute("aria-pressed", "true");
    const stage = page.locator(".stage-3d");
    const home = await nameAt(page);
    // Neither the turning keys nor a drag turn the plane.
    await stage.focus();
    await page.keyboard.press("Shift+ArrowRight");
    await page.keyboard.press("ArrowUp");
    await page.waitForTimeout(300);
    assert.equal(await nameAt(page), home);
    // Zoom by key and by button, and back to where the map opens.
    await page.keyboard.press("+");
    await expect.poll(() => nameAt(page)).not.toBe(home);
    const zoomed = await nameAt(page);
    await page.getByRole("button", { name: "Zoom out" }).click();
    await expect.poll(() => nameAt(page)).not.toBe(zoomed);
    await page.getByRole("button", { name: "Reset view" }).click();
    await expect.poll(() => nameAt(page)).toBe(home);
    // 3D: the same points with their depth, and the keys turn it.
    await drawing(page, "3D").click();
    await page.waitForTimeout(900);
    const before = await nameAt(page);
    await stage.focus();
    await page.keyboard.press("Shift+ArrowRight");
    await expect.poll(() => nameAt(page)).not.toBe(before);
    // The left and right keys alone still step through a group's assets.
    await page.keyboard.press("ArrowRight");
    const label = page.locator(".stage-3d .pick-label .ref");
    const first = await label.textContent();
    await page.keyboard.press("ArrowRight");
    await expect(label).not.toHaveText(first);
    assert.deepEqual(errors, []);
    await page.close();
  });

  await t.test("with reduced motion a pick and a change of drawing are there at once", async () => {
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
    await drawing(page, "3D").click();
    await settled();
    await context.close();
  });

  await t.test("opening an asset and coming back returns to the same question, filter and drawing", async () => {
    const { page, errors } = await fresh(used);
    await ready(page);
    await page.getByRole("tab", { name: "Use" }).click();
    await drawing(page, "3D").click();
    await expect(filters(page).locator("label:has(input:checked)")).toHaveText("Most read10");
    await side(page).locator(".read-row a").first().click();
    await expect(page).toHaveURL(/\/library\/search\?ref=/);
    await page.goBack();
    await expect(page.locator(".stage-3d canvas")).toBeVisible();
    await expect(page.getByRole("tab", { name: "Use" })).toHaveAttribute("aria-selected", "true");
    await expect(drawing(page, "3D")).toHaveAttribute("aria-pressed", "true");
    await expect(filters(page).locator("label:has(input:checked)")).toHaveText("Most read10");
    assert.deepEqual(errors, []);
    await page.close();
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
      // Size is the events on an asset over the period.
      await expect(replay.locator(".stage-3d .size-key")).toContainText("Size: events in the period");
      // 2D draws only what has been used so far: a group is named once one of its assets is used, and not before.
      await drawing.getByRole("button", { name: "2D" }).click();
      await expect(replay.locator(".stage-3d canvas")).toBeVisible();
      const seek = (share) =>
        replay.getByRole("slider", { name: "Playhead" }).evaluate((el, part) => {
          el.value = String(Number(el.min) + (Number(el.max) - Number(el.min)) * part);
          el.dispatchEvent(new Event("input", { bubbles: true }));
        }, share);
      await expect(replay.locator(".stage-3d .group-name")).toHaveCount(1);
      await seek(0);
      await expect(replay.locator(".stage-3d .group-name")).toHaveCount(0);
      await seek(1);
      // Choosing the group lists its events so far, each a link to its asset; closing brings the lists back.
      await replay.locator(".stage-3d .group-name").press("Enter");
      const chosen = replay.locator(".replay-side");
      await expect(chosen.getByRole("heading", { level: 2 })).toBeVisible();
      await expect(chosen).toContainText("Group by meaning · 5 assets · 2 events so far");
      await expect(chosen.locator(".log a").first()).toHaveAttribute("href", /\/library\/search\?ref=/);
      await chosen.getByRole("button", { name: "Close" }).click();
      await expect(replay.getByRole("heading", { name: "Feedback given so far" })).toBeVisible();
      await expect(replay.locator(".replay-side")).toContainText("knowledge/chain/n2");
      await drawing.getByRole("button", { name: "3D" }).click();
      // The key names every mark, and what has no place is counted, not dropped.
      const key = replay.getByRole("list", { name: "Key to the 3D map" });
      for (const name of ["Used, by type", "Not used yet", "Ring = current event", "Read", "Search result"])
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
