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
});
