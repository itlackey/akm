// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * @typedef {{ state: "unsupported" | "checking" | "current" | "downloading" | "downloaded" | "available" | "error", version?: string, error?: string }} UpdateStatus
 */

const SIX_HOURS = 6 * 60 * 60 * 1000;

/**
 * Updates come from this repository's GitHub releases (electron-updater's `github` provider; the repository is
 * written into the app by package.mjs). A stable build follows stable releases only; a build of a stage release (alpha,
 * beta, rc) follows prereleases and stable releases, so Desktop's channel is the akm release stage it embeds.
 *
 * macOS cannot apply an unsigned update, so there the app only reports that one exists. Signing and notarization would
 * make `canInstall` true on macOS; nothing else changes.
 * @param {{
 *   autoUpdater: import("electron-updater").AppUpdater,
 *   version: string,
 *   platform: string,
 *   supported: boolean,
 * }} options `supported` is false for development runs and for a Linux build that is not an AppImage.
 */
export function createUpdater({ autoUpdater, version, platform, supported }) {
  /** @type {UpdateStatus} */
  let status = { state: supported ? "checking" : "unsupported" };
  const canInstall = platform !== "darwin";
  const prerelease = /^\d+\.\d+\.\d+-/.test(version);
  autoUpdater.allowPrerelease = prerelease;
  if (prerelease) {
    // akm's stages are one line of releases, each with its own number. electron-updater's GitHub provider follows a
    // stage by name: beta skips alpha, and rc follows only rc, so an rc build never reaches the next stable release.
    // As "alpha" it takes the newest alpha, beta or stable release; rc releases are not offered. Setting a channel
    // also allows downgrades, which this must not.
    autoUpdater.channel = "alpha";
    autoUpdater.allowDowngrade = false;
  }
  autoUpdater.autoDownload = canInstall;
  autoUpdater.autoInstallOnAppQuit = canInstall;
  autoUpdater.on("update-available", (info) => {
    status = { state: canInstall ? "downloading" : "available", version: info.version };
  });
  autoUpdater.on("update-downloaded", (info) => {
    status = { state: "downloaded", version: info.version };
  });
  autoUpdater.on("update-not-available", () => {
    status = { state: "current" };
  });
  autoUpdater.on("error", (error) => {
    status = { state: "error", error: error.message };
  });
  const check = () => {
    if (status.state === "downloading" || status.state === "downloaded" || status.state === "available") return;
    autoUpdater.checkForUpdates().catch(() => {});
  };
  return {
    status: () => status,
    /** Check now and every six hours while the app runs. */
    start() {
      if (!supported) return;
      check();
      setInterval(check, SIX_HOURS).unref();
    },
  };
}
