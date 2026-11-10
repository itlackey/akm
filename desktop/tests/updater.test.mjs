// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test, { mock } from "node:test";
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
    ...overrides,
  });
  return { autoUpdater, updater };
};

test("the update channel follows the release stage of the embedded engine", () => {
  const stable = make();
  assert.equal(stable.autoUpdater.allowPrerelease, false);
  // "latest" is electron-updater's default channel file, named so the same setter can put a build back on it.
  assert.equal(stable.autoUpdater.channel, "latest");
  assert.equal(stable.autoUpdater.allowDowngrade, false);
  assert.equal(stable.updater.status().channel, "stable");
  for (const version of ["0.10.261105-alpha", "0.10.261105-beta", "0.10.261105-rc", "0.10.261116-beta.1"]) {
    const stage = make({ version });
    assert.equal(stage.autoUpdater.allowPrerelease, true);
    // electron-updater's widest prerelease channel: the newest alpha, beta or stable release, never a downgrade.
    assert.equal(stage.autoUpdater.channel, "alpha");
    assert.equal(stage.autoUpdater.allowDowngrade, false);
    assert.equal(stage.updater.status().channel, "prerelease");
  }
});

test("a saved choice overrides the stage, checks again at once, and null returns to the stage's own line (F3)", () => {
  const { autoUpdater, updater } = make();
  updater.start();
  assert.equal(autoUpdater.checks, 1);
  updater.follow("prerelease");
  assert.equal(autoUpdater.allowPrerelease, true);
  assert.equal(autoUpdater.channel, "alpha");
  assert.equal(autoUpdater.allowDowngrade, false);
  assert.deepEqual(updater.status(), { state: "checking", channel: "prerelease" });
  assert.equal(autoUpdater.checks, 2);
  // The same choice again changes nothing and runs no check.
  updater.follow("prerelease");
  assert.equal(autoUpdater.checks, 2);
  updater.follow(null);
  assert.equal(autoUpdater.allowPrerelease, false);
  assert.equal(autoUpdater.channel, "latest");
  assert.equal(updater.status().channel, "stable");
  assert.equal(autoUpdater.checks, 3);
  // A prerelease build told to follow stable never downgrades: it waits for the next stable release.
  const beta = make({ version: "0.10.261105-beta" });
  beta.updater.follow("stable");
  assert.equal(beta.autoUpdater.allowPrerelease, false);
  assert.equal(beta.autoUpdater.allowDowngrade, false);
  assert.equal(beta.updater.status().channel, "stable");
});

test("an unsupported run never checks and says why; a supported one checks once at start", () => {
  for (const reason of ["off", "not-appimage", "development"]) {
    const off = make({ unsupportedReason: reason });
    off.updater.start();
    off.updater.follow("prerelease");
    assert.equal(off.autoUpdater.checks, 0);
    assert.deepEqual(off.updater.status(), { state: "unsupported", reason, channel: "prerelease" });
  }
  const on = make();
  on.updater.start();
  assert.equal(on.autoUpdater.checks, 1);
});

test("Linux and Windows download and install on quit; unsigned macOS only reports", () => {
  const linux = make();
  assert.equal(linux.autoUpdater.autoDownload, true);
  assert.equal(linux.autoUpdater.autoInstallOnAppQuit, true);
  linux.autoUpdater.emit("update-available", { version: "0.10.261106" });
  assert.deepEqual(linux.updater.status(), { state: "downloading", version: "0.10.261106", channel: "stable" });
  linux.autoUpdater.emit("update-downloaded", { version: "0.10.261106" });
  assert.deepEqual(linux.updater.status(), { state: "downloaded", version: "0.10.261106", channel: "stable" });
  const mac = make({ platform: "darwin" });
  assert.equal(mac.autoUpdater.autoDownload, false);
  assert.equal(mac.autoUpdater.autoInstallOnAppQuit, false);
  mac.autoUpdater.emit("update-available", { version: "0.10.261106" });
  assert.deepEqual(mac.updater.status(), { state: "available", version: "0.10.261106", channel: "stable" });
});

test("current and failed checks are reported without throwing, and a failed download is told apart (F19)", () => {
  const { autoUpdater, updater } = make();
  autoUpdater.emit("update-not-available", { version: "0.10.261105" });
  assert.equal(updater.status().state, "current");
  autoUpdater.emit("error", new Error("offline"));
  assert.deepEqual(updater.status(), { state: "error", error: "offline", during: "check", channel: "stable" });
  autoUpdater.emit("update-available", { version: "0.10.261106" });
  autoUpdater.emit("error", new Error("disk full"));
  assert.deepEqual(updater.status(), {
    state: "error",
    error: "disk full",
    during: "download",
    version: "0.10.261106",
    channel: "stable",
  });
});

test("the six-hour check runs again after an error or while a release is only reported, not while one downloads (F19)", () => {
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    const mac = make({ platform: "darwin" });
    mac.updater.start();
    mac.autoUpdater.emit("update-available", { version: "0.10.261106" });
    mock.timers.tick(6 * 60 * 60 * 1000);
    assert.equal(mac.autoUpdater.checks, 2, "a reported release does not stop later checks");
    const linux = make();
    linux.updater.start();
    linux.autoUpdater.emit("update-available", { version: "0.10.261106" });
    mock.timers.tick(6 * 60 * 60 * 1000);
    assert.equal(linux.autoUpdater.checks, 1, "a download in progress is not interrupted");
    linux.autoUpdater.emit("error", new Error("offline"));
    mock.timers.tick(6 * 60 * 60 * 1000);
    assert.equal(linux.autoUpdater.checks, 2, "an error is retried");
  } finally {
    mock.timers.reset();
  }
});
