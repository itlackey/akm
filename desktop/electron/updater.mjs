// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * @typedef {"stable" | "prerelease"} UpdateChannel The release line followed: stable releases only, or stable and
 * prereleases (alpha, beta).
 * @typedef {{
 *   state: "unsupported" | "checking" | "current" | "downloading" | "downloaded" | "available" | "error",
 *   version?: string,
 *   error?: string,
 *   during?: "check" | "download",
 *   reason?: "development" | "off" | "not-appimage",
 *   channel: UpdateChannel,
 * }} UpdateStatus
 */

const SIX_HOURS = 6 * 60 * 60 * 1000;

/**
 * Updates come from this repository's GitHub releases (electron-updater's `github` provider; the repository is
 * written into the app by package.mjs). The release line followed is the person's saved choice, else the stage of the
 * embedded akm version: a stable build follows stable releases only, a build of a stage release (alpha, beta, rc)
 * follows prereleases and stable releases.
 *
 * macOS cannot apply an unsigned update, and akm does not sign its macOS packages, so there the app only reports that
 * one exists.
 * @param {{
 *   autoUpdater: import("electron-updater").AppUpdater,
 *   version: string,
 *   platform: string,
 *   unsupportedReason?: "development" | "off" | "not-appimage",
 * }} options `unsupportedReason` names why this run never checks: a development run, `AKM_DESKTOP_UPDATES=off`, or
 * a Linux build that is not an AppImage; absent, updates are checked.
 */
export function createUpdater({ autoUpdater, version, platform, unsupportedReason }) {
  const supported = unsupportedReason === undefined;
  /** @type {Omit<UpdateStatus, "channel">} */
  let status = supported ? { state: "checking" } : { state: "unsupported", reason: unsupportedReason };
  const canInstall = platform !== "darwin";
  const embeddedPrerelease = /^\d+\.\d+\.\d+-/.test(version);
  /** @type {UpdateChannel} */
  let channel = embeddedPrerelease ? "prerelease" : "stable";
  const configure = () => {
    const prerelease = channel === "prerelease";
    autoUpdater.allowPrerelease = prerelease;
    // akm's stages are one line of releases, each with its own number. electron-updater's GitHub provider follows a
    // stage by name: beta skips alpha, and rc follows only rc, so an rc build never reaches the next stable release.
    // As "alpha" it takes the newest alpha, beta or stable release; rc releases are not offered. "latest" is the
    // default channel file (latest*.yml), so the same setter puts a build back on stable releases only. Setting a
    // channel also allows downgrades, which this must not: a prerelease build that chooses stable stays until the next
    // stable release.
    autoUpdater.channel = prerelease ? "alpha" : "latest";
    autoUpdater.allowDowngrade = false;
  };
  configure();
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
    // A failed download is not a failed check; the version it was fetching is kept for the message.
    status = {
      state: "error",
      error: error.message,
      during: status.state === "downloading" ? "download" : "check",
      ...(status.version ? { version: status.version } : {}),
    };
  });
  const check = () => {
    if (status.state === "downloading" || status.state === "downloaded") return;
    autoUpdater.checkForUpdates().catch(() => {});
  };
  return {
    /** @returns {UpdateStatus} */
    status: () => ({ ...status, channel }),
    /** Check now and every six hours while the app runs. */
    start() {
      if (!supported) return;
      check();
      setInterval(check, SIX_HOURS).unref();
    },
    /**
     * Follow a release line: the saved preference, or `null` for the embedded version's own stage. A change checks
     * again at once.
     * @param {UpdateChannel | null} preference
     */
    follow(preference) {
      const next = preference ?? (embeddedPrerelease ? "prerelease" : "stable");
      if (next === channel) return;
      channel = next;
      configure();
      if (!supported || status.state === "downloading" || status.state === "downloaded") return;
      status = { state: "checking" };
      check();
    },
  };
}
