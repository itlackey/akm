// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, dialog, session, shell } from "electron";
import { DESKTOP_ID, DesktopMenu } from "./menu-install.mjs";

/** @typedef {{ type?: string, busy?: boolean, id?: string, action?: string, url?: string, origin?: string }} ChildMessage */
/** @type {import("node:child_process").ChildProcess | undefined} */
let child;
/** @type {import("electron").BrowserWindow | undefined} */
let window;
let stopping = false;
let stopped = false;
/** @type {DesktopMenu | undefined} */
let desktopMenu;
/** @type {string | undefined} */
let menuError;
let hostOperation = false;
if (process.platform === "linux") app.setDesktopName(`${DESKTOP_ID}.desktop`);
const ownsInstance = app.requestSingleInstanceLock();
app.on("second-instance", () => {
  if (window && !window.isDestroyed()) {
    if (window.isMinimized()) window.restore();
    window.focus();
  }
});
function canClose() {
  if (!hostOperation && !desktopMenu?.busy()) return true;
  const options = {
    type: /** @type {const} */ ("info"),
    title: "Installation in progress",
    message: "Wait for the installation to finish before closing AKM Desktop.",
  };
  if (window) dialog.showMessageBoxSync(window, options);
  else dialog.showMessageBoxSync(options);
  return false;
}

async function stopServer() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const server = child;
  await new Promise((/** @type {(value?: unknown) => void} */ resolve) => {
    const timer = setTimeout(() => {
      server.kill("SIGKILL");
      resolve();
    }, 5000);
    server.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    if (server.connected) server.send("shutdown");
    else server.kill("SIGTERM");
  });
}

app.on("before-quit", (event) => {
  if (stopped) return;
  event.preventDefault();
  if (!canClose()) return;
  if (window && !window.isDestroyed()) {
    window.close();
    return;
  }
  if (stopping) return;
  stopping = true;
  void stopServer().finally(() => {
    stopped = true;
    app.quit();
  });
});
app.on("window-all-closed", () => app.quit());

// Do not top-level-await ready: Electron must finish loading the ESM entry
// module before it can complete application readiness.
if (!ownsInstance) app.quit();
else
  void app.whenReady().then(async () => {
    try {
      desktopMenu = new DesktopMenu({
        platform: process.platform,
        packaged: app.isPackaged,
        appImage: process.env.APPIMAGE,
        home: app.getPath("home"),
        dataHome: process.env.XDG_DATA_HOME,
        icon: fileURLToPath(new URL("../resources/512x512.png", import.meta.url)),
      });
      const server = fork(fileURLToPath(new URL("./server.mjs", import.meta.url)), [], {
        execPath: process.execPath,
        execArgv: [],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", AKM_DESKTOP_NATIVE: "1" },
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        windowsHide: true,
      });
      child = server;
      const menu = desktopMenu;
      server.stderr?.on("data", (chunk) => process.stderr.write(chunk));
      server.stdout?.resume();
      server.on("message", async (raw) => {
        const message = /** @type {ChildMessage} */ (raw);
        if (message?.type === "desktop-host-operation") {
          hostOperation = message.busy === true;
          return;
        }
        if (message?.type !== "desktop-request" || typeof message.id !== "string") return;
        try {
          if (!message.action || !["status", "menu-install"].includes(message.action))
            throw new Error("Unknown software action.");
          if (message.action === "menu-install") {
            if (menu.busy()) throw new Error("Wait for menu installation to finish.");
            menuError = undefined;
            // Return immediately; polling shows progress while native consent stays open.
            // Avoid a timed-out HTTP request that later performs an unexpected write.
            void menu
              .install(async () => {
                const options = {
                  type: /** @type {const} */ ("question"),
                  title: "Replace application menu copy",
                  message: `Replace the menu copy with AKM Desktop ${app.getVersion()}?`,
                  detail: `This replaces ${menu.paths.appImage} with this running download. The installed copy may be newer. Cancel and open AKM Desktop from the application menu to keep it. Your knowledge and settings are unchanged.`,
                  buttons: ["Cancel", "Replace menu copy"],
                  defaultId: 0,
                  cancelId: 0,
                };
                const result = await (window ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options));
                return result.response === 1;
              })
              .catch((/** @type {Error} */ error) => {
                menuError = error.message;
              });
          }
          if (server.connected)
            server.send({
              type: "desktop-response",
              id: message.id,
              data: { version: app.getVersion(), menu: { ...(await menu.status()), error: menuError } },
            });
        } catch (error) {
          if (server.connected)
            server.send({ type: "desktop-response", id: message.id, error: /** @type {Error} */ (error).message });
        }
      });
      const ready = await new Promise((/** @type {(value: ChildMessage) => void} */ resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Local server startup timed out.")), 30000);
        const failed = (/** @type {Error} */ error) => {
          clearTimeout(timer);
          reject(error);
        };
        server.once("error", failed);
        server.once("exit", (code) => failed(new Error(`Local server stopped (${code}).`)));
        server.on("message", (raw) => {
          const message = /** @type {ChildMessage} */ (raw);
          if (message?.type === "ready" && typeof message.url === "string") {
            clearTimeout(timer);
            resolve(message);
          }
        });
      });
      const origin = ready.origin;
      const appSession = session.fromPartition(`akm-desktop-${process.pid}-${Date.now()}`);
      appSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      appSession.setPermissionCheckHandler(() => false);
      appSession.on("will-download", (event) => event.preventDefault());
      const win = new BrowserWindow({
        width: 1280,
        height: 860,
        minWidth: 900,
        minHeight: 620,
        title: "AKM Desktop",
        show: false,
        icon: fileURLToPath(new URL("../resources/512x512.png", import.meta.url)),
        webPreferences: {
          session: appSession,
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          webSecurity: true,
        },
      });
      window = win;
      win.on("close", (event) => {
        if (!canClose()) event.preventDefault();
      });
      const openExternal = (/** @type {string} */ destination) => {
        try {
          const url = new URL(destination);
          if (url.origin !== origin && ["http:", "https:"].includes(url.protocol)) void shell.openExternal(url.href);
        } catch {
          /* Never hand invalid or custom-scheme URLs to the operating system. */
        }
      };
      win.webContents.setWindowOpenHandler(({ url }) => {
        openExternal(url);
        return { action: "deny" };
      });
      win.webContents.on("will-navigate", (event, destination) => {
        if (new URL(destination).origin !== origin) {
          event.preventDefault();
          openExternal(destination);
        }
      });
      win.webContents.on("will-attach-webview", (event) => event.preventDefault());
      win.webContents.on("will-prevent-unload", (event) => {
        const choice = dialog.showMessageBoxSync(win, {
          type: "question",
          title: "Unsaved changes",
          message: "Quit with unsaved changes?",
          detail: "Return to your document to save it before closing.",
          buttons: ["Keep editing", "Quit without saving"],
          defaultId: 0,
          cancelId: 0,
        });
        if (choice === 1) event.preventDefault();
      });
      server.on("exit", () => {
        if (!stopping) app.quit();
      });
      await win.loadURL(String(ready.url));
      win.show();
    } catch (error) {
      dialog.showErrorBox("AKM Desktop could not start", error instanceof Error ? error.message : String(error));
      app.quit();
    }
  });
