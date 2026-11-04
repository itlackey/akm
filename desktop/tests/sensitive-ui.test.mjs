// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { chromium, expect } from "@playwright/test";
import { go, launchFixture } from "./support.mjs";

const secret =
  "synthetic-key-not-a-credential\nhttps://user:synthetic-password@example.test/?token=synthetic-token\n<script>window.__secretExecuted=true</script>\n";
const env = 'EXAMPLE_KEY="synthetic-key-not-a-credential"\nEXAMPLE_URL=https://user:synthetic-password@example.test/\n';
async function fixture() {
  return launchFixture({
    configureFixture: async (fixture) => {
      for (const folder of ["env", "secrets"]) await fs.mkdir(path.join(fixture.root, "personal", folder));
      await fs.writeFile(path.join(fixture.root, "personal/secrets/example-key"), secret);
      await fs.writeFile(path.join(fixture.root, "personal/env/example.env"), env);
      await fs.writeFile(path.join(fixture.root, "personal/env/default.env"), env);
      execFileSync(process.execPath, [fixture.launcher, "index", "--full", "--format=json", "-q"], {
        env: fixture.env,
        stdio: "pipe",
      });
    },
  });
}

test("protected file UI masks, shows, hides and clears values on navigation without HTML execution", async (t) => {
  const app = await fixture();
  t.after(() => app.stop());
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(app.url);
  for (const [ref, name] of [
    ["personal//env/example", "example.env"],
    ["personal//secrets/example-key", "example-key"],
  ]) {
    await go(page, `/library/files?ref=${encodeURIComponent(ref)}&open=1`);
    await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
    await expect(page.getByLabel("Values masked", { exact: true })).toBeVisible();
    assert.ok(!(await page.content()).includes("synthetic-password"));
    await page.getByRole("button", { name: "Show", exact: true }).click();
    await expect(page.locator(".secret-content")).toContainText("synthetic-password");
    assert.equal(await page.evaluate(() => window.__secretExecuted), undefined);
    await page.getByRole("button", { name: "Hide", exact: true }).click();
    await expect(page.locator(".secret-content")).toHaveCount(0);
    await page.getByRole("button", { name: "Show", exact: true }).click();
    await expect(page.locator(".secret-content")).toBeVisible();
    await page
      .getByRole("navigation", { name: "Primary navigation" })
      .getByRole("link", { name: "Settings", exact: true })
      .click();
    await expect(page.locator(".secret-content")).toHaveCount(0);
    await page.goBack();
    await expect(page.getByLabel("Values masked", { exact: true })).toBeVisible();
  }
  await fs.writeFile(path.join(app.root, "personal/env/new-file.env"), env);
  await go(
    page,
    `/library/files?${new URLSearchParams({ bundle: "personal", path: "env", file: "env/new-file.env", open: "1" })}`,
  );
  await expect(page.getByRole("heading", { name: "new-file.env", exact: true })).toBeVisible();
  await expect(page.getByLabel("Values masked", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Show", exact: true }).click();
  await expect(page.locator(".secret-content")).toContainText("synthetic-password");
  await page.getByRole("button", { name: "Hide", exact: true }).click();
  assert.deepEqual(errors, []);
});
