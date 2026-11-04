// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createUpdater } from "../electron/updater.mjs";

function fake() {
  const updater = Object.assign(new EventEmitter(), {
    checks: 0,
    checkForUpdates() {
      this.checks++;
      return Promise.resolve();
    },
  });
  return updater;
}
const make = (overrides = {}) => {
  const autoUpdater = fake();
  const updater = createUpdater({
    autoUpdater,
    version: "0.10.261105",
    platform: "linux",
    supported: true,
    ...overrides,
  });
  return { autoUpdater, updater };
};

test("the update channel follows the release stage of the embedded engine", () => {
  assert.equal(make().autoUpdater.allowPrerelease, false);
  assert.equal(make({ version: "0.10.261105-beta" }).autoUpdater.allowPrerelease, true);
  assert.equal(make({ version: "0.10.261105-rc" }).autoUpdater.allowPrerelease, true);
});

test("an unsupported run never checks; a supported one checks once at start", () => {
  const off = make({ supported: false });
  off.updater.start();
  assert.equal(off.autoUpdater.checks, 0);
  assert.equal(off.updater.status().state, "unsupported");
  const on = make();
  on.updater.start();
  assert.equal(on.autoUpdater.checks, 1);
});

test("Linux and Windows download and install on quit; unsigned macOS only reports", () => {
  const linux = make();
  assert.equal(linux.autoUpdater.autoDownload, true);
  assert.equal(linux.autoUpdater.autoInstallOnAppQuit, true);
  linux.autoUpdater.emit("update-available", { version: "0.10.261106" });
  assert.deepEqual(linux.updater.status(), { state: "downloading", version: "0.10.261106" });
  linux.autoUpdater.emit("update-downloaded", { version: "0.10.261106" });
  assert.deepEqual(linux.updater.status(), { state: "downloaded", version: "0.10.261106" });
  const mac = make({ platform: "darwin" });
  assert.equal(mac.autoUpdater.autoDownload, false);
  assert.equal(mac.autoUpdater.autoInstallOnAppQuit, false);
  mac.autoUpdater.emit("update-available", { version: "0.10.261106" });
  assert.deepEqual(mac.updater.status(), { state: "available", version: "0.10.261106" });
});

test("current and failed checks are reported without throwing", () => {
  const { autoUpdater, updater } = make();
  autoUpdater.emit("update-not-available", { version: "0.10.261105" });
  assert.equal(updater.status().state, "current");
  autoUpdater.emit("error", new Error("offline"));
  assert.deepEqual(updater.status(), { state: "error", error: "offline" });
});
