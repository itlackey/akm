// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium, expect } from "@playwright/test";
import { launchFixture, open } from "./support.mjs";

// Keyboard focus after each way a decision can end: it never falls back to <body>.
test("Review: focus stays on a control after a failed write, Undo, Reopen, batch report and finished", {
  timeout: 240000,
}, async (t) => {
  const server = await launchFixture({ proposals: true });
  t.after(() => server.stop());
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const active = () =>
    page.evaluate(() => document.activeElement?.textContent?.trim() || document.activeElement?.tagName);
  const button = (name) => page.getByRole("button", { name, exact: true });
  await open(page, server, `/review/${server.proposals.stale}`);
  await expect(page.getByRole("heading", { name: "restore laptop", level: 2 })).toBeVisible();

  // A refused write keeps the confirmation, the input and focus on Confirm.
  await button("Accept…").click();
  await page.route(
    "**/api/proposals/*/accept",
    (route) =>
      route.fulfill({ status: 409, json: { ok: false, code: "PROPOSAL_NOT_PENDING", error: "No longer pending." } }),
    { times: 1 },
  );
  await button("Confirm accept").click();
  await expect(page.getByRole("alert").filter({ hasText: "The decision was not recorded." })).toBeVisible();
  await expect(button("Confirm accept")).toBeFocused();

  // Accept, then Undo… from the toast; Cancel returns to the shelf's Revert…, not to <body>.
  await button("Confirm accept").click();
  await expect(page.getByRole("status").filter({ hasText: "Accepted “restore laptop”" })).toContainText(
    /restore-laptop/,
  );
  await page.getByRole("status").getByRole("button", { name: "Undo…" }).click();
  await expect(button("Confirm revert")).toBeFocused();
  await button("Cancel").click();
  await expect(button("Revert…")).toBeFocused();

  // One decision toast at a time: a second decision replaces the first.
  await button("Revert…").click();
  await button("Confirm revert").click();
  await expect(page.getByRole("status").filter({ hasText: "Reverted “restore laptop”" })).toBeVisible();
  await expect(page.locator("[data-toast]")).toHaveCount(1);

  // Reject, then Reopen… from the Last line; after Confirm reopen focus is on a shelf control.
  await page.getByRole("region", { name: "Proposals" }).getByRole("link").filter({ hasText: "review example" }).click();
  await button("Reject…").click();
  await page.getByRole("radio", { name: "Wrong" }).check({ force: true });
  await button("Confirm reject").click();
  await expect(page.getByRole("status").filter({ hasText: "Rejected “review example”" })).toBeVisible();
  await page.getByRole("region", { name: "Proposal detail" }).getByRole("button", { name: "Reopen…" }).click();
  await expect(button("Confirm reopen")).toBeFocused();
  await button("Confirm reopen").click();
  await expect(page.getByRole("status").filter({ hasText: "Reopened “review example”" })).toBeVisible();
  await expect.poll(active).not.toBe("BODY");
  assert.notEqual(await active(), "BODY");

  // A batch with a failure: the report takes focus, and Dismiss hands it to the shelf.
  await page.route(
    "**/api/proposals/accept",
    (route) =>
      route.fulfill({
        json: {
          ok: true,
          data: {
            accepted: 0,
            failed: 2,
            results: JSON.parse(route.request().postData()).ids.map((id) => ({
              id,
              ok: false,
              error: "Changed.",
              code: "STALE",
            })),
          },
        },
      }),
    { times: 1 },
  );
  await page
    .getByRole("checkbox", { name: /^Select personal/ })
    .first()
    .check();
  await button("Accept selected…").click();
  await button("Confirm accept 1").click();
  const report = page.getByRole("heading", { name: /1 failed and remains selected/ });
  await expect(report).toBeFocused();
  await page.getByRole("button", { name: "Dismiss", exact: true }).click();
  await expect.poll(active).not.toBe("BODY");
  assert.deepEqual(errors, []);
});

// Refresh says it worked without moving anything, and a decision toast sits above the shelf, never over its buttons.
test("Review: Refresh confirms politely and keeps focus; a toast clears the decision shelf", {
  timeout: 120000,
}, async (t) => {
  const server = await launchFixture({ proposals: true });
  t.after(() => server.stop());
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const button = (name) => page.getByRole("button", { name, exact: true });
  await open(page, server, "/review");
  const refresh = page.getByRole("button", { name: /Refresh queue/ });
  await refresh.click();
  await expect(page.locator(".refresh-note")).toHaveText("Updated just now");
  await expect(page.locator(".refresh-note")).toHaveAttribute("role", "status");
  await expect(refresh).toBeFocused();

  await open(page, server, `/review/${server.proposals.stale}`);
  await button("Accept…").click();
  await button("Confirm accept").click();
  // The shelf unmounts while the next proposal loads, and the toast closes itself, so read both rects in one
  // synchronous evaluate, retried until both exist, instead of two separate boundingBox() calls that can straddle either change.
  const rects = (a, b) =>
    page.evaluate(
      ([x, y]) => {
        const r = (sel) => {
          const e = document.querySelector(sel);
          const v = e?.getBoundingClientRect();
          return v && v.width > 0 && v.height > 0 ? { y: v.y, height: v.height } : null;
        };
        const [ra, rb] = [r(x), r(y)];
        return ra && rb ? [ra, rb] : null;
      },
      [a, b],
    );
  const both = async (a, b) => {
    for (const deadline = Date.now() + 10000; Date.now() < deadline; await page.waitForTimeout(50)) {
      const pair = await rects(a, b);
      if (pair) return pair;
    }
    throw new Error(`${a} and ${b} were never on screen together`);
  };
  const [toastBox, shelfBox] = await both(".toast", ".decision-shelf");
  assert.ok(toastBox.y + toastBox.height <= shelfBox.y + 1, "the toast ends above the shelf");
  // The next proposal's row is the highlighted one and is inside the queue list's view.
  const [rowBox, listBox] = await both(".review-row.active", ".review-list");
  assert.ok(rowBox.y >= listBox.y - 1 && rowBox.y + rowBox.height <= listBox.y + listBox.height + 1);
});
