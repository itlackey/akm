import test from "node:test";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { launchFixture } from "./support.mjs";

test("startup never overwrites a newer deep-link intent; direct entry and history keep their routes", {
  timeout: 60000,
}, async (t) => {
  const server = await launchFixture({ proposals: true });
  t.after(() => server.stop());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // The initial API request happens during the shell's mount. Request the
  // new hash in its next microtask: after mount has read the old URL, before
  // an unnecessary startup goto could commit that stale URL. This makes the
  // race reproducible without slowing the app or waiting for readiness.
  await page.addInitScript(() => {
    const nativeFetch = window.fetch.bind(window);
    window.earlyRouteRequested = false;
    window.fetch = (...args) => {
      const input = args[0];
      const url = new URL(input instanceof Request ? input.url : String(input), location.href);
      if (!window.earlyRouteRequested && !location.hash && url.pathname === "/api/desktop") {
        window.earlyRouteRequested = true;
        queueMicrotask(() => {
          location.hash = "#/proposals?source=feedback";
        });
      }
      return nativeFetch(...args);
    };
  });
  await page.goto(server.url);
  await expect(page.getByRole("heading", { name: "Review", exact: true })).toBeVisible();
  assert.equal(await page.evaluate(() => window.earlyRouteRequested), true);
  await expect(page).toHaveURL(/#\/proposals\?source=feedback$/);
  await expect(page.getByRole("combobox", { name: "Source", exact: true })).toHaveValue("feedback");

  // A direct browser entry is resolved on mount, not only by internal links.
  await page.goto(
    server.origin +
      "/#/files?" +
      new URLSearchParams({
        bundle: "personal",
        path: "knowledge",
        file: "knowledge/restore-laptop.md",
        ref: server.refs.document,
        open: "1",
      }),
  );
  await expect(page.locator(".document-body")).toContainText("Verify the checksum");
  await expect(page.getByRole("navigation", { name: "File location" })).toContainText("restore-laptop.md");
  const filesUrl = page.url();
  await page
    .getByRole("navigation", { name: "Primary navigation" })
    .getByRole("link", { name: /^Review/ })
    .click();
  await expect(page.getByRole("heading", { name: "Review", exact: true })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(filesUrl);
  await expect(page.locator(".document-body")).toContainText("Verify the checksum");
  await page.goForward();
  await expect(page.getByRole("heading", { name: "Review", exact: true })).toBeVisible();
  assert.deepEqual(errors, []);
});
