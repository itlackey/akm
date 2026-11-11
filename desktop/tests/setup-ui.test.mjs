// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import assert from "node:assert/strict";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import AxeBuilder from "@axe-core/playwright";
import { chromium, expect } from "@playwright/test";
import { akm, launchFixture } from "./support.mjs";

const ENGINE = JSON.parse(await readFile(new URL("../.core/package.json", import.meta.url), "utf8")).version;
const PLUGIN = "0.10.261020";
const here = path.dirname(new URL(import.meta.url).pathname);

/** A harness CLI that records its arguments and keeps its plugin state in a file, like the native one. */
const harness = (root, name) => `#!${process.execPath}
import fs from 'node:fs';
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(path.join(root, "commands.jsonl"))}, JSON.stringify({ name: ${JSON.stringify(name)}, args }) + '\\n');
const file = ${JSON.stringify(path.join(root, `${name}.json`))};
const state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
const save = (next) => fs.writeFileSync(file, JSON.stringify({ ...state, ...next }));
const line = args.join(' ');
if (args[0] === '--version') console.log('2.1.283');
else if (line === 'plugin list --json') console.log(JSON.stringify(state.installed ? [{ id: 'akm@akm-plugins', version: ${JSON.stringify(PLUGIN)}, scope: 'user' }] : []));
else if (line === 'plugin marketplace list --json') console.log(JSON.stringify(state.marketplace ? [{ name: 'akm-plugins' }] : []));
else if (line.startsWith('plugin marketplace add')) { save({ marketplace: true }); console.log('{}'); }
else if (line.startsWith('plugin install')) { save({ installed: true }); console.log('{}'); }
else process.exitCode = 1;
`;

/** What the release installer writes: an akm that reports Desktop's version, as the installer of Desktop's own release does. */
const installer = `#!/usr/bin/env bash
set -e
# Absolute paths: the test's PATH holds only its stubs, so that no real harness, Bun or akm can be found.
/bin/mkdir -p "$AKM_INSTALL_DIR"
/bin/cat > "$AKM_INSTALL_DIR/akm" <<'AKM'
#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] === '--version') console.log(${JSON.stringify(ENGINE)});
else console.log(JSON.stringify({ currentVersion: ${JSON.stringify(ENGINE)}, latestVersion: ${JSON.stringify(ENGINE)}, updateAvailable: false, plugins: [] }));
AKM
/bin/chmod +x "$AKM_INSTALL_DIR/akm"
`;

/** A `crontab` that keeps the table in a file of the fixture: the OS scheduler is never touched. */
const crontab = (root) => `#!/bin/sh
case "$1" in -l) [ -f "${path.join(root, "crontab.txt")}" ] && /bin/cat "${path.join(root, "crontab.txt")}" || exit 1;; -) /bin/cat > "${path.join(root, "crontab.txt")}";; esac
`;
const table = async (server) => readFile(path.join(server.root, "crontab.txt"), "utf8").catch(() => "");
const savedConfig = async (server) => JSON.parse(await readFile(server.env.AKM_CONFIG_FILE, "utf8"));

const commands = async (server) =>
  (await readFile(path.join(server.root, "commands.jsonl"), "utf8").catch(() => ""))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));

test("first run on an empty computer ends with a library, the CLI, a connected agent and a search akm saw", {
  timeout: 240000,
}, async (t) => {
  let starter;
  const server = await launchFixture({
    empty: true,
    execArgv: ["--import", path.join(here, "stub-installer.mjs")],
    configureFixture: async (fixture) => {
      const bin = path.join(fixture.root, "bin");
      await mkdir(bin);
      await writeFile(path.join(bin, "claude"), harness(fixture.root, "claude"), { mode: 0o755 });
      await writeFile(path.join(bin, "crontab"), crontab(fixture.root), { mode: 0o755 });
      await writeFile(path.join(fixture.root, "install.sh"), installer);
      starter = path.join(fixture.root, "starter");
      await mkdir(path.join(starter, "knowledge"), { recursive: true });
      await writeFile(
        path.join(starter, "knowledge", "deploy-checklist.md"),
        "---\ntitle: Deploy checklist\ndescription: Synthetic starter guidance\n---\n# Deploy checklist\n\nVerify the rollback before every deploy.\n",
      );
      // Only the stubs are on PATH: no real harness, Bun or akm is ever found or run.
      fixture.env.PATH = bin;
      fixture.env.AKM_TEST_INSTALLER = path.join(fixture.root, "install.sh");
    },
  });
  t.after(() => server.stop());
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const screenshots = process.env.AKM_DESKTOP_SCREENSHOTS || path.join(server.root, "screenshots");
  await mkdir(screenshots, { recursive: true });
  const shot = (name) => page.screenshot({ path: path.join(screenshots, `${name}.png`), fullPage: true });
  // The starter bundle is a GitHub download. The first try fails, as offline does; the second goes to a local folder.
  let tries = 0;
  await page.route("**/api/bundles/add", (route) =>
    ++tries === 1
      ? route.fulfill({ status: 502, json: { ok: false, code: "FETCH_FAILED", error: "Could not reach GitHub." } })
      : route.continue({ postData: JSON.stringify({ source: starter, name: "akm-stash" }) }),
  );

  await page.goto(server.url);
  // Unconfigured Home offers setup instead of a red health failure.
  await expect(page.getByRole("heading", { name: "Set up akm on this computer" })).toBeVisible();
  await expect(page.getByText("State db readable")).toHaveCount(0);
  await shot("setup-01-home");
  await page.getByRole("link", { name: /Start setup/ }).click();
  await expect(page.getByRole("heading", { name: "Set up akm", exact: true })).toBeVisible();
  await expect(page.getByText("Not created yet")).toBeVisible();

  // 1. The library, and the starter bundle (pre-ticked).
  await expect(page.getByRole("checkbox", { name: /AKM starter bundle/ })).toBeChecked();
  await shot("setup-02-library");
  await page.getByRole("button", { name: "Create library" }).click();
  await expect(page.getByText(/Library created at/)).toBeVisible();
  // A failed starter bundle does not undo or block the library; it can be tried again.
  await expect(page.getByText(/The starter bundle could not be added. Could not reach GitHub./)).toBeVisible();
  await expect(page.getByText("✓ Ready")).toBeVisible();
  await shot("setup-02b-starter-failed");
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByText("Starter bundle added and indexed.")).toBeVisible();
  assert.equal(tries, 2);
  const config = await savedConfig(server);
  assert.equal(config.harnesses, undefined, "nothing is enabled until the agents step is run");
  // Learning is off from the start: the one host-wide switch, so even a session-end extract is silent.
  assert.deepEqual(config.improve, { enabled: false });

  // 2. The CLI is pre-ticked with the version and place it installs to; Claude's plugin waits for Bun.
  const cli = page.getByRole("checkbox", { name: /Install .*akm.* to ~\/.local\/bin/ });
  await expect(cli).toBeChecked();
  await expect(page.getByRole("heading", { name: /Claude Code/ })).toBeVisible();
  const claudeBox = page.getByRole("checkbox", { name: /Install the akm plugin/ });
  await expect(claudeBox).toBeDisabled();
  // The box that cannot be ticked says why: the Bun note is its description.
  await expect(claudeBox).toHaveAccessibleDescription(/hooks run on Bun, and Bun is not installed/);
  await expect(page.getByText("The Claude Code plugin's hooks run on Bun")).toBeVisible();
  await expect(page.getByText("curl -fsSL https://bun.sh/install | bash")).toBeVisible();
  // Keyboard and screen readers: a card is a named group, each control says what it acts on, and a hint is the
  // description of its control, not loose text beside it.
  const claudeCard = page.getByRole("group", { name: /^Claude Code/ });
  await expect(claudeCard).toBeVisible();
  await expect(page.getByRole("checkbox", { name: /Install the akm plugin for Claude Code/ })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Copy Bun's install command" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Check again for Bun" })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "Let akm use Claude Code" })).toHaveAccessibleDescription(
    /Lets akm run agent work and tasks on it/,
  );
  await expect(cli).toHaveAccessibleDescription(/official release installer/);
  await shot("setup-03-agents-before");
  // The agent is offered as "let akm use it" (ticked); learning is a separate choice, off.
  await expect(page.getByRole("checkbox", { name: "Let akm use Claude Code" })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "Let akm learn in the background" })).not.toBeChecked();
  await expect(page.getByRole("radio")).toHaveCount(0);
  // Started from the keyboard: the results arrive in a live region and focus stays on the button that ran them.
  const installSelected = page.locator('section[aria-labelledby="setup-agents"] .btn-row button');
  await page.getByRole("button", { name: "Install 2 selected" }).focus();
  await page.keyboard.press("Enter");
  await expect(
    page.locator('[aria-live="polite"]').filter({ hasText: /AKM CLI installed in ~\/.local\/bin/ }),
  ).toBeVisible();
  await expect(installSelected).toBeFocused();
  await expect(page.getByText(/AKM CLI installed in ~\/.local\/bin/)).toBeVisible();
  // Enabled, and learning stays off: nothing is scheduled, and the learning switch stays off.
  await expect(page.getByText(/1 agent is enabled for akm. Background learning is off./)).toBeVisible();
  const enabledOnly = await savedConfig(server);
  assert.equal(enabledOnly.harnesses.claude.modelWork, undefined);
  assert.equal(enabledOnly.improve.harness, undefined);
  assert.equal(enabledOnly.improve.connection, undefined);
  assert.equal(enabledOnly.scheduler, undefined);
  await expect(page.getByText(`akm ${ENGINE} at`)).toBeVisible();

  // The person installs Bun and checks again; Desktop never ran Bun's installer.
  const bun = path.join(server.root, "bin", "bun");
  await writeFile(bun, `#!${process.execPath}\nconsole.log('1.3.14');\n`);
  await chmod(bun, 0o755);
  await page.getByRole("button", { name: "Check again" }).click();
  await expect(claudeBox).toBeEnabled();
  await expect(page.getByText("The Claude Code plugin's hooks run on Bun")).toHaveCount(0);
  await expect(claudeBox).toBeChecked();
  const learning = page.getByRole("checkbox", { name: "Let akm learn in the background" });
  await expect(learning).not.toBeChecked();
  await learning.check();
  // With no connection, "akm itself" cannot be chosen, and one line says why; an agent can.
  await expect(page.getByRole("radio", { name: /akm itself/ })).toBeDisabled();
  await expect(page.getByText(/akm itself needs a model connection/)).toBeVisible();
  await expect(page.getByText(/model calls are limited to reading and searching|cannot be restricted/)).toBeVisible();
  // The learning choices and fields carry their hints as descriptions; a placeholder is an example, not the instruction.
  await expect(page.getByRole("radio", { name: /akm itself/ })).toHaveAccessibleDescription(
    /akm has no model connection/,
  );
  await expect(page.getByRole("radio", { name: "Claude Code" })).toHaveAccessibleDescription(
    /akm runs Claude Code for this/,
  );
  await expect(page.getByLabel("Model", { exact: true })).toHaveAccessibleDescription(/model name the endpoint serves/);
  await expect(page.getByLabel("Model", { exact: true })).not.toHaveAttribute("placeholder", /endpoint serves/);
  await expect(page.getByLabel(/API key variable/)).toHaveAccessibleDescription(/never the key itself/);
  await expect(learning).toHaveAccessibleDescription(/Off unless you turn it on/);
  await shot("setup-04-learning-needs-connection");
  // Enter a connection (the key's variable name only): akm itself becomes the default choice.
  await page.getByLabel("Endpoint").fill("http://localhost:11434");
  await page.getByLabel("Model", { exact: true }).fill("qwen3");
  await page.getByLabel(/API key variable/).fill("LAB_KEY");
  await expect(page.getByRole("radio", { name: /akm itself/ })).toBeChecked();
  await shot("setup-04b-learning-akm-itself");
  await page.getByRole("button", { name: "Install 2 selected" }).click();
  await expect(page.getByText("AKM plugin installed. Restart the harness to load it.")).toBeVisible();
  // The receipt is what akm reports afterwards, not the ticked boxes.
  await expect(page.getByText(/Background learning is on and runs on akm itself: connection "default"/)).toBeVisible();
  await expect(learning).toBeChecked();
  const onItself = await savedConfig(server);
  assert.equal(onItself.improve.connection, "default");
  assert.equal(onItself.improve.harness, undefined);
  assert.equal(onItself.connections.default.endpoint, "http://localhost:11434/v1");
  assert.equal(onItself.connections.default.apiKey, "$LAB_KEY");
  assert.equal(onItself.improve.enabled, undefined);
  assert.match(onItself.scheduler.enabled[0], /tasks\/improve$/);
  // The fixture moves akm's directories (AKM_*_DIR), so it is not the default installation: the sync that follows
  // enabling the task reports that and leaves the OS scheduler (the fixture's crontab) alone.
  assert.equal(await table(server), "");

  // Choose the agent instead: improve runs on it, and akm's own words say what it can do there.
  await page.getByRole("radio", { name: "Claude Code" }).check();
  await page.getByRole("button", { name: "Install 1 selected" }).click();
  await expect(page.getByText(/Background learning is on and runs on Claude Code: harness "claude"/)).toBeVisible();
  await expect(page.getByRole("radio", { name: "Claude Code" })).toBeChecked();
  await expect(page.getByText(`✓ AKM plugin ${PLUGIN}`)).toBeVisible();
  await expect(page.getByText("Restart Claude Code")).toBeVisible();
  // The restart note belongs to its card: it is the card's description.
  await expect(claudeCard).toHaveAccessibleDescription(/Restart Claude Code, or run \/reload-plugins/);
  await shot("setup-05-learning-agent");
  const run = await commands(server);
  // A stage engine (0.11.0-beta.0) installs the plugins from the marketplace's next channel.
  const marketplace = `itlackey/akm-plugins${/^\d+\.\d+\.\d+-/.test(ENGINE) ? "@next" : ""}`;
  assert.ok(run.some((item) => item.args.join(" ") === `plugin marketplace add ${marketplace}`));
  assert.ok(run.some((item) => item.args.join(" ") === "plugin install akm@akm-plugins --scope user"));
  assert.ok(!run.some((item) => item.name === "bun"), "Bun's installer is never run");
  const onAgent = await savedConfig(server);
  assert.equal(onAgent.improve.harness, "claude");
  assert.equal(onAgent.improve.connection, undefined);
  assert.equal(onAgent.harnesses.claude.modelWork, undefined);

  // Off again: the one switch is written, so nothing runs; the schedule and the connection stay.
  await learning.uncheck();
  await page.getByRole("button", { name: "Install 1 selected" }).click();
  await expect(page.getByText("Background learning is off.")).toBeVisible();
  const off = await savedConfig(server);
  assert.equal(off.improve.enabled, false);
  assert.match(off.scheduler.enabled[0], /tasks\/improve$/);
  assert.equal(await table(server), "");
  assert.equal(off.connections.default.apiKey, "$LAB_KEY");
  // And on again removes the switch: nothing is left behind.
  await learning.check();
  await page.getByRole("radio", { name: /akm itself/ }).check();
  await page.getByRole("button", { name: "Install 1 selected" }).click();
  await expect(page.getByText(/Background learning is on and runs on akm itself/)).toBeVisible();
  assert.equal((await savedConfig(server)).improve.enabled, undefined);

  // 3. Try it: a real search, and the agent check, which claims nothing until akm's count rises.
  await expect(page.getByRole("searchbox", { name: "Search your library" })).toHaveValue(/\w/);
  await page.getByRole("searchbox", { name: "Search your library" }).fill("deploy");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByRole("list", { name: "Search results" }).getByText("Deploy checklist")).toBeVisible();
  await expect(page.getByText("/akm-search deploy")).toBeVisible();
  await expect(page.getByText("Waiting for a search from an agent")).toBeVisible();
  await expect(page.getByText(/A search reached akm/)).toHaveCount(0);
  await shot("setup-06-try");
  akm(server, ["search", "deploy"]);
  await expect(page.getByText(/A search reached akm at/)).toBeVisible({ timeout: 15000 });
  await shot("setup-07-observed");

  // Setup is derived, not remembered: it can be run again from Settings and shows what is true now.
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await page.getByRole("link", { name: "Software", exact: true }).click();
  await page.getByRole("link", { name: "Run setup again" }).click();
  await expect(page.getByText("✓ Ready")).toBeVisible();
  await expect(page.getByText("✓ 1 connected")).toBeVisible();
  await expect(page.getByRole("checkbox", { name: /AKM starter bundle/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Nothing selected" })).toBeDisabled();
  for (const [width, height] of [
    [1280, 860],
    [900, 593],
    [600, 900],
    [390, 740],
  ]) {
    await page.setViewportSize({ width, height });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
      `overflow at ${width}`,
    );
    const axe = await new AxeBuilder({ page }).analyze();
    assert.deepEqual(
      axe.violations.map((v) => v.id),
      [],
      `axe at ${width}×${height}`,
    );
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await shot("setup-08-rerun");
  await page.goto(server.origin);
  await expect(page.getByRole("heading", { name: "Set up akm on this computer" })).toHaveCount(0);
  await shot("setup-09-home-after");
  assert.deepEqual(errors, []);
});

/** An existing user: akm, Bun and Claude Code are installed, and the plugin is already there. */
async function withHostTools(fixture, { akmVersion = "0.10.261104" } = {}) {
  const bin = path.join(fixture.root, "bin");
  await mkdir(bin);
  await writeFile(path.join(bin, "claude"), harness(fixture.root, "claude"), { mode: 0o755 });
  await writeFile(path.join(fixture.root, "claude.json"), JSON.stringify({ marketplace: true, installed: true }));
  await writeFile(
    path.join(bin, "akm"),
    `#!${process.execPath}\nconst args = process.argv.slice(2);\nif (args[0] === '--version') console.log('${akmVersion}');\nelse console.log(JSON.stringify({ currentVersion: '${akmVersion}', latestVersion: '${akmVersion}', updateAvailable: false, plugins: [] }));\n`,
    { mode: 0o755 },
  );
  await writeFile(path.join(bin, "bun"), `#!${process.execPath}\nconsole.log('1.3.14');\n`, { mode: 0o755 });
  fixture.env.PATH = bin;
}

test("run again on an existing machine shows live state, offers the CLI update only when it is older, and tips after two minutes", {
  timeout: 120000,
}, async (t) => {
  const server = await launchFixture({ configureFixture: (fixture) => withHostTools(fixture) });
  t.after(() => server.stop());
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const screenshots = process.env.AKM_DESKTOP_SCREENSHOTS || path.join(server.root, "screenshots");
  await mkdir(screenshots, { recursive: true });
  await page.clock.install();
  await page.goto(server.url);
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  // Settings → Bundles links back to setup.
  await page.getByRole("link", { name: "Run setup again" }).click();
  await expect(page.getByText("✓ Ready")).toBeVisible();
  await expect(page.getByText("✓ 1 connected")).toBeVisible();
  await expect(page.getByText(`✓ AKM plugin ${PLUGIN}`)).toBeVisible();
  // The host akm is one build behind the engine: said once, with the update offered.
  await expect(page.getByText(/This akm is older than the engine built into this app/)).toBeVisible();
  await page.screenshot({ path: path.join(screenshots, "existing-machine-setup.png"), fullPage: true });
  await page.getByRole("button", { name: "Update CLI & plugins" }).click();
  await expect(page.getByText(/Native AKM upgrade completed/)).toBeVisible();
  // The plugin is there, but akm's config does not enable Claude Code yet: that is the one thing still offered.
  await expect(page.getByRole("checkbox", { name: "Let akm use Claude Code" })).toBeChecked();
  await expect(page.getByRole("button", { name: "Install 1 selected" })).toBeEnabled();
  // Its only harness is akm's default and there is no connection, so akm's learning runs there: said, not hidden.
  await expect(page.getByText(/Now: on, harness "fake"/)).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "Let akm learn in the background" })).toBeChecked();
  await expect(page.getByRole("radio", { checked: true })).toHaveCount(0);
  // No agent has searched: nothing is claimed, and after two minutes the page offers what to check.
  await expect(page.getByText("Waiting. Nothing has been seen yet.")).toBeVisible();
  await expect(page.getByText(/A search reached akm/)).toHaveCount(0);
  await page.clock.fastForward(125_000);
  await expect(page.getByText("No search has reached akm yet. Things to check:")).toBeVisible();
  await expect(page.getByText(/A search reached akm/)).toHaveCount(0);
});

test("a machine with the same akm as the app is not offered an update", { timeout: 120000 }, async (t) => {
  const server = await launchFixture({ configureFixture: (fixture) => withHostTools(fixture, { akmVersion: ENGINE }) });
  t.after(() => server.stop());
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await (await browser.newContext()).newPage();
  await page.goto(server.url);
  await page.goto(`${server.origin}/setup`);
  await expect(page.getByText(`akm ${ENGINE} at`)).toBeVisible();
  await expect(page.getByText(/older than the engine/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Update CLI & plugins" })).toHaveCount(0);
});

test("learning that is already on with no library says why its switch cannot be changed", {
  timeout: 120000,
}, async (t) => {
  const server = await launchFixture({
    empty: true,
    // A config that only names a model connection: learning runs on it, and there is no library yet. Nothing on PATH.
    configureFixture: async (fixture) => {
      await mkdir(path.join(fixture.root, "bin"));
      fixture.env.PATH = path.join(fixture.root, "bin");
      await mkdir(path.dirname(fixture.env.AKM_CONFIG_FILE), { recursive: true });
      await writeFile(
        fixture.env.AKM_CONFIG_FILE,
        JSON.stringify({ connections: { default: { endpoint: "http://127.0.0.1:9/v1", models: { fast: "small" } } } }),
      );
    },
  });
  t.after(() => server.stop());
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  await page.goto(server.url);
  await page.goto(`${server.origin}/setup`);
  await expect(page.getByText("Not created yet")).toBeVisible();
  const learning = page.getByRole("checkbox", { name: "Let akm learn in the background" });
  await expect(learning).toBeChecked();
  await expect(learning).toBeDisabled();
  await expect(learning).toHaveAccessibleDescription(/Create your library first\./);
});

test("errors that say the library is missing lead to setup", { timeout: 120000 }, async (t) => {
  const server = await launchFixture({
    empty: true,
    // Nothing on PATH, so that no akm, harness or Bun of the machine running the test is found.
    configureFixture: async (fixture) => {
      await mkdir(path.join(fixture.root, "bin"));
      fixture.env.PATH = path.join(fixture.root, "bin");
    },
  });
  t.after(() => server.stop());
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  const screenshots = process.env.AKM_DESKTOP_SCREENSHOTS || path.join(server.root, "screenshots");
  await mkdir(screenshots, { recursive: true });
  await page.goto(server.url);
  await page.getByRole("link", { name: "Library", exact: true }).click();
  const alert = page.getByRole("alert").filter({ hasText: "No default bundle is configured" });
  await expect(alert).toBeVisible();
  await page.screenshot({ path: path.join(screenshots, "library-search-no-library.png"), fullPage: true });
  await alert.getByRole("link", { name: "Set up akm" }).click();
  await expect(page.getByRole("heading", { name: "Set up akm", exact: true })).toBeVisible();
  // Registering a bundle with no library fails the same way, and says where to go.
  await page.goto(`${server.origin}/settings/bundles`);
  await page.getByRole("textbox", { name: "Source" }).fill(server.root);
  await page.getByRole("button", { name: "Register bundle" }).click();
  await expect(page.getByRole("alert").getByRole("link", { name: "Set up akm" })).toBeVisible();
  await page.screenshot({ path: path.join(screenshots, "settings-register-no-library.png"), fullPage: true });
  await page.goto(`${server.origin}/settings/software`);
  await expect(page.getByRole("link", { name: "Run setup again" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Install AKM CLI" })).toBeVisible();
  await page.screenshot({ path: path.join(screenshots, "software-nothing-installed.png"), fullPage: true });
});
