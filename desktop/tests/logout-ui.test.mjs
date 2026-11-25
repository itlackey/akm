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
