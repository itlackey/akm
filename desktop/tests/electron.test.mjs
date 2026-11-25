// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { _electron, expect } from "@playwright/test";
import { addServerAuthorization, isServerRequest } from "../electron/auth-header.mjs";
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
  assert.equal(new URL(page.url()).search, "", "the window's URL carries no credential");
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
  const editor = page.getByRole("textbox", { name: /^Markdown (body|source, including optional frontmatter)$/ });
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

test("Reveal in file manager reaches the main process: the menu offers it, and choosing it shows that file", {
  skip: Boolean(process.env.AKM_DESKTOP_TEST_RUNTIME),
  timeout: 120000,
}, async () => {
  const fixture = await createFixture();
  const app = await _electron.launch({
    chromiumSandbox: true,
    args: [root],
    cwd: fixture.root,
    env: fixture.env,
    timeout: 45000,
  });
  try {
    // The system file manager is not opened: the main process's call is recorded instead.
    await app.evaluate(({ shell }) => {
      globalThis.revealed = [];
      shell.showItemInFolder = (file) => globalThis.revealed.push(file);
    });
    const page = await app.firstWindow();
    await expect(page.getByRole("heading", { name: "Overview", exact: true })).toBeVisible();
    await page.goto(new URL("/library/files?bundle=personal&path=knowledge", page.url()).href);
    await page.getByRole("button", { name: "Actions for restore-laptop.md", exact: true }).click();
    await page.getByRole("menuitem", { name: "Reveal in file manager", exact: true }).click();
    await expect.poll(() => app.evaluate(() => globalThis.revealed.length)).toBe(1);
    const [shown] = await app.evaluate(() => globalThis.revealed);
    assert.equal(
      await realpath(shown),
      await realpath(path.join(fixture.root, "personal/knowledge/restore-laptop.md")),
    );
    await app.close();
  } catch (error) {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await app.close().catch(() => {});
    throw error;
  } finally {
    await fixture.cleanup();
  }
});

/** The environment of a process, or "" when it cannot be read (it ended, or this is not Linux). */
const environOf = (/** @type {string | number} */ pid) => readFile(`/proc/${pid}/environ`, "latin1").catch(() => "");

/** Direct children of a process (Linux). */
async function childrenOf(/** @type {number} */ parent) {
  const found = [];
  for (const entry of await readdir("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    const stat = await readFile(`/proc/${entry}/stat`, "latin1").catch(() => "");
    // Fields after the parenthesised command name: state, ppid, ...
    if (Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]) === parent) found.push(Number(entry));
  }
  return found;
}

/** The per-launch secret, read from the server's start-up environment: only a test on Linux can see it. */
async function launchSecret(/** @type {number} */ mainPid) {
  for (const pid of await childrenOf(mainPid)) {
    const match = /(?:^|\0)AKM_WEB_SECRET=([^\0]+)/.exec(await environOf(pid));
    if (match) return { secret: match[1], serverPid: pid };
  }
  throw new Error("The server's secret was not found.");
}

/** A local server that records the headers of every request it gets. */
async function recorder(/** @type {(request: import("node:http").IncomingMessage) => string | undefined} */ redirect) {
  const seen = /** @type {Array<{ url: string, headers: import("node:http").IncomingHttpHeaders }>} */ ([]);
  const server = http.createServer((request, response) => {
    seen.push({ url: request.url ?? "", headers: request.headers });
    const to = redirect(request);
    if (to) response.writeHead(302, { location: to }).end();
    else response.writeHead(200, { "access-control-allow-origin": "*" }).end("ok");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  const origin = `http://127.0.0.1:${/** @type {import("node:net").AddressInfo} */ (server.address()).port}`;
  return { seen, origin, close: () => new Promise((resolve) => server.close(() => resolve(undefined))) };
}

test("the header filter matches the server's origin exactly and adds nothing elsewhere", async () => {
  const origin = "http://127.0.0.1:4100";
  assert.equal(isServerRequest("http://127.0.0.1:4100/api/session", origin), true);
  for (const url of [
    "http://127.0.0.1:4101/",
    "http://localhost:4100/",
    "https://127.0.0.1:4100/",
    "http://127.0.0.1:4100@evil.example/",
    "http://evil.example/http://127.0.0.1:4100/",
    "not a url",
  ])
    assert.equal(isServerRequest(url, origin), false, url);
  assert.equal(isServerRequest("http://127.0.0.1:4100/", "http://127.0.0.1:4100/path"), false);
  let handler;
  let removed = false;
  const remove = addServerAuthorization(
    {
      webRequest: {
        /** @type {any} */
        onBeforeSendHeaders: (/** @type {any} */ filter, /** @type {any} */ listener) => {
          if (listener) {
            assert.deepEqual(filter, { urls: [`${origin}/*`] });
            handler = listener;
          } else removed = filter === null;
        },
      },
    },
    origin,
    "s".repeat(40),
  );
  const run = (url) => new Promise((resolve) => handler({ url, requestHeaders: { Accept: "*/*" } }, resolve));
  assert.equal((await run(`${origin}/x`)).requestHeaders.Authorization, `Bearer ${"s".repeat(40)}`);
  assert.equal((await run("http://127.0.0.1:4101/x")).requestHeaders.Authorization, undefined);
  remove();
  assert.equal(removed, true);
});

test("Desktop starts with no configuration, keeps its secret to itself, and sends it only to its own origin", {
  skip: Boolean(process.env.AKM_DESKTOP_TEST_RUNTIME) || process.platform !== "linux",
  timeout: 120000,
}, async (t) => {
  const fixture = await createFixture();
  const other = await recorder((request) =>
    request.url === "/redirect-to-akm" ? `${launched.origin}/api/session` : undefined,
  );
  t.after(() => other.close());
  /** @type {{ origin: string }} */
  const launched = { origin: "" };
  const app = await _electron.launch({
    chromiumSandbox: true,
    args: [root],
    cwd: fixture.root,
    env: fixture.env,
    timeout: 45000,
  });
  const output = /** @type {string[]} */ ([]);
  app.process().stdout?.on("data", (chunk) => output.push(String(chunk)));
  app.process().stderr?.on("data", (chunk) => output.push(String(chunk)));
  t.after(async () => {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await app.close().catch(() => {});
    await fixture.cleanup();
  });
  const page = await app.firstWindow();
  await expect(page.getByRole("heading", { name: "Overview", exact: true })).toBeVisible();
  launched.origin = new URL(page.url()).origin;
  const { secret, serverPid } = await launchSecret(app.process().pid);
  assert.ok(secret.length >= 32);
  assert.ok(launched.origin.startsWith("http://127.0.0.1:"));

  // The secret is nowhere the window, the page or a log can reach.
  assert.equal(page.url(), `${launched.origin}/`);
  assert.equal(await page.evaluate(() => document.cookie), "");
  assert.equal(
    await page.evaluate(async () => ({ ...(await (await fetch("/api/session")).json()) })).then((v) => v.ok),
    true,
    "the page is signed in by the header alone",
  );
  assert.ok(!(await page.content()).includes(secret));
  assert.ok(!JSON.stringify(await page.evaluate(() => ({ ...sessionStorage, ...localStorage }))).includes(secret));
  assert.ok(!output.join("").includes(secret), "process output");
  for (const pid of await childrenOf(app.process().pid))
    if (pid !== serverPid) assert.ok(!(await environOf(pid)).includes(secret), `environment of child ${pid}`);
  assert.ok(!(await environOf(app.process().pid)).includes(secret), "environment of the main process");

  // The header goes to the server's origin and to nothing else: not another origin, not a redirect that leaves it,
  // not an external link, not another session.
  const asked = () => other.seen.map((request) => request.headers.authorization);
  // The page's own policy keeps it from fetching other origins, so these go through the window's session, which is
  // where the header is added.
  const windowFetch = (/** @type {string} */ url) =>
    app.evaluate(
      async ({ BrowserWindow }, target) =>
        (await BrowserWindow.getAllWindows()[0].webContents.session.fetch(target)).status,
      url,
    );
  assert.equal(await windowFetch(`${other.origin}/direct`), 200);
  assert.equal(other.seen.length, 1);
  await app.evaluate(
    ({ BrowserWindow }, { from, to }) => {
      // An address on the server's origin that redirects to another origin.
      BrowserWindow.getAllWindows()[0].webContents.session.webRequest.onBeforeRequest(
        { urls: [`${from}/leave`] },
        (_details, callback) => callback({ redirectURL: to }),
      );
    },
    { from: launched.origin, to: `${other.origin}/redirected` },
  );
  await windowFetch(`${launched.origin}/leave`);
  assert.equal(other.seen.at(-1)?.url, "/redirected");
  await windowFetch(`${other.origin}/redirect-to-akm`);
  assert.ok(
    asked().every((value) => value === undefined),
    "no header reaches another origin",
  );

  await app.evaluate(({ shell }) => {
    globalThis.external = [];
    shell.openExternal = async (url) => void globalThis.external.push(url);
  });
  await page.evaluate((url) => {
    const link = document.createElement("a");
    link.href = url;
    link.target = "_blank";
    document.body.append(link);
    link.click();
  }, `${other.origin}/link`);
  await page.evaluate((url) => {
    location.href = url;
  }, `${other.origin}/navigate`);
  await expect.poll(() => app.evaluate(() => globalThis.external.length)).toBe(2);
  assert.equal(page.url(), `${launched.origin}/`);
  assert.ok(
    other.seen.every((request) => !["/link", "/navigate"].includes(request.url)),
    "links open outside",
  );
  assert.ok(asked().every((value) => value === undefined));

  const statusIn = (partition) =>
    app.evaluate(
      async ({ session }, { url, partition }) => {
        const target = partition ? session.fromPartition(partition) : session.defaultSession;
        return (await target.fetch(url)).status;
      },
      { url: `${launched.origin}/api/session`, partition },
    );
  assert.equal(await statusIn(undefined), 401, "the default session has no header");
  assert.equal(await statusIn("akm-test-other"), 401, "another partition has no header");
  assert.equal(
    await app.evaluate(
      async ({ BrowserWindow }, url) => (await BrowserWindow.getAllWindows()[0].webContents.session.fetch(url)).status,
      `${launched.origin}/api/session`,
    ),
    200,
    "the window's own session does",
  );

  // Closing the window removes the handler: its session sends no header afterwards (app.quit is held back so the
  // server stays up to answer).
  const afterClose = await app.evaluate(async ({ BrowserWindow, app }, url) => {
    const quit = app.quit;
    app.quit = () => {};
    const win = BrowserWindow.getAllWindows()[0];
    const closing = new Promise((resolve) => win.once("closed", resolve));
    const windowSession = win.webContents.session;
    win.close();
    await closing;
    const status = (await windowSession.fetch(url)).status;
    app.quit = quit;
    return status;
  }, `${launched.origin}/api/session`);
  assert.equal(afterClose, 401);
});

test("Desktop ignores experimental.web: loopback, its own origin, its own secret", {
  skip: Boolean(process.env.AKM_DESKTOP_TEST_RUNTIME) || process.platform !== "linux",
  timeout: 120000,
}, async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.cleanup());
  const remoteSecret = "remote-hosting-secret-".padEnd(48, "r");
  const configPath = path.join(fixture.root, "config/config.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.experimental = {
    web: {
      host: "0.0.0.0",
      port: 47311,
      origin: "https://assistant.example.test",
      secret: "$AKM_TEST_REMOTE_SECRET",
      allowedHosts: ["assistant.internal"],
    },
  };
  await writeFile(configPath, JSON.stringify(config, null, 2));
  const app = await _electron.launch({
    chromiumSandbox: true,
    args: [root],
    cwd: fixture.root,
    env: { ...fixture.env, AKM_TEST_REMOTE_SECRET: remoteSecret },
    timeout: 45000,
  });
  t.after(async () => {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await app.close().catch(() => {});
  });
  const page = await app.firstWindow();
  await expect(page.getByRole("heading", { name: "Overview", exact: true })).toBeVisible();
  const url = new URL(page.url());
  assert.equal(url.hostname, "127.0.0.1");
  assert.notEqual(url.port, "47311");
  const { secret, serverPid } = await launchSecret(app.process().pid);
  assert.notEqual(secret, remoteSecret);
  const asServer = (/** @type {Record<string, string>} */ headers) => fetch(`${url.origin}/api/session`, { headers });
  assert.equal((await asServer({ Authorization: `Bearer ${remoteSecret}` })).status, 401, "the configured secret");
  assert.equal((await asServer({ Authorization: `Bearer ${secret}` })).status, 200, "the launch's own secret");
  assert.ok(serverPid > 0);
});
