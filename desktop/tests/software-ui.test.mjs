// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import AxeBuilder from "@axe-core/playwright";
import { chromium, expect } from "@playwright/test";
import { launchFixture } from "./support.mjs";

// The built-in engine is whatever akm-cli Desktop was built with, so its version follows each release.
const engine = createRequire(import.meta.url)("akm-cli/package.json").version;
const escaped = engine.replaceAll(".", "\\.");

test("Software uses authenticated native actions, shows receipts, preserves the workspace and fits the established UI", {
  timeout: 240000,
}, async (t) => {
  const server = await launchFixture({
    configureFixture: async (fixture) => {
      const bin = path.join(fixture.root, "fake-tools");
      await mkdir(bin);
      fixture.env.PATH = bin;
      // Executable fixtures, not production host commands or replaced HTTP responses. `akm upgrade` takes a moment,
      // as the real one does, so that the busy state is there to be read.
      for (const name of ["akm", "codex", "bun"])
        await writeFile(
          path.join(bin, name),
          `#!${process.execPath}
import fs from 'node:fs';
const args=process.argv.slice(2),name=${JSON.stringify(name)};
fs.appendFileSync(${JSON.stringify(path.join(fixture.root, "commands.jsonl"))},JSON.stringify({name,args})+'\\n');
const installed=${JSON.stringify(path.join(fixture.root, "plugin-installed"))};
if(args[0]==='--version')console.log('0.10.261104');
else if(name==='akm'){await new Promise((done)=>setTimeout(done,700));console.log(JSON.stringify({currentVersion:'0.10.261104',latestVersion:'0.10.261105',updateAvailable:true}));}
else if(args[1]==='marketplace'&&args[2]==='list')console.log(JSON.stringify({marketplaces:[{name:'akm-plugins'}]}));
else if(args[1]==='list')console.log(JSON.stringify({installed:fs.existsSync(installed)?[{pluginId:'akm@akm-plugins',version:'0.10.261105'}]:[]}));
else if(args[1]==='add'){fs.writeFileSync(installed,'fixture');console.log('{}')}
else {process.exitCode=1}
`,
          { mode: 0o755 },
        );
    },
  });
  t.after(() => server.stop());
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await context.newPage();
  await page.goto(server.url);
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await page.getByRole("link", { name: "Software", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Software", exact: true })).toBeVisible();
  // The state is words: no middle dot standing in for "is".
  await expect(page.getByText("Update available: 0.10.261105", { exact: true })).toBeVisible();
  await expect(page.getByText("To update, download a newer AKM Desktop.", { exact: true })).toBeVisible();
  // The fixture's host CLI (0.10.261104) is older than the built-in engine: said once, with its remedy.
  await expect(
    page.getByText(new RegExp(`Host akm 0\\.10\\.261104 is older than this app's engine \\(${escaped}\\)`)),
  ).toBeVisible();
  await expect(page.getByText(`Built-in AKM engine ${engine}.`, { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add to application menu", exact: true })).toHaveCount(0);
  assert.equal((await server.call("/api/desktop/software", { action: "desktop-menu-install" })).status, 400);

  // Keyboard and screen readers. Each select's hint is its description, not loose text beside it.
  const updates = page.getByLabel("Desktop updates");
  const pluginChannel = page.getByLabel("New plugin channel");
  await expect(updates).toHaveAccessibleDescription(/release line applies when the AKM Desktop app checks/);
  await expect(pluginChannel).toHaveAccessibleDescription(/remembered and is also what setup installs/);
  // A change is saved and said in a live region, focus stays on the control, and a reload shows the saved value.
  await pluginChannel.focus();
  await pluginChannel.selectOption("next");
  await expect(
    page.getByRole("status").filter({ hasText: "Saved. New plugins install from the prerelease channel." }),
  ).toBeVisible();
  await expect(pluginChannel).toBeFocused();
  await updates.focus();
  await updates.selectOption("prerelease");
  await expect(
    page.getByRole("status").filter({ hasText: "Saved. AKM Desktop follows stable and prerelease releases." }),
  ).toBeVisible();
  await expect(updates).toBeFocused();
  await page.reload();
  await expect(updates).toHaveValue("prerelease");
  await expect(pluginChannel).toHaveValue("next");

  // The harness rows are a list; each item starts with the harness and says its state in words.
  const rows = page.getByRole("list", { name: "Harness plugins" }).getByRole("listitem");
  await expect(rows.filter({ hasText: "Codex" })).toHaveText(/^Codex\s*0\.10\.261104\s*AKM plugin not installed/);
  assert.ok(!(await page.locator(".plugin-list").innerText()).includes("·"), "no middle dot between state and channel");
  // Every button says what it acts on, so no two share a name.
  const names = await page
    .locator("main button")
    .evaluateAll((buttons) => buttons.map((b) => b.getAttribute("aria-label") || b.textContent.trim()));
  assert.equal(new Set(names).size, names.length, `every button has its own name: ${names.join(" | ")}`);

  // A check started from the keyboard exposes its busy state, says what it is doing, and keeps focus on its button.
  const hostCli = page.locator('section[aria-labelledby="host-cli"]');
  const check = page.getByRole("button", { name: "Check CLI & plugins" });
  await check.focus();
  await page.keyboard.press("Enter");
  await expect(hostCli).toHaveAttribute("aria-busy", "true");
  await expect(page.getByRole("status").filter({ hasText: "Checking the CLI and plugins…" })).toBeVisible();
  await expect(hostCli).toHaveAttribute("aria-busy", "false");
  await expect(check).toBeFocused();

  // An install started from the keyboard: the result is announced, and when its button goes away focus moves to the
  // row it belonged to instead of dropping to the page.
  const install = page.getByRole("button", { name: "Install AKM plugin for Codex", exact: true });
  await install.focus();
  await page.keyboard.press("Enter");
  // The fixture already lists the akm-plugins marketplace and the prerelease channel is chosen: the install stops to say
  // the marketplace keeps its own channel, and goes on only when the person agrees.
  await expect(
    page.getByRole("alert").filter({ hasText: "already set up and keeps the channel it follows" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Install from the existing marketplace", exact: true }).click();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "AKM installed for Codex. Review its hooks in Codex /hooks to enable automatic recall." }),
  ).toBeVisible();
  await expect(install).toHaveCount(0);
  await expect(page.getByRole("heading", { name: /^Codex/ })).toBeFocused();
  await expect(rows.filter({ hasText: "Codex" })).toHaveText(/AKM plugin 0\.10\.261105 installed/);

  const upgrade = page.getByRole("button", { name: "Update CLI & plugins", exact: true });
  await upgrade.focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByText("Native AKM upgrade completed. The bundled desktop engine is unchanged.", { exact: true }),
  ).toBeVisible();
  await expect(upgrade).toBeFocused();
  // A button's label colour changes together with its fill, so coming back from busy it has no frame of an enabled
  // label on the disabled fill.
  const changing = await upgrade.evaluate((button) => getComputedStyle(button).transitionProperty.split(", "));
  assert.ok(
    !changing.includes("background-color") || changing.includes("color"),
    `label and fill change together: ${changing.join(", ")}`,
  );
  // The upgrade ends with a re-check. axe reads the settled page: idle, and the buttons' 120 ms colour change over.
  await expect(hostCli).toHaveAttribute("aria-busy", "false");
  await page.waitForFunction(() => document.getAnimations().length === 0);
  const commands = (await readFile(path.join(server.root, "commands.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.ok(commands.some((item) => item.name === "akm" && item.args.join(" ") === "upgrade --format json"));
  assert.ok(commands.some((item) => item.name === "codex" && item.args.join(" ") === "plugin add akm@akm-plugins"));
  // Update follows the CLI's own channel (stable here); the prerelease choice only drives an explicit switch.
  assert.ok(!commands.some((item) => item.name === "akm" && item.args.includes("--next")));
  assert.ok(!commands.some((item) => item.args.includes("trust") || item.args.includes("--allow-downgrade")));

  const output = process.env.AKM_DESKTOP_SCREENSHOTS || path.join(server.root, "screenshots");
  await mkdir(output, { recursive: true });
  for (const [width, height] of [
    [1280, 860],
    [900, 593],
    [600, 860],
    [390, 740],
  ]) {
    await page.setViewportSize({ width, height });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
      `No horizontal overflow at ${width}`,
    );
    const axe = await new AxeBuilder({ page }).analyze();
    assert.deepEqual(
      axe.violations.map((v) => v.id),
      [],
      `axe at ${width}×${height}`,
    );
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({ path: path.join(output, `software-${width}.png`), fullPage: true });
  }

  // Desktop's own update state (only the app's main process has one) is a single live region whose text changes, so
  // every state is heard, not only repainted; the link says where it goes.
  await page.setViewportSize({ width: 1280, height: 860 });
  let update = { state: "checking", channel: "stable" };
  let prereleaseBuild = false;
  let refused = false;
  await page.route("**/api/desktop/software", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const response = await route.fetch();
    const body = await response.json();
    body.data.desktop.update = update;
    if (prereleaseBuild) body.data.desktop.version = "0.10.261106-beta.1";
    if (refused) {
      body.data.host.cli.runnable = false;
      body.data.host.harnesses.find((item) => item.id === "codex").plugin = { state: "missing" };
      Object.assign(
        body.data.host.harnesses.find((item) => item.id === "claude"),
        { installed: true, runnable: true, plugin: { state: "missing" } },
      );
    }
    await route.fulfill({ response, json: body });
  });
  const status = page.locator("#desktop-update-status");
  await expect(status).toHaveAttribute("role", "status");
  await expect(status).toHaveText("Checking for updates…");
  await status.evaluate((element) => {
    element.dataset.sameNode = "yes";
  });
  const version = "0.10.261106";
  // Strings, so the comparison ignores how the template wraps its lines.
  for (const [next, text] of [
    [{ state: "downloading", version }, "Downloading version 0.10.261106. It installs when you quit AKM Desktop."],
    [{ state: "downloaded", version }, "Version 0.10.261106 is ready. It installs when you quit AKM Desktop."],
    [{ state: "error", during: "download", version, error: "disk full" }, "Could not download version 0.10.261106."],
    [{ state: "error", during: "check", error: "offline" }, "Could not check for updates."],
    [{ state: "unsupported", reason: "off" }, "Update checks are turned off (AKM_DESKTOP_UPDATES=off)."],
    [{ state: "unsupported", reason: "not-appimage" }, "This Linux build is not an AppImage"],
    [{ state: "unsupported", reason: "development" }, "A development run does not check for updates."],
    [{ state: "current" }, "AKM Desktop is up to date."],
    [{ state: "available", version }, "Version 0.10.261106 is available."],
  ]) {
    update = { ...next, channel: "stable" };
    await expect(status).toContainText(text);
    assert.equal(await status.getAttribute("data-same-node"), "yes", `${next.state}: the same live region`);
  }
  await expect(
    page.getByRole("link", { name: "Download version 0.10.261106 from its GitHub release page" }),
  ).toHaveAttribute("href", "https://github.com/itlackey/akm/releases/tag/v0.10.261106");
  // A prerelease build that follows stable releases: the note that it is never downgraded is the select's description.
  prereleaseBuild = true;
  await expect(updates).toHaveAccessibleDescription(/never replaced by an older one/);
  // An install the host will refuse is not a dead button (it used to be disabled with no reason given when the host
  // CLI could not run): it is operable, the reason arrives as an alert, and focus stays on the button.
  refused = true;
  const again = page.getByRole("button", { name: "Install AKM plugin for Codex", exact: true });
  await again.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("alert").filter({ hasText: "No change was made." })).toBeVisible();
  await expect(again).toBeFocused();
  // The longest install button fits the narrowest supported width: its name wraps instead of widening the page.
  await page.setViewportSize({ width: 320, height: 740 });
  await expect(page.getByRole("button", { name: "Install AKM plugin for Claude Code", exact: true })).toBeVisible();
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
    false,
    "No horizontal overflow at 320",
  );
});
