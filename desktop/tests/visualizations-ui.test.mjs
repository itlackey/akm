// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium, expect } from "@playwright/test";
import { launchFixture, open } from "./support.mjs";

// The replay and the library map: responses in the wrong order, no WebGL, the four views of the library map, and
// leaving while a picture is moving.
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
    // The replay opens at the end; Play starts again from the beginning, so the clock drops, then moves forward.
    const before = Number(await slider(page).inputValue());
    await page.getByRole("combobox", { name: "Speed" }).selectOption({ label: "Fast (4×)" });
    await page.getByRole("button", { name: "Play", exact: true }).click();
    await expect.poll(async () => Number(await slider(page).inputValue())).toBeLessThan(before);
    const first = Number(await slider(page).inputValue());
    await expect.poll(async () => Number(await slider(page).inputValue())).toBeGreaterThan(first);
    await page.getByRole("button", { name: "Pause", exact: true }).click();
    assert.deepEqual(errors, []);
    await page.close();
  });

  await t.test("Replay: it opens at the end with full figures, and a new period reads only the events", async () => {
    const { page, errors } = await fresh();
    const requests = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.pathname === "/api/graph" || url.pathname === "/api/events") requests.push(url.pathname + url.search);
    });
    await open(page, server, "/activity/replay");
    await expect(slider(page)).toBeVisible();
    // Opens at the end of the period: the slider is at its maximum and the totals are full.
    await expect
      .poll(async () => (await slider(page).inputValue()) === (await slider(page).getAttribute("max")))
      .toBe(true);
    const replay = page.getByRole("region", { name: "Activity replay", exact: true });
    await expect(replay.getByText("searches", { exact: true })).toBeVisible();
    await expect(replay).toContainText("Plays the whole period in about 1 minute");
    await expect(replay).toContainText("Tallest bar =");
    await page.getByRole("combobox", { name: "Period" }).selectOption("7d");
    await expect(slider(page)).toBeVisible();
    await toEnd(page);
    await page.getByRole("button", { name: "Play", exact: true }).click();
    await page.waitForTimeout(500);
    await page.getByRole("button", { name: "Pause", exact: true }).click();
    assert.equal(requests.filter((r) => r.startsWith("/api/graph")).length, 1, requests.join(" "));
    assert.deepEqual(
      requests.filter((r) => r.startsWith("/api/events")),
      ["/api/events?since=24h", "/api/events?since=7d"],
    );
    assert.deepEqual(errors, []);
    await page.close();
  });

  await t.test("Replay: a graph that is not available shows its note, not an empty map", async () => {
    const { page, errors } = await fresh((page) =>
      page.route("**/api/graph", (route) =>
        route.fulfill({ json: { ok: true, data: { available: false, note: "Synthetic: no index here." } } }),
      ),
    );
    await open(page, server, "/activity/replay");
    await expect(page.getByText("Synthetic: no index here.")).toBeVisible();
    await expect(page.getByText("assets used")).toHaveCount(0);
    assert.deepEqual(errors, []);
    await page.close();
  });

  // A library the page is given instead of the fixture's: two topics, an asset with no embedding, one link inside a
  // topic and one across, and one of each problem.
  const day = 86_400_000;
  const ago = (days) => new Date(Date.now() - days * day).toISOString();
  const mapPayload = {
    available: true,
    note: "Synthetic library.",
    types: ["knowledge", "memory"],
    bundles: ["wiki", "notes"],
    beliefs: ["superseded"],
    emptyBundles: [],
    use: { since: ago(90), source: "user" },
    unresolvedLinks: 0,
    kinds: ["xref"],
    nodes: {
      ref: [
        "wiki//knowledge/deploy/a",
        "wiki//knowledge/deploy/b",
        "notes//memories/deploy/c",
        "wiki//knowledge/auth/d",
        "notes//memories/auth/e",
        "notes//memories/auth/f",
        "notes//memories/misc/g",
      ],
      title: ["A", "B", "C", "D", "E", "F", "G"],
      type: [0, 0, 1, 0, 1, 1, 1],
      bundle: [0, 0, 1, 0, 1, 1, 1],
      belief: [-1, 0, -1, -1, -1, -1, -1],
      shows: [9, 0, 2, 0, 0, 1, 0],
      searches: [0, 0, 0, 0, 0, 0, 0],
      lastShownAt: [ago(2), null, ago(60), null, null, ago(10), null],
      modifiedAt: [ago(5), ago(400), ago(30), ago(20), ago(500), ago(1), ago(900)],
      positive: [1, 0, 0, 0, 0, 0, 0],
      negative: [0, 0, 0, 2, 0, 0, 0],
      topic: [0, 0, 0, 1, 1, 1, -1],
    },
    links: { from: [0, 2], to: [1, 3], kind: [0, 0] },
    meaning: null,
    topics: [
      { label: "deploy · rollout", terms: ["deploy", "rollout"], size: 3, related: [{ topic: 1, cosine: 0.7 }] },
      { label: "auth · token", terms: ["auth", "token"], size: 3, related: [{ topic: 0, cosine: 0.7 }] },
    ],
    duplicates: { threshold: 0.96, a: [3], b: [5], cosine: [0.98], truncated: false },
  };
  const withGraph = (page, payload = mapPayload) =>
    page.route("**/api/graph", (route) => route.fulfill({ json: { ok: true, data: payload } }));
  const tab = (page, name) => page.getByRole("tab", { name, exact: true });
  const figures = (page) => page.getByRole("complementary", { name: "Figures" });

  await t.test("Library map: four views of the whole library, each with its figures in words", async () => {
    const { page, errors } = await fresh((page) => withGraph(page));
    await open(page, server, "/library/map");
    // Contents: what is in it, by topic, type and bundle.
    await expect(tab(page, "Contents")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByText("What is in the library?")).toBeVisible();
    await expect(figures(page).locator(".stats")).toContainText("7assets");
    await expect(figures(page).locator(".stats")).toContainText("3topics");
    const rows = figures(page).locator("table.groups tbody tr");
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(2)).toContainText("No embedding");
    // Use: each asset in one class; the four add up to the library.
    await tab(page, "Use").click();
    await expect(page.getByText("What is used, and what is dead weight?")).toBeVisible();
    const legend = page.locator(".map-legend");
    await expect(legend).toContainText("Read in the last 30 days2");
    await expect(legend).toContainText("Read earlier in the window, not since1");
    await expect(legend).toContainText("Not read, edited in the last 180 days1");
    await expect(legend).toContainText("Not read, last edited over 180 days ago3");
    // Problems: outdated, disliked and duplicated, with the pair named.
    await tab(page, "Problems").click();
    await expect(figures(page).locator(".stats")).toContainText("1outdated");
    await expect(figures(page).locator(".stats")).toContainText("1disliked");
    await expect(figures(page).locator(".stats")).toContainText("1duplicate pairs");
    await expect(figures(page).locator(".pairs")).toContainText("wiki//knowledge/auth/d");
    await expect(figures(page).locator(".pairs")).toContainText("notes//memories/auth/f");
    // Relations: links inside and across topics, and the strongest pairs.
    await tab(page, "Relations").click();
    await expect(figures(page).locator(".stats")).toContainText("1links inside a part");
    await expect(figures(page).locator(".stats")).toContainText("1links across parts");
    await expect(figures(page)).toContainText("deploy · rollout ↔ auth · token");
    await expect(page.getByRole("checkbox", { name: "Flat" })).toBeVisible();
    assert.deepEqual(errors, []);
    await page.close();
  });

  await t.test("Library map: choosing a topic opens its figures in every view; Escape closes them", async () => {
    const { page, errors } = await fresh((page) => withGraph(page));
    await open(page, server, "/library/map");
    await figures(page).getByRole("button", { name: "auth · token", exact: true }).click();
    const detail = figures(page).locator(".detail");
    await expect(detail.getByRole("heading", { name: "auth · token" })).toBeVisible();
    await expect(detail).toContainText("3 assets · about auth, token");
    await tab(page, "Problems").click();
    await expect(detail).toContainText("knowledge/auth/d");
    await expect(detail).toContainText("more negative feedback than positive");
    await tab(page, "Relations").click();
    await expect(detail).toContainText("Linked with");
    await expect(detail.getByRole("button", { name: "deploy · rollout" }).first()).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(detail).toHaveCount(0);
    assert.deepEqual(errors, []);
    await page.close();
  });

  await t.test("Library map: ?select= opens that asset's topic, and an unknown asset is named", async () => {
    const { page } = await fresh((page) => withGraph(page));
    await open(page, server, `/library/map?select=${encodeURIComponent("notes//memories/auth/e")}`);
    await expect(figures(page).locator(".detail").getByRole("heading", { name: "auth · token" })).toBeVisible();
    await page.goto(`${server.origin}/library/map?select=${encodeURIComponent("wiki//knowledge/missing")}`);
    await expect(page.getByText("No asset “wiki//knowledge/missing” is in the library.")).toBeVisible();
    await page.close();
  });

  await t.test("Library map: without embeddings the fixture library is grouped by folder, and says why", async () => {
    const { page, errors } = await fresh();
    await open(page, server, "/library/map");
    await expect(figures(page).locator(".stats")).toContainText("folders");
    await expect(figures(page)).toContainText("No embeddings, so the library is grouped by folder.");
    assert.deepEqual(errors, []);
    await page.close();
  });

  await t.test("Library map: without WebGL the page says so and the figures are all still there", async () => {
    const { page } = await fresh(async (page) => {
      await withGraph(page);
      await page.addInitScript(() => {
        const getContext = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = function (kind, ...rest) {
          return kind === "webgl2" || kind === "webgl" ? null : getContext.call(this, kind, ...rest);
        };
      });
    });
    await open(page, server, "/library/map");
    await expect(page.getByText(/This view needs WebGL/)).toBeVisible();
    await expect(figures(page).locator(".stats")).toContainText("7assets");
    await page.close();
  });

  await t.test("Library map: leaving while the 3D view turns leaves nothing running", async () => {
    const { page, errors } = await fresh((page) => withGraph(page));
    await open(page, server, "/library/map");
    await tab(page, "Relations").click();
    await page.waitForTimeout(800);
    await page
      .getByRole("navigation", { name: "Library views" })
      .getByRole("link", { name: "Search", exact: true })
      .click();
    await expect(page).toHaveURL(/\/library\/search/);
    await page.waitForTimeout(1500);
    assert.deepEqual(errors, []);
    await page.close();
  });

  await t.test(
    "Library map: at phone width the page does not scroll sideways and the picture keeps its height",
    async () => {
      const { page, errors } = await fresh(async (page) => {
        await page.setViewportSize({ width: 390, height: 844 });
        await withGraph(page);
      });
      await open(page, server, "/library/map");
      await expect(tab(page, "Relations")).toBeVisible();
      const sideways = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert.ok(sideways <= 1, `the page scrolls ${sideways}px sideways`);
      const stage = await page.locator(".map-stage").boundingBox();
      assert.ok(stage && stage.height > 250, `the picture is ${stage?.height}px tall`);
      assert.deepEqual(errors, []);
      await page.close();
    },
  );
});
