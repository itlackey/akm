// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { _electron, expect } from "@playwright/test";
import { DESKTOP_ID, desktopEntry } from "../electron/menu-install.mjs";
import { createFixture } from "../scripts/fixture.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

test("native Electron window preserves size, sandbox, isolated data, and server lifecycle", {
  timeout: 120000,
}, async (t) => {
  const executablePath = process.env.AKM_DESKTOP_TEST_RUNTIME;
  const packageRoot = process.env.AKM_DESKTOP_TEST_APP_ROOT;
  const fixture = await createFixture({ packageRoot });
  t.after(() => fixture.cleanup());
  const app = await _electron.launch({
    chromiumSandbox: true,
    ...(executablePath ? { executablePath } : {}),
    args: executablePath ? [] : [root],
    cwd: fixture.root,
    env: fixture.env,
    timeout: 45000,
  });
  let closed = false;
  t.after(async () => {
    if (!closed) {
      // A failed dirty-document assertion must not hang test cleanup on its
      // intentional "Keep editing" dialog. This process owns synthetic data.
      await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
      await app.close().catch(() => {});
    }
  });
  const page = await app.firstWindow();
  await expect(page.getByRole("heading", { name: "Overview", exact: true })).toBeVisible();
  const origin = new URL(page.url()).origin;
  assert.equal(new URL(page.url()).searchParams.has("desktop_session"), false);
  const bounds = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds());
  const initialBounds = await bounds();
  const prefs = await app.evaluate(({ BrowserWindow }) => {
    const value = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
    return { sandbox: value.sandbox, nodeIntegration: value.nodeIntegration, contextIsolation: value.contextIsolation };
  });
  assert.deepEqual(prefs, { sandbox: true, nodeIntegration: false, contextIsolation: true });
  assert.equal(await app.evaluate(({ app }) => app.commandLine.hasSwitch("no-sandbox")), false);
  assert.equal(await page.evaluate(() => typeof require), "undefined");
  assert.equal(await page.evaluate(() => typeof process), "undefined");
  assert.equal(await page.evaluate(() => document.cookie), "");
  for (const name of ["Review", "Activity", "Settings", "Home", "Library"]) {
    await page
      .getByRole("navigation", { name: "Primary navigation" })
      .getByRole("link", { name: new RegExp(`^${name}(?:\\s|$)`) })
      .click();
    await expect(
      page.getByRole("heading", {
        name: name === "Activity" ? "Health" : name === "Home" ? "Overview" : name,
        exact: true,
      }),
    ).toBeVisible();
    assert.deepEqual(await bounds(), initialBounds, `${name} must not resize the window`);
  }
  if (executablePath?.endsWith(".AppImage")) {
    await page.getByRole("link", { name: "Settings", exact: true }).click();
    await page.getByRole("link", { name: "Software", exact: true }).click();
    // The fixture turns updates off (AKM_DESKTOP_UPDATES=off), so the test never reaches the network.
    await expect(page.getByText("To update, download a newer AKM Desktop.")).toBeVisible();
    assert.deepEqual(await bounds(), initialBounds, "Software must not resize the window");
    await page
      .getByRole("navigation", { name: "Primary navigation" })
      .getByRole("link", { name: "Library", exact: true })
      .click();
  }
  await page.getByRole("searchbox", { name: "Search library" }).fill("restore-laptop");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page
    .getByRole("region", { name: "Search results" })
    .getByRole("link")
    .filter({ hasText: "restore laptop" })
    .first()
    .click();
  await expect(page.locator(".markdown")).toContainText("Verify the checksum");
  const screenshotRoot = process.env.AKM_DESKTOP_SCREENSHOTS || path.join(fixture.root, "screenshots");
  await mkdir(screenshotRoot, { recursive: true });
  await page.screenshot({ path: path.join(screenshotRoot, "electron-library.png") });
  await page.getByRole("link", { name: "Edit page", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "Markdown source, including optional frontmatter", exact: true });
  await editor.fill(`${await editor.inputValue()}\nAn unsaved native-close check.\n`);
  await app.evaluate(({ dialog, app }) => {
    globalThis.originalDialog = dialog.showMessageBoxSync;
    globalThis.closePrompts = 0;
    dialog.showMessageBoxSync = () => {
      globalThis.closePrompts++;
      return 0;
    };
    app.quit(); // Same path used by menu/OS quit; cancel keeps the server alive.
  });
  await expect.poll(() => app.evaluate(() => globalThis.closePrompts)).toBe(1);
  await expect(editor).toBeVisible();
  assert.equal(
    await page.evaluate(async () => (await fetch("/api/desktop")).status),
    200,
    "Cancelling quit must not stop the authenticated local server",
  );
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.locator(".document-body")).toContainText("An unsaved native-close check.");
  // Navigate inside the running app, as a link click would, so the open draft state is not reloaded.
  await page.evaluate((href) => {
    const link = document.createElement("a");
    link.href = href;
    document.body.append(link);
    link.click();
    link.remove();
  }, "/library/new-sensitive?kind=secret&bundle=personal&returnTo=%2Flibrary%2Ffiles%3Fbundle%3Dpersonal");
  const secretEditor = page.getByRole("textbox", { name: "File contents", exact: true });
  await secretEditor.fill("synthetic-native-close-secret");
  assert.ok(
    !JSON.stringify(await page.evaluate(() => ({ ...sessionStorage, ...localStorage }))).includes(
      "synthetic-native-close-secret",
    ),
  );
  await app.evaluate(({ app }) => app.quit());
  await expect.poll(() => app.evaluate(() => globalThis.closePrompts)).toBe(2);
  await expect(secretEditor).toHaveValue("synthetic-native-close-secret");
  assert.deepEqual(await bounds(), initialBounds, "Protected-file editing must not resize the window");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Discard changes", exact: true }).click();
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBoxSync = globalThis.originalDialog;
  });
  await app.close();
  closed = true;
  await expect
    .poll(
      async () => {
        try {
          await fetch(origin, { signal: AbortSignal.timeout(1000) });
          return true;
        } catch {
          return false;
        }
      },
      { timeout: 10000 },
    )
    .toBe(false);
});

test("Software says why a build does not check for updates, and its Desktop updates choice reaches the updater", {
  skip: Boolean(process.env.AKM_DESKTOP_TEST_RUNTIME),
  timeout: 180000,
}, async () => {
  // An unpackaged app is a development run. packaged-run.cjs, loaded with -r, makes it answer `app.isPackaged` as an
  // installed build does, so the reasons an installed build gives are shown without packaging it.
  const packaged = ["-r", path.join(root, "tests/packaged-run.cjs")];
  const runs = [
    { reason: "development", args: [], updates: "off", says: "A development run does not check for updates." },
    { reason: "off", args: packaged, updates: "off", says: "Update checks are turned off (AKM_DESKTOP_UPDATES=off)." },
    // Elsewhere a packaged build with updates on would check, and reach for the network.
    ...(process.platform === "linux"
      ? [
          {
            reason: "not-appimage",
            args: packaged,
            updates: undefined,
            says: "This Linux build is not an AppImage, so it does not check for updates.",
          },
        ]
      : []),
  ];
  for (const run of runs) {
    const fixture = await createFixture();
    // Software looks for host tools on PATH; this test is about Desktop's own row, so there are none to start.
    fixture.env.PATH = path.join(fixture.root, "no-host-tools");
    await mkdir(fixture.env.PATH);
    if (run.updates === undefined) delete fixture.env.AKM_DESKTOP_UPDATES;
    const app = await _electron.launch({
      chromiumSandbox: true,
      args: [...run.args, root],
      cwd: fixture.root,
      env: fixture.env,
      timeout: 45000,
    });
    try {
      const page = await app.firstWindow();
      await expect(page.getByRole("heading", { name: "Overview", exact: true })).toBeVisible();
      await page.getByRole("link", { name: "Settings", exact: true }).click();
      await page.getByRole("link", { name: "Software", exact: true }).click();
      await expect(page.locator("#desktop-update-status"), run.reason).toHaveText(
        `${run.says} To update, download a newer AKM Desktop.`,
      );
      if (run.reason === "development") {
        // electron-updater's own updater in the main process: the one electron/main.mjs configures.
        const updater = () =>
          app.evaluate(({ app }) => {
            const require = process.getBuiltinModule("node:module").createRequire(`${app.getAppPath()}/package.json`);
            const { autoUpdater } = require("electron-updater");
            return { allowPrerelease: autoUpdater.allowPrerelease, allowDowngrade: autoUpdater.allowDowngrade };
          });
        assert.deepEqual(await updater(), { allowPrerelease: false, allowDowngrade: false });
        const choice = page.getByRole("combobox", { name: "Desktop updates", exact: true });
        await choice.selectOption("prerelease");
        await expect.poll(updater).toEqual({ allowPrerelease: true, allowDowngrade: false });
        await choice.selectOption("stable");
        await expect.poll(updater).toEqual({ allowPrerelease: false, allowDowngrade: false });
      }
      await app.close();
    } catch (error) {
      await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
      await app.close().catch(() => {});
      throw error;
    } finally {
      await fixture.cleanup();
    }
  }
});

test("AppImage installs a real per-user menu copy, confirms replacements, and launches that copy", {
  skip: !process.env.AKM_DESKTOP_TEST_RUNTIME?.endsWith(".AppImage"),
  timeout: 120000,
}, async (t) => {
  const runtime = process.env.AKM_DESKTOP_TEST_RUNTIME;
  const fixture = await createFixture({ packageRoot: process.env.AKM_DESKTOP_TEST_APP_ROOT });
  t.after(() => fixture.cleanup());
  const stable = path.join(fixture.env.HOME, ".local/bin/akm-desktop.AppImage");
  const entryPath = path.join(fixture.env.XDG_DATA_HOME, `applications/${DESKTOP_ID}.desktop`);
  let app;
  t.after(async () => {
    if (app) {
      await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
      await app.close().catch(() => {});
    }
  });
  const launch = (executablePath) =>
    _electron.launch({
      executablePath,
      args: [],
      cwd: fixture.root,
      env: fixture.env,
      chromiumSandbox: true,
      timeout: 45000,
    });
  const software = async (page) => {
    await expect(page.getByRole("heading", { name: "Overview", exact: true })).toBeVisible();
    await page.getByRole("link", { name: "Settings", exact: true }).click();
    await page.getByRole("link", { name: "Software", exact: true }).click();
  };
  app = await launch(runtime);
  // Refuse to test any installation if Electron did not honor the synthetic home.
  assert.equal(await app.evaluate(({ app }) => app.getPath("home")), fixture.env.HOME);
  const page = await app.firstWindow();
  await software(page);
  await assert.rejects(stat(entryPath), { code: "ENOENT" });
  const screenshots = process.env.AKM_DESKTOP_SCREENSHOTS || path.join(fixture.root, "screenshots");
  await mkdir(screenshots, { recursive: true });
  await page.screenshot({ path: path.join(screenshots, "menu-before.png"), fullPage: true });
  await page.getByRole("button", { name: "Add to application menu", exact: true }).click();
  await expect(page.getByText("Added to your application menu", { exact: true })).toBeVisible({ timeout: 20000 });
  assert.equal(await readFile(entryPath, "utf8"), desktopEntry(stable));
  assert.equal((await stat(stable)).mode & 0o777, 0o755);
  const hash = async (file) =>
    createHash("sha256")
      .update(await readFile(file))
      .digest("hex");
  assert.equal(await hash(stable), await hash(runtime));
  const icon = path.join(fixture.env.XDG_DATA_HOME, `icons/hicolor/512x512/apps/${DESKTOP_ID}.png`);
  assert.equal(await hash(icon), await hash(path.join(root, "resources/512x512.png")));
  try {
    execFileSync("desktop-file-validate", [entryPath], { stdio: "pipe" });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await page.screenshot({ path: path.join(screenshots, "menu-installed.png"), fullPage: true });
  await app.evaluate(({ dialog }) => {
    globalThis.menuConfirmations = [];
    dialog.showMessageBox = async (_window, options) => {
      globalThis.menuConfirmations.push(options);
      return new Promise((resolve) => {
        globalThis.finishMenuConsent = resolve;
      });
    };
  });
  await page.getByRole("button", { name: "Replace menu copy…", exact: true }).click();
  await expect.poll(() => app.evaluate(() => globalThis.menuConfirmations.length)).toBe(1);
  await app.evaluate(({ dialog, app }) => {
    globalThis.closeDuringMenu = 0;
    globalThis.oldSyncDialog = dialog.showMessageBoxSync;
    dialog.showMessageBoxSync = () => {
      globalThis.closeDuringMenu++;
      return 0;
    };
    app.quit();
  });
  assert.equal(await app.evaluate(() => globalThis.closeDuringMenu), 1);
  assert.equal(await page.evaluate(async () => (await fetch("/api/desktop")).status), 200);
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBoxSync = globalThis.oldSyncDialog;
    globalThis.finishMenuConsent({ response: 0 });
  });
  await expect(page.getByRole("button", { name: "Replace menu copy…", exact: true })).toBeEnabled();
  const consent = await app.evaluate(() => globalThis.menuConfirmations[0]);
  assert.equal(consent.cancelId, 0);
  assert.equal(consent.defaultId, 0);
  assert.ok(consent.detail.includes(stable) && consent.detail.includes("may be newer"));
  assert.equal(await hash(stable), await hash(runtime));
  await app.close();
  app = undefined;
  // Launch the exact executable referenced by the installed menu, not the download.
  app = await launch(stable);
  const installedPage = await app.firstWindow();
  await software(installedPage);
  await expect(installedPage.getByRole("button", { name: "Repair menu entry", exact: true })).toBeVisible();
  await installedPage.getByRole("button", { name: "Repair menu entry", exact: true }).click();
  await expect(installedPage.getByRole("button", { name: "Repair menu entry", exact: true })).toBeEnabled();
  assert.equal(await hash(stable), await hash(runtime));
  await installedPage.getByRole("link", { name: "Library", exact: true }).click();
  await expect(installedPage.getByRole("heading", { name: "Library", exact: true })).toBeVisible();
  await app.close();
  app = undefined;
});
