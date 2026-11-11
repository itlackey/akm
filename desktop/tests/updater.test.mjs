// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test, { mock } from "node:test";
import { GitHubProvider } from "electron-updater/out/providers/GitHubProvider.js";
import { HighestReleaseProvider, highestRelease } from "../electron/release-feed.mjs";
import { createUpdater } from "../electron/updater.mjs";

function fake() {
  const updater = Object.assign(new EventEmitter(), {
    checks: 0,
    checkForUpdates() {
      this.checks++;
      return Promise.resolve();
    },
    setFeedURL(options) {
      this.feed = options;
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
  assert.equal(stable.autoUpdater.allowDowngrade, false);
  assert.equal(stable.updater.status().channel, "stable");
  // The feed is this repository's GitHub releases, read by Desktop's provider; no channel name narrows it.
  assert.deepEqual(stable.autoUpdater.feed, {
    provider: "custom",
    updateProvider: HighestReleaseProvider,
    owner: "itlackey",
    repo: "akm",
  });
  assert.equal(stable.autoUpdater.channel, undefined);
  for (const version of ["0.10.261105-alpha", "0.10.261105-beta", "0.10.261105-rc", "0.10.261116-beta.1"]) {
    const stage = make({ version });
    assert.equal(stage.autoUpdater.allowPrerelease, true);
    assert.equal(stage.autoUpdater.allowDowngrade, false);
    assert.equal(stage.updater.status().channel, "prerelease");
  }
});

test("the highest release is the highest version, any stage, in semver order", () => {
  assert.equal(highestRelease([]), undefined);
  assert.equal(highestRelease(["latest", "desktop-1"]), undefined);
  assert.equal(highestRelease(["v0.10.261203", "v0.11.261201-beta.1", "v0.10.261202"]), "v0.11.261201-beta.1");
  assert.equal(highestRelease(["v0.11.261201-beta.9", "v0.11.261201-beta.10"]), "v0.11.261201-beta.10");
  assert.equal(
    highestRelease(["v0.11.261201-beta.2", "v0.11.261201-rc.1", "v0.11.261201-alpha.3"]),
    "v0.11.261201-rc.1",
  );
  assert.equal(highestRelease(["v0.11.261201-rc.2", "v0.11.261201"]), "v0.11.261201");
  // A bare stage published before the counter rule is below its first counted prerelease.
  assert.equal(highestRelease(["v0.10.261115-beta", "v0.10.261115-beta.1"]), "v0.10.261115-beta.1");
  assert.equal(highestRelease(["v0.10.261131", "v0.10.261201"]), "v0.10.261201");
});

test("a saved choice overrides the stage, checks again at once, and null returns to the stage's own line (F3)", () => {
  const { autoUpdater, updater } = make();
  updater.start();
  assert.equal(autoUpdater.checks, 1);
  updater.follow("prerelease");
  assert.equal(autoUpdater.allowPrerelease, true);
  assert.equal(autoUpdater.allowDowngrade, false);
  assert.deepEqual(updater.status(), { state: "checking", channel: "prerelease" });
  assert.equal(autoUpdater.checks, 2);
  // The same choice again changes nothing and runs no check.
  updater.follow("prerelease");
  assert.equal(autoUpdater.checks, 2);
  updater.follow(null);
  assert.equal(autoUpdater.allowPrerelease, false);
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

// GitHub's releases.atom lists releases newest first by publish date, not by version. With two release lines open, a
// 0.10 release published after a 0.11 prerelease is listed before it.
const atom = (tags) => `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="en-US">
  <link type="text/html" rel="alternate" href="https://github.com/itlackey/akm/releases"/>
${tags.map((tag) => `  <entry><link rel="alternate" type="text/html" href="https://github.com/itlackey/akm/releases/tag/${tag}"/><title>${tag}</title><content type="html">No content.</content></entry>`).join("\n")}
</feed>`;

/**
 * The version the installed electron-updater would offer this updater from GitHub: through the provider Desktop sets
 * with setFeedURL, else electron-updater's own GitHub provider (app-update.yml). Each release carries the channel file
 * electron-builder writes for its version: `<stage>-linux.yml` for a stage release, `latest-linux.yml` for a stable.
 */
async function offered(autoUpdater, { feed, latest = "" }) {
  const requests = [];
  const executor = {
    async request(options) {
      requests.push(options.path);
      if (options.path === "/itlackey/akm/releases.atom") return atom(feed);
      if (options.path === "/itlackey/akm/releases/latest") return JSON.stringify({ tag_name: latest });
      const [, version, file] = /^\/itlackey\/akm\/releases\/download\/v([^/]+)\/(.+)$/.exec(options.path) ?? [];
      if (version && file === `${/-([a-z]+)/.exec(version)?.[1] ?? "latest"}-linux.yml`)
        return `version: ${version}\nfiles:\n  - url: AKM-Desktop-${version}-x86_64.AppImage\n    sha512: x\npath: AKM-Desktop-${version}-x86_64.AppImage\nsha512: x\n`;
      throw new Error(`404 ${options.path}`);
    },
  };
  const { updateProvider: Provider = GitHubProvider, ...options } = autoUpdater.feed ?? {
    provider: "github",
    owner: "itlackey",
    repo: "akm",
  };
  const provider = new Provider(options, autoUpdater, {
    executor,
    platform: "linux",
    isUseMultipleRangeRequest: false,
  });
  return { version: (await provider.getLatestVersion()).version, requests };
}

test("stable and prerelease releases offer the highest version, not the first in the feed (F20)", async () => {
  // A 0.10 stable published after the newest 0.11 prerelease: listed first, and lower than this 0.11 build.
  const feed = ["v0.10.261203", "v0.11.261201-beta.2", "v0.11.261201-beta.1", "v0.10.261202"];
  const beta = make({ version: "0.11.261201-beta.1" });
  assert.equal((await offered(beta.autoUpdater, { feed })).version, "0.11.261201-beta.2");
  // A stable build that chose prereleases is offered the highest of both lines, as npm's `next` would be.
  const stable = make({ version: "0.10.261202" });
  stable.updater.follow("prerelease");
  assert.equal((await offered(stable.autoUpdater, { feed })).version, "0.11.261201-beta.2");
  // An rc is a prerelease like the others.
  const rc = make({ version: "0.11.261201-beta.1" });
  const withRc = ["v0.10.261203", "v0.11.261201-rc.1", "v0.11.261201-beta.2"];
  assert.equal((await offered(rc.autoUpdater, { feed: withRc })).version, "0.11.261201-rc.1");
});

test("stable releases are GitHub's latest release, whatever the feed lists first", async () => {
  const feed = ["v0.11.261201-beta.2", "v0.10.261203", "v0.10.261202"];
  const { autoUpdater } = make({ version: "0.10.261202" });
  const { version, requests } = await offered(autoUpdater, { feed, latest: "v0.10.261203" });
  assert.equal(version, "0.10.261203");
  assert.deepEqual(
    requests.filter((path) => !path.endsWith(".atom")),
    ["/itlackey/akm/releases/latest", "/itlackey/akm/releases/download/v0.10.261203/latest-linux.yml"],
  );
});

test("choosing stable stops a queued or incoming prerelease from installing (#1609-2)", async () => {
  for (const stage of ["downloading", "downloaded"]) {
    const { autoUpdater, updater } = make({ version: "0.11.261201-beta.1" });
    updater.start();
    autoUpdater.emit("update-available", { version: "0.11.261201-beta.2" });
    if (stage === "downloaded") autoUpdater.emit("update-downloaded", { version: "0.11.261201-beta.2" });
    assert.equal(autoUpdater.autoInstallOnAppQuit, true);
    updater.follow("stable");
    assert.equal(autoUpdater.autoInstallOnAppQuit, false, stage);
    assert.deepEqual(updater.status(), { state: "checking", channel: "stable" });
    assert.equal(autoUpdater.checks, 2, "the new line is checked at once");
    // A stable release found afterwards is installed on quit again.
    autoUpdater.emit("update-downloaded", { version: "0.11.261202" });
    assert.equal(autoUpdater.autoInstallOnAppQuit, true);
    assert.equal(updater.status().version, "0.11.261202");
  }
  // A stable release already queued is not touched when the choice widens to prereleases.
  const widen = make();
  widen.autoUpdater.emit("update-downloaded", { version: "0.10.261106" });
  widen.updater.follow("prerelease");
  assert.deepEqual(widen.updater.status(), { state: "downloaded", version: "0.10.261106", channel: "prerelease" });
  assert.equal(widen.autoUpdater.autoInstallOnAppQuit, true);
});

test("a check that was running when stable was chosen cannot deliver its prerelease (#1609-2)", async () => {
  const { autoUpdater, updater } = make({ version: "0.11.261201-beta.1" });
  updater.start();
  updater.follow("stable");
  autoUpdater.emit("update-available", { version: "0.11.261201-beta.2" });
  autoUpdater.emit("update-downloaded", { version: "0.11.261201-beta.2" });
  assert.equal(updater.status().state, "checking");
  assert.equal(autoUpdater.autoInstallOnAppQuit, false);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(autoUpdater.checks >= 2, "the stable line is asked again");
});

test("Check now runs without a restart, a channel change or six hours, and shows checking and progress (#1609-10)", () => {
  const { autoUpdater, updater } = make();
  updater.start();
  autoUpdater.emit("error", new Error("offline"));
  assert.equal(updater.status().state, "error");
  updater.checkNow();
  assert.equal(updater.status().state, "checking");
  assert.equal(autoUpdater.checks, 2, "an error is retried on request");
  autoUpdater.emit("update-not-available", { version: "0.10.261105" });
  // The native event that starts a check moves a displayed "current" back to checking.
  autoUpdater.emit("checking-for-update");
  assert.equal(updater.status().state, "checking");
  // A download in progress reports its percentage and is not interrupted by a check request.
  autoUpdater.emit("update-available", { version: "0.10.261106" });
  autoUpdater.emit("download-progress", { percent: 41.6 });
  assert.deepEqual(updater.status(), { state: "downloading", version: "0.10.261106", percent: 42, channel: "stable" });
  autoUpdater.emit("checking-for-update");
  updater.checkNow();
  assert.equal(updater.status().state, "downloading");
  assert.equal(autoUpdater.checks, 2);
  // A failed download is retried on request and keeps the version it was fetching until the check answers.
  autoUpdater.emit("error", new Error("disk full"));
  assert.equal(updater.status().during, "download");
  updater.checkNow();
  assert.equal(autoUpdater.checks, 3);
  const off = make({ unsupportedReason: "off" });
  off.updater.checkNow();
  assert.equal(off.autoUpdater.checks, 0);
});
