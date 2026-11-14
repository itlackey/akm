// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { chromium, expect } from "@playwright/test";
import { akm, launchFixture, open } from "./support.mjs";

// The replay and the library mind map: responses in the wrong order, the three views of the map, choosing a tag, a
// library that is missing or empty, and a page that scrolls in one place only.
const tagged = (title, tags, body) =>
  `---\ntitle: ${title}\ndescription: Synthetic tagged reference\ntags: [${tags}]\n---\n# ${title}\n\n${body}\n`;

test("visualizations survive late responses, a changed library and a narrow window", {
  timeout: 240000,
}, async (t) => {
  // The fixture's assets carry only the tags the maintenance references have, so tag a few for a map with several leaves.
  const server = await launchFixture({
    metrics: true,
    similarity: true,
    configureFixture: async (fixture) => {
      const put = (file, text) => writeFile(path.join(fixture.root, "personal", file), text);
      await put(
        "knowledge/restore-laptop.md",
        tagged("Restore a laptop", "backup, recovery", "Verify the checksum before restoring a backup."),
      );
      await put("memories/backup-preference.md", tagged("Backup preference", "backup, preferences", "Keep one copy."));
      await put("knowledge/offsite-copy.md", tagged("Offsite copy", "backup, retention", "Keep a copy offsite."));
      await put("knowledge/retention-policy.md", tagged("Retention policy", "retention, recovery", "Keep for a year."));
      akm(fixture, ["index", "--full"]);
    },
  });
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
  const slider = (page) => page.getByRole("slider", { name: "Playhead" });
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

  await t.test(
    "Replay: Play starts again from the beginning and moves the clock; the timeline moves the playhead",
    async () => {
      const { page, errors } = await fresh();
      await open(page, server, "/activity/replay");
      await expect(slider(page)).toBeVisible();
      const min = Number(await slider(page).getAttribute("min"));
      const max = Number(await slider(page).getAttribute("max"));
      // The replay opens at the end, so the button offers to play from the start.
      const before = Number(await slider(page).inputValue());
      await page.getByRole("combobox", { name: "Speed" }).selectOption({ label: "Fast (4×)" });
      await page.getByRole("button", { name: "Play from start", exact: true }).click();
      await expect.poll(async () => Number(await slider(page).inputValue())).toBeLessThan(before);
      const first = Number(await slider(page).inputValue());
      await expect.poll(async () => Number(await slider(page).inputValue())).toBeGreaterThan(first);
      // Clicking the timeline seeks and pauses.
      const timeline = page.locator(".timeline svg");
      await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
      const box = await timeline.boundingBox();
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await expect(page.getByRole("button", { name: "Play", exact: true })).toBeVisible();
      const middle = Number(await slider(page).inputValue());
      assert.ok(Math.abs(middle - (min + max) / 2) < (max - min) * 0.05, `playhead ${middle} is not mid-window`);
      assert.deepEqual(errors, []);
      await page.close();
    },
  );

  await t.test("Replay: it opens at the end with full figures, and a new period reads only the events", async () => {
    const { page, errors } = await fresh();
    const requests = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.pathname === "/api/graph" || url.pathname === "/api/events") requests.push(url.pathname + url.search);
    });
    await open(page, server, "/activity/replay");
    await expect(slider(page)).toBeVisible();
    // Opens at the end of the period: the slider is on its last step (a window that is not whole minutes stops short
    // of its maximum, and scrubTime reads that step as the end) and the totals are full.
    await expect
      .poll(async () => Number(await slider(page).getAttribute("max")) - Number(await slider(page).inputValue()))
      .toBeLessThan(60_000);
    const replay = page.getByRole("region", { name: "Activity replay", exact: true });
    for (const figure of ["events", "reads", "searches", "found nothing", "feedback +/−", "assets used"])
      await expect(replay.getByText(figure, { exact: true })).toBeVisible();
    for (const list of ["Latest events", "Most used so far", "Searches that found nothing"])
      await expect(replay.getByRole("heading", { name: list })).toBeVisible();
    await expect(replay).toContainText("Plays the whole period in about 1 minute");
    await expect(replay).toContainText("Tallest bar =");
    await page.getByRole("combobox", { name: "Period" }).selectOption("7d");
    await expect(slider(page)).toBeVisible();
    await toEnd(page);
    await page.getByRole("button", { name: /^Play/ }).click();
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
    await expect(page.getByRole("button", { name: /^Play/ })).toBeDisabled();
    assert.deepEqual(errors, []);
    await page.close();
  });

  // A library the page is given instead of the fixture's: two asset types carrying tags (some of them not subjects),
  // one link, and one of each problem.
  const day = 86_400_000;
  const ago = (days) => new Date(Date.now() - days * day).toISOString();
  const mapPayload = {
    available: true,
    note: "Synthetic library.",
    types: ["knowledge", "memory"],
    bundles: ["wiki", "notes"],
    beliefs: ["superseded"],
    use: { since: ago(90), source: "user" },
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
      type: [0, 0, 1, 0, 1, 1, 1],
      bundle: [0, 0, 1, 0, 1, 1, 1],
      belief: [-1, 0, -1, -1, -1, -1, -1],
      shows: [9, 0, 2, 0, 0, 1, 0],
      lastShownAt: [ago(2), null, ago(60), null, null, ago(10), null],
      modifiedAt: [ago(5), ago(400), ago(30), ago(20), ago(500), ago(1), ago(900)],
      positive: [1, 0, 0, 0, 0, 0, 0],
      negative: [0, 0, 0, 2, 0, 0, 0],
      // deploy, auth, rollout; skill, creating, 2026, example.com and a1b2c3d4 name no subject and are not drawn.
      tags: [[0, 2, 3, 4, 5], [0, 2, 6], [0, 7], [1], [1], [1, 3], []],
    },
    links: { from: [0, 2], to: [1, 3], kind: [0, 0] },
    tags: ["deploy", "auth", "rollout", "skill", "creating", "2026", "example.com", "a1b2c3d4"],
    duplicates: { threshold: 0.96, a: [3], b: [5], cosine: [0.98], truncated: false },
  };
  const withGraph = (page, payload = mapPayload) =>
    page.route("**/api/graph", (route) => route.fulfill({ json: { ok: true, data: payload } }));
  const tab = (page, name) => page.getByRole("tab", { name, exact: true });
  const figures = (page) => page.getByRole("complementary", { name: "Figures" });
  const mapButton = (page, name) => page.locator(".mind-map").getByRole("button", { name, exact: true });
  const consoleErrors = (page, errors) =>
    page.on("console", (message) => message.type() === "error" && errors.push(message.text()));
  /** Elements inside `selector` that scroll on their own: more than one scroller means a page you scroll twice. */
  const innerScrollers = (page, selector) =>
    page.evaluate((root) => {
      const top = document.querySelector(root);
      return [top, ...top.querySelectorAll("*")]
        .filter((el) => {
          const style = getComputedStyle(el);
          return /auto|scroll/.test(style.overflowY) && el.scrollHeight > el.clientHeight + 1;
        })
        .map((el) => `${el.tagName.toLowerCase()}.${el.className}`);
    }, selector);

  await t.test("Library map: three views of the whole library, each with its figures in words", async () => {
    const { page, errors } = await fresh((page) => withGraph(page));
    await open(page, server, "/library/map");
    // Contents: what is in it, by type, bundle and tag.
    await expect(tab(page, "Contents")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByText("What is in the library?")).toBeVisible();
    await expect(tab(page, "Relations")).toHaveCount(0);
    await expect(figures(page).locator(".stats")).toContainText("7assets");
    await expect(figures(page).locator(".stats")).toContainText("8tags");
    await expect(mapButton(page, "Knowledge: 3")).toBeVisible();
    await expect(mapButton(page, "Memories and facts: 4")).toBeVisible();
    await expect(mapButton(page, "auth (Memories and facts): 2")).toBeVisible();
    await expect(mapButton(page, "rollout (Knowledge): 2")).toBeVisible();
    // Tags that name no subject are not drawn.
    await expect(
      page.locator(".mind-map").getByRole("button", { name: /^(skill|creating|2026|example\.com)/ }),
    ).toHaveCount(0);
    const rows = figures(page).locator("table.tag-table tbody tr");
    await expect(rows).toHaveCount(5);
    await expect(rows.first()).toContainText("2");
    // Use: each asset in one class; the four add up to the library.
    await tab(page, "Use").click();
    await expect(page.getByText("What is used, and what is dead weight?")).toBeVisible();
    const legend = page.locator(".map-legend");
    await expect(legend).toContainText("Read in the last 30 days2");
    await expect(legend).toContainText("Read earlier in the window, not since1");
    await expect(legend).toContainText("Not read, edited in the last 180 days1");
    await expect(legend).toContainText("Not read, last edited over 180 days ago3");
    await expect(mapButton(page, "Knowledge: 33% read")).toBeVisible();
    await expect(mapButton(page, "auth (Memories and facts): 50% read")).toBeVisible();
    // Problems: outdated, disliked and duplicated, with the pair named.
    await tab(page, "Problems").click();
    await expect(page.getByText("What is wrong or duplicated?")).toBeVisible();
    await expect(figures(page).locator(".stats")).toContainText("1outdated");
    await expect(figures(page).locator(".stats")).toContainText("1disliked");
    await expect(figures(page).locator(".stats")).toContainText("1duplicate pairs");
    await expect(figures(page).locator(".pairs")).toContainText("wiki//knowledge/auth/d");
    await expect(figures(page).locator(".pairs")).toContainText("notes//memories/auth/f");
    await expect(mapButton(page, "Knowledge: 2 problems")).toBeVisible();
    await expect(mapButton(page, "auth (Memories and facts): 1 problem")).toBeVisible();
    assert.deepEqual(errors, []);
    await page.close();
  });

  await t.test("Library map: choosing a tag opens its figures in every view; Escape closes them", async () => {
    const { page, errors } = await fresh((page) => withGraph(page));
    await open(page, server, "/library/map");
    const detail = figures(page).locator(".detail");
    await expect(detail).toHaveCount(0);
    await mapButton(page, "rollout (Knowledge): 2").click();
    await expect(mapButton(page, "rollout (Knowledge): 2")).toHaveAttribute("aria-pressed", "true");
    await expect(detail.getByRole("heading", { name: /^rollout/ })).toBeVisible();
    await expect(detail).toContainText("2 assets");
    await tab(page, "Problems").click();
    await expect(detail).toContainText("deploy/b");
    await expect(detail).toContainText("superseded, contradicted or deprecated");
    await tab(page, "Use").click();
    await expect(detail).toContainText("Read in the last 30 days");
    await page.keyboard.press("Escape");
    await expect(detail).toHaveCount(0);
    await expect(mapButton(page, "rollout (Knowledge): 50% read")).toHaveAttribute("aria-pressed", "false");
    // A type opens its figures too, and the list beside the map chooses a tag as well.
    await mapButton(page, "Memories and facts: 25% read").click();
    await expect(detail.getByRole("heading", { name: /^Memories and facts/ })).toBeVisible();
    await figures(page).locator("tr", { hasText: "Memories and facts" }).getByRole("button", { name: "auth" }).click();
    await expect(detail.getByRole("heading", { name: /^auth/ })).toBeVisible();
    await detail.getByRole("button", { name: "Close" }).click();
    await expect(detail).toHaveCount(0);
    assert.deepEqual(errors, []);
    await page.close();
  });

  await t.test("Library map: ?select= opens that asset's tag, and an unknown asset is named", async () => {
    const { page } = await fresh((page) => withGraph(page));
    await open(page, server, `/library/map?select=${encodeURIComponent("notes//memories/auth/e")}`);
    await expect(figures(page).locator(".detail").getByRole("heading", { name: /^auth/ })).toBeVisible();
    await expect(mapButton(page, "auth (Memories and facts): 2")).toHaveAttribute("aria-pressed", "true");
    await page.goto(`${server.origin}/library/map?select=${encodeURIComponent("wiki//knowledge/missing")}`);
    await expect(page.getByText("No asset “wiki//knowledge/missing” is in the library.")).toBeVisible();
    await page.close();
  });

  await t.test("Library map: the fixture library draws its tags, with no errors and one scroller", async () => {
    const { page, errors } = await fresh();
    consoleErrors(page, errors);
    await open(page, server, "/library/map");
    await expect(figures(page).locator(".stats")).toContainText("assets");
    // The tagged knowledge assets: recovery on the restore guide and the policy, retention on the policy and the copy note.
    await expect(mapButton(page, "recovery (Knowledge): 2")).toBeVisible();
    await expect(mapButton(page, "retention (Knowledge): 2")).toBeVisible();
    assert.ok((await page.locator(".mind-map").getByRole("button").count()) >= 5);
    assert.deepEqual(await innerScrollers(page, ".map-page"), []);
    for (const name of ["Use", "Problems", "Contents"]) {
      await tab(page, name).click();
      assert.deepEqual(await innerScrollers(page, ".map-page"), [], name);
    }
    assert.deepEqual(errors, []);
    await page.close();
  });

  await t.test(
    "Library map: no index, an empty library and a failed read each say so, and Retry recovers",
    async () => {
      const empty = {
        ...mapPayload,
        note: "0 assets.",
        types: [],
        bundles: [],
        beliefs: [],
        use: null,
        kinds: [],
        nodes: Object.fromEntries(Object.keys(mapPayload.nodes).map((column) => [column, []])),
        links: { from: [], to: [], kind: [] },
        tags: [],
        duplicates: null,
      };
      {
        const { page, errors } = await fresh((page) =>
          withGraph(page, { ...empty, available: false, note: "The index could not be read." }),
        );
        await open(page, server, "/library/map");
        await expect(page.getByText("The index could not be read.")).toBeVisible();
        await expect(page.getByText("Reading the library")).toHaveCount(0);
        assert.deepEqual(errors, []);
        await page.close();
      }
      {
        const { page, errors } = await fresh((page) => withGraph(page, empty));
        await open(page, server, "/library/map");
        await expect(figures(page).locator(".stats")).toContainText("0assets");
        for (const name of ["Use", "Problems", "Contents"]) await tab(page, name).click();
        assert.deepEqual(errors, []);
        await page.close();
      }
      {
        let fail = true;
        const { page } = await fresh((page) =>
          page.route("**/api/graph", (route) =>
            fail
              ? route.fulfill({ status: 500, json: { ok: false, error: "Synthetic: the graph failed." } })
              : route.fulfill({ json: { ok: true, data: mapPayload } }),
          ),
        );
        await open(page, server, "/library/map");
        await expect(page.getByRole("alert")).toContainText("Synthetic: the graph failed.");
        fail = false;
        await page.getByRole("button", { name: "Retry" }).click();
        await expect(figures(page).locator(".stats")).toContainText("7assets");
        await expect(page.getByRole("alert")).toHaveCount(0);
        await page.close();
      }
    },
  );

  await t.test(
    "Library map: at phone width the page does not scroll sideways and the map stays inside it",
    async () => {
      const { page, errors } = await fresh(async (page) => {
        await page.setViewportSize({ width: 390, height: 844 });
        await withGraph(page);
      });
      await open(page, server, "/library/map");
      await expect(tab(page, "Problems")).toBeVisible();
      await expect(mapButton(page, "Knowledge: 3")).toBeVisible();
      const sideways = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert.ok(sideways <= 1, `the page scrolls ${sideways}px sideways`);
      const map = await page.locator(".mind-map").boundingBox();
      assert.ok(
        map && map.x >= 0 && map.x + map.width <= 391,
        `the map spans ${map?.x} to ${map && map.x + map.width}`,
      );
      assert.deepEqual(errors, []);
      await page.close();
    },
  );

  // The replay's mind map counts the events on the assets the period touched: reads on e, f and a, and a search that
  // hit a (part of its search, not an event of its own).
  await t.test("Replay: the map counts events on each type and tag up to the playhead", async () => {
    const hours = (h) => new Date(Date.now() - h * 3_600_000).toISOString();
    const { page, errors } = await fresh(async (page) => {
      await withGraph(page);
      await page.route("**/api/events?since=24h", (route) =>
        route.fulfill({
          json: {
            ok: true,
            data: {
              available: true,
              truncated: false,
              window: { since: hours(24), until: hours(0) },
              events: [
                { id: 1, at: hours(3), eventType: "show", ref: "notes//memories/auth/e", source: "user" },
                { id: 2, at: hours(2), eventType: "show", ref: "notes//memories/auth/f", source: "user" },
                {
                  id: 3,
                  at: hours(1.5),
                  eventType: "search",
                  ref: "wiki//knowledge/deploy/a",
                  query: "ship",
                  source: "user",
                },
                { id: 4, at: hours(1), eventType: "show", ref: "wiki//knowledge/deploy/a", source: "user" },
              ],
            },
          },
        }),
      );
    });
    consoleErrors(page, errors);
    await open(page, server, "/activity/replay");
    const replay = page.getByRole("region", { name: "Activity replay", exact: true });
    await expect(mapButton(page, "auth (Memories and facts): 2 events")).toBeVisible();
    await expect(mapButton(page, "deploy (Knowledge): 1 event")).toBeVisible();
    await expect(replay.locator(".root")).toContainText("3 events");
    await expect(replay.getByText("Where the events landed, by type and tag")).toBeVisible();
    await expect(replay).toContainText("read notes//memories/auth/e");
    await mapButton(page, "auth (Memories and facts): 2 events").click();
    await expect(mapButton(page, "auth (Memories and facts): 2 events")).toHaveAttribute("aria-pressed", "true");
    // At the start of the period nothing has happened yet.
    await slider(page).evaluate((input) => {
      input.value = input.min;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await expect(mapButton(page, "auth (Memories and facts)")).toBeVisible();
    await expect(replay.locator(".root")).not.toContainText("3 events");
    assert.deepEqual(errors, []);
    await page.close();
  });

  await t.test("Replay: the fixture's events draw with no console errors and one scroller", async () => {
    const { page, errors } = await fresh();
    consoleErrors(page, errors);
    await open(page, server, "/activity/replay");
    await expect(slider(page)).toBeVisible();
    await expect(mapButton(page, "recovery (Knowledge): 2 events")).toBeVisible();
    assert.deepEqual(await innerScrollers(page, ".replay"), []);
    await page.getByRole("combobox", { name: "Period" }).selectOption("7d");
    await expect(slider(page)).toBeVisible();
    assert.deepEqual(await innerScrollers(page, ".replay"), []);
    assert.deepEqual(errors, []);
    await page.close();
  });
});
