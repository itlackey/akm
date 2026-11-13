// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium, expect } from "@playwright/test";
import { launchFixture, open } from "./support.mjs";

// The replay and the library map past their happy paths: responses in the wrong order, no WebGL, a library that
// changes under the page, and leaving while the map is moving.
test("visualizations survive late responses, no WebGL, a changed library and an early exit", {
  timeout: 240000,
}, async (t) => {
  const server = await launchFixture({ metrics: true, similarity: true });
  t.after(() => server.stop());
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const fresh = async (setup) => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await setup?.(page);
    return { page, errors };
  };
  const slider = (page) => page.getByRole("slider", { name: "Time" });
  const toEnd = (page) =>
    slider(page).evaluate((input) => {
      input.value = input.max;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

  await t.test("Replay: an earlier period's late answer does not replace the later one", async () => {
    const { page, errors } = await fresh(async (page) => {
      // The first (24 hours) answer arrives after the 7-day one, and says something the real data does not.
      await page.route("**/api/events?since=24h", async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 2500));
        await route.fulfill({
          json: {
            ok: true,
            data: {
              available: true,
              truncated: false,
              window: { since: new Date(Date.now() - 86_400_000).toISOString(), until: new Date().toISOString() },
              events: [
                {
                  id: 1,
                  at: new Date().toISOString(),
                  eventType: "search",
                  query: "stale period",
                  source: "user",
                  resultCount: 0,
                },
              ],
            },
          },
        });
      });
    });
    await open(page, server, "/activity/replay");
    await page.getByRole("combobox", { name: "Period" }).selectOption("7d");
    await expect(slider(page)).toBeVisible();
    await page.waitForTimeout(3500);
    await toEnd(page);
    const replay = page.getByRole("region", { name: "Activity replay", exact: true });
    await expect(replay).toContainText("missing restore steps");
    await expect(replay).not.toContainText("stale period");
    assert.deepEqual(errors, []);
    await page.close();
  });

  await t.test("Replay: the slider's end shows the events of the window's last minute", async () => {
    // A window that is not a whole number of minutes: the range input's last step falls short of its end.
    const until = Date.parse("2026-11-11T12:00:00.000Z");
    const since = until - 7 * 86_400_000 + 1;
    const { page, errors } = await fresh((page) =>
      page.route("**/api/events?since=7d", (route) =>
        route.fulfill({
          json: {
            ok: true,
            data: {
              available: true,
              truncated: false,
              window: { since: new Date(since).toISOString(), until: new Date(until).toISOString() },
              events: [
                {
                  id: 1,
                  at: new Date(until - 30_000).toISOString(),
                  eventType: "search",
                  query: "last minute query",
                  source: "user",
                  resultCount: 0,
                },
              ],
            },
          },
        }),
      ),
    );
    await open(page, server, "/activity/replay");
    await page.getByRole("combobox", { name: "Period" }).selectOption("7d");
    await expect(slider(page)).toBeVisible();
    await toEnd(page);
    await expect(page.getByRole("region", { name: "Activity replay", exact: true })).toContainText("last minute query");
    assert.deepEqual(errors, []);
    await page.close();
  });

  await t.test("Replay: without WebGL the page says so, and Play still moves the clock", async () => {
    const { page, errors } = await fresh((page) =>
      page.addInitScript(() => {
        const getContext = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = function (kind, ...rest) {
          return kind === "webgl2" ? null : getContext.call(this, kind, ...rest);
        };
      }),
    );
    await open(page, server, "/activity/replay");
    await expect(page.getByText("The figures, the latest events and the timeline below still play.")).toBeVisible();
    const before = Number(await slider(page).inputValue());
    await page.getByRole("combobox", { name: "Speed" }).selectOption({ label: "Fastest" });
    await page.getByRole("button", { name: "Play", exact: true }).click();
    await expect.poll(async () => Number(await slider(page).inputValue())).toBeGreaterThan(before);
    await page.getByRole("button", { name: "Pause", exact: true }).click();
    assert.deepEqual(errors, []);
    await page.close();
  });

  await t.test("Replay: a library that grew is drawn by a new map, not the old one", async () => {
    const { page, errors } = await fresh();
    await open(page, server, "/activity/replay");
    await expect(slider(page)).toBeVisible();
    // A new asset is written and indexed while the replay is open.
    const created = await server.call("/api/knowledge/create", {
      bundle: "personal",
      name: "replay-new-page",
      content: "---\ntitle: Replay new page\ndescription: Synthetic page added while the replay is open\n---\n# New\n",
    });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    await page.getByRole("combobox", { name: "Period" }).selectOption("7d");
    await expect(slider(page)).toBeVisible();
    await toEnd(page);
    await page.getByRole("button", { name: "Play", exact: true }).click();
    await page.waitForTimeout(500);
    await page.getByRole("button", { name: "Pause", exact: true }).click();
    assert.deepEqual(errors, []);
    await page.close();
  });

  await t.test("Library map: leaving while the arrangement moves leaves nothing running", async () => {
    const { page, errors } = await fresh((page) =>
      // Give every asset a position by meaning, so the page opens arranged by meaning and can move to bundles.
      page.route("**/api/graph", async (route) => {
        const response = await route.fetch();
        const body = await response.json();
        const count = body.data.nodes.ref.length;
        body.data.meaning = {
          embedded: count,
          xyz: Array.from({ length: count * 3 }, (_, i) => ((i * 37) % 200) - 100),
        };
        await route.fulfill({ response, json: body });
      }),
    );
    await open(page, server, "/library/map");
    const arrange = page.getByRole("combobox", { name: "Arrange" });
    await expect(arrange).toHaveValue("meaning");
    await arrange.selectOption("bundle");
    await page
      .getByRole("navigation", { name: "Library views" })
      .getByRole("link", { name: "Search", exact: true })
      .click();
    await expect(page).toHaveURL(/\/library\/search/);
    await page.waitForTimeout(1500);
    assert.deepEqual(errors, []);
    await page.close();
  });

  // A library the page is given instead of the fixture's: `nodes` of [ref, shows, placed], so the arrangement, the use
  // steps and the unplaced assets are exactly what each test says.
  const mapPayload = (nodes, { bundles = ["wiki", "notes"] } = {}) => ({
    available: true,
    note: "Synthetic library.",
    types: ["knowledge"],
    bundles,
    beliefs: [],
    emptyBundles: [],
    use: { since: "2026-08-15T00:00:00.000Z", source: "user" },
    unresolvedLinks: 2,
    kinds: ["xref"],
    nodes: {
      ref: nodes.map(([ref]) => ref),
      title: nodes.map(([ref]) => ref),
      type: nodes.map(() => 0),
      bundle: nodes.map(([ref]) => (ref.startsWith(`${bundles[0]}//`) ? 0 : 1)),
      belief: nodes.map(() => -1),
      shows: nodes.map(([, shows]) => shows),
      searches: nodes.map(() => 0),
    },
    links: { from: [0], to: [1], kind: [0] },
    meaning: {
      embedded: nodes.filter(([, , placed]) => placed).length,
      xyz: nodes.flatMap(([, , placed], i) => (placed ? [i * 10, (i % 3) * 20, (i % 5) * 15] : [null, null, null])),
    },
  });
  const withGraph = (page, payload) =>
    page.route("**/api/graph", (route) => route.fulfill({ json: { ok: true, data: payload } }));
  const library = [
    ["wiki//knowledge/a", 40, true],
    ["wiki//knowledge/b", 9, true],
    ["wiki//knowledge/c", 3, true],
    ["notes//knowledge/d", 1, true],
    ["notes//knowledge/e", 0, false],
    ["notes//knowledge/f", 0, false],
    ["wiki//knowledge/g", 0, true],
    ["notes//knowledge/h", 5, false],
  ];

  await t.test("Library map: assets with no position by meaning are not drawn, but the table lists them", async () => {
    const { page, errors } = await fresh((page) => withGraph(page, mapPayload(library)));
    await open(page, server, "/library/map");
    await expect(page.getByLabel(/^Map of 8 assets/)).toBeVisible();
    // The count names the narrowing next to the total, and the legend says what is missing.
    await expect(page.getByRole("status").filter({ hasText: "8 of 8 assets" })).toContainText("3 not placed");
    await expect(page.locator(".map-legend")).toContainText("3 assets have no position by meaning and are not drawn");
    // The keyboard cursor visits only what is drawn: step through every point it can reach.
    const live = page.locator(".graph-stage [role=status]");
    await page.getByLabel(/^Map of 8 assets/).focus();
    const visited = new Set();
    for (let step = 0; step < 8; step++) {
      await page.keyboard.press("]");
      visited.add((await live.textContent()) ?? "");
    }
    assert.ok(
      [...visited].every((label) => !/notes\/knowledge\/(e|f|h)$/.test(label)),
      [...visited].join(" | "),
    );
    assert.ok(visited.size >= 3, [...visited].join(" | "));
    // The table lists all eight, marks the three, and cannot show them on the map.
    await page.getByRole("button", { name: "Table", exact: true }).click();
    await expect(page.getByText("Rows 1–8 of 8")).toBeVisible();
    const table = page.getByRole("table");
    await expect(table.getByRole("row")).toHaveCount(9);
    await expect(table.getByText("not placed")).toHaveCount(3);
    const unplaced = table.getByRole("row", { name: /knowledge\/e/ }).getByRole("button");
    await expect(unplaced).toBeDisabled();
    await expect(unplaced).toHaveAttribute("title", /no position by meaning/);
    // A placed asset's button returns to the map with that asset selected.
    await table
      .getByRole("row", { name: /knowledge\/b/ })
      .getByRole("button", { name: /Show/ })
      .click();
    await expect(page.getByLabel(/^Map of 8 assets/)).toBeVisible();
    await expect(page.getByRole("heading", { name: "wiki/knowledge/b" })).toBeVisible();
    assert.deepEqual(errors, []);
    await page.close();
  });

  await t.test("Library map: the table pages by a hundred and sorts by its columns", async () => {
    const many = Array.from({ length: 250 }, (_, n) => [
      `wiki//knowledge/n${String(n).padStart(3, "0")}`,
      n % 17,
      false,
    ]);
    const { page, errors } = await fresh((page) =>
      withGraph(page, {
        ...mapPayload(many, { bundles: ["wiki"] }),
        meaning: null,
        links: { from: [], to: [], kind: [] },
      }),
    );
    await open(page, server, "/library/map");
    await page.getByRole("button", { name: "Table", exact: true }).click();
    await expect(page.getByText("Rows 1–100 of 250")).toBeVisible();
    await expect(page.getByRole("table").getByRole("row")).toHaveCount(101);
    await page.getByRole("button", { name: "Next" }).click();
    await expect(page.getByText("Rows 101–200 of 250")).toBeVisible();
    await page.getByRole("button", { name: "Next" }).click();
    await expect(page.getByText("Rows 201–250 of 250")).toBeVisible();
    await expect(page.getByRole("button", { name: "Next" })).toBeDisabled();
    // Sorting returns to the first page; the sorted column says so.
    const shown = page.getByRole("columnheader", { name: "Shown" });
    await expect(shown).toHaveAttribute("aria-sort", "descending");
    await shown.getByRole("button").click();
    await expect(shown).toHaveAttribute("aria-sort", "ascending");
    await expect(page.getByText("Rows 1–100 of 250")).toBeVisible();
    const firstShown = page.getByRole("table").getByRole("row").nth(1).getByRole("cell").nth(2);
    await expect(firstShown).toHaveText("0");
    const asset = page.getByRole("columnheader", { name: "Asset" });
    await asset.getByRole("button").click();
    await expect(asset).toHaveAttribute("aria-sort", "ascending");
    await expect(shown).toHaveAttribute("aria-sort", "none");
    await expect(page.getByRole("table").getByRole("row").nth(1).getByRole("link")).toHaveText("knowledge/n000");
    assert.deepEqual(errors, []);
    await page.close();
  });

  await t.test("Library map: ?select= opens with that asset selected, where it is placed", async () => {
    const { page, errors } = await fresh((page) => withGraph(page, mapPayload(library)));
    // knowledge/e has no position by meaning: the map opens by bundle so the asset can be drawn.
    await open(page, server, `/library/map?select=${encodeURIComponent("notes//knowledge/e")}`);
    await expect(page.getByRole("combobox", { name: "Arrange" })).toHaveValue("bundle");
    await expect(page.getByRole("heading", { name: "notes/knowledge/e" })).toBeVisible();
    await page.goto(`${server.origin}/library/map?select=${encodeURIComponent("wiki//knowledge/b")}`);
    await expect(page.getByRole("combobox", { name: "Arrange" })).toHaveValue("meaning");
    await expect(page.getByRole("heading", { name: "wiki/knowledge/b" })).toBeVisible();
    await page.goto(`${server.origin}/library/map?select=${encodeURIComponent("wiki//knowledge/missing")}`);
    await expect(page.getByText("No asset “wiki//knowledge/missing” is on the map.")).toBeVisible();
    assert.deepEqual(errors, []);
    await page.close();
  });

  await t.test("Library map: Use colouring prints its steps and bounds, never shown first", async () => {
    const shows = [0, 0, 1, 1, 2, 3, 5, 8, 13, 40];
    const nodes = shows.map((n, i) => [`wiki//knowledge/u${i}`, n, true]);
    const { page, errors } = await fresh((page) => withGraph(page, mapPayload(nodes, { bundles: ["wiki"] })));
    await open(page, server, "/library/map");
    await page.getByRole("combobox", { name: "Colour" }).selectOption("use");
    const steps = page.locator(".use-steps li");
    await expect(steps).toHaveText(["Never shown2", "12", "2–42", "5–122", "13+2"]);
    // The use window and the server's note are printed, and the size key matches the drawing's largest value.
    await expect(page.locator(".map-side")).toContainText("Reads by you and your agents since");
    await expect(page.locator(".map-side")).toContainText("scheduled tasks and Improve are not counted");
    await expect(page.locator(".size-key li")).toHaveText(["0", "10", "40"]);
    assert.deepEqual(errors, []);
    await page.close();
  });

  await t.test("Library map: at phone width the legend folds behind a button and leaves the map clear", async () => {
    const { page, errors } = await fresh((page) => withGraph(page, mapPayload(library)));
    await page.setViewportSize({ width: 390, height: 844 });
    await open(page, server, "/library/map");
    const legend = page.locator(".map-legend");
    const stage = page.locator(".map-stage");
    await expect(page.getByRole("button", { name: "Legend" })).toHaveAttribute("aria-expanded", "false");
    const [covered, whole] = await Promise.all([legend.boundingBox(), stage.boundingBox()]);
    assert.ok(covered.height < 80, `the collapsed legend is ${covered.height}px tall`);
    assert.ok(covered.height / whole.height < 0.15);
    await page.getByRole("button", { name: "Legend" }).click();
    await expect(legend).toContainText("Size: times shown");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(errors, []);
    await page.close();
  });
});
