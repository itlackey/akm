// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// The "Log out" control: shown to a person with a session cookie, absent when the request carries the header.

import assert from "node:assert/strict";
import test from "node:test";
import { chromium, expect } from "@playwright/test";
import { launchFixture, open } from "./support.mjs";

test("a person with a session sees Log out; it ends the session and shows the login form", {
  timeout: 90000,
}, async (t) => {
  const server = await launchFixture();
  t.after(() => server.stop());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  page.setDefaultTimeout(8000);
  await open(page, server, "/");
  const button = page.getByRole("button", { name: "Log out" });
  await expect(button).toBeVisible();
  assert.equal((await server.call("/api/session")).body.session, true);
  assert.equal((await server.call("/api/session")).status, 200);

  await button.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("Secret")).toBeVisible();
  assert.equal((await server.call("/api/session")).status, 401, "the old cookie no longer works");
});

test("with the header (Desktop, a proxy) there is no Log out", { timeout: 90000 }, async (t) => {
  const server = await launchFixture({ login: false });
  t.after(() => server.stop());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const context = await browser.newContext({ extraHTTPHeaders: server.headers });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  await page.goto(`${server.origin}/`);
  await expect(page.getByRole("navigation", { name: "Primary navigation" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Log out" })).toHaveCount(0);
  const response = await fetch(`${server.origin}/api/session`, { headers: server.headers });
  assert.equal((await response.json()).session, false);
});

test("when the session ends the next API call shows the login form; with the header it is an error", {
  timeout: 90000,
}, async (t) => {
  const server = await launchFixture();
  t.after(() => server.stop());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  page.setDefaultTimeout(8000);
  await open(page, server, "/");
  const nav = page.getByRole("navigation", { name: "Primary navigation" });
  await expect(nav).toBeVisible();
  await page.waitForLoadState("networkidle"); // the shell's own reads are done, so the click below makes the next call
  // The page's cookie is the one `call` uses: ending it here is an idle expiry or a restart as the page sees it.
  assert.equal((await server.call("/api/session/logout", {})).status, 200);
  await nav.getByRole("link", { name: /^Review(?:\s|$)/ }).click();
  await expect(page.getByLabel("Secret")).toBeVisible();

  // The same 401 under the header (Desktop, a proxy) is the failure to show, not a reason to reload.
  const context = await browser.newContext({ extraHTTPHeaders: server.headers });
  const header = await context.newPage();
  header.setDefaultTimeout(8000);
  await header.goto(`${server.origin}/`);
  const headerNav = header.getByRole("navigation", { name: "Primary navigation" });
  await expect(headerNav).toBeVisible();
  await header.waitForLoadState("networkidle");
  let loads = 0;
  header.on("load", () => loads++);
  await header.route("**/api/proposals?*", (route) =>
    route.fulfill({
      status: 401,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, error: "Missing or invalid application session.", code: "UNAUTHORIZED" }),
    }),
  );
  await headerNav.getByRole("link", { name: /^Review(?:\s|$)/ }).click();
  await expect(header.getByText("Missing or invalid application session.").first()).toBeVisible();
  assert.equal(loads, 0, "no reload");
  await expect(header.getByLabel("Secret")).toHaveCount(0);
});
