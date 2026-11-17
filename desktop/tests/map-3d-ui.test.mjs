// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium, expect } from "@playwright/test";
import { launchFixture, open } from "./support.mjs";

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
    const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
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
});
