// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { createRequire } from "node:module";
import { GitHubProvider } from "electron-updater/out/providers/GitHubProvider.js";
import { parseUpdateInfo } from "electron-updater/out/providers/Provider.js";

// Versions are ordered by the semver electron-updater uses to decide whether a release is newer than this build.
const semver = createRequire(import.meta.resolve("electron-updater"))("semver");

/** The repository whose GitHub releases Desktop updates from; package.mjs writes it into the installers' metadata. */
export const releases = { owner: "itlackey", repo: "akm" };

/**
 * The tag with the highest version, or undefined. Tags that are not versions are skipped; a `v` prefix is allowed.
 * @param {string[]} tags
 * @returns {string | undefined}
 */
export function highestRelease(tags) {
  return tags.filter((tag) => semver.valid(tag)).sort(semver.rcompare)[0];
}

/**
 * electron-updater's GitHub provider, except for stable and prerelease releases. There it takes the first release of
 * an accepted stage in the feed, which lists releases by publish date, so with two release lines open a newer
 * publish of the older line hides a newer prerelease (and rc releases are never taken). This takes the highest
 * version in the feed, any stage, as npm's `next` tag does. Stable releases stay GitHub's latest release.
 */
export class HighestReleaseProvider extends GitHubProvider {
  /**
   * @param {import("builder-util-runtime").CustomPublishOptions} options What setFeedURL was given.
   * @param {ConstructorParameters<typeof GitHubProvider>[1]} updater
   * @param {ConstructorParameters<typeof GitHubProvider>[2]} runtimeOptions
   */
  constructor(options, updater, runtimeOptions) {
    super({ ...options, provider: "github" }, updater, runtimeOptions);
    // GitHubProvider keeps its updater private; the line is the updater's at each check.
    this.prereleases = () => updater.allowPrerelease;
  }

  async getLatestVersion() {
    if (!this.prereleases()) return super.getLatestVersion();
    const path = `/${this.options.owner}/${this.options.repo}/releases`;
    const feed = await this.httpRequest(new URL(`${path}.atom`, this.baseUrl), {
      accept: "application/xml, application/atom+xml, text/xml, */*",
    });
    const tag = highestRelease([...String(feed).matchAll(/href="[^"]*\/tag\/(v?[^"/]+)"/g)].map((match) => match[1]));
    if (!tag) throw new Error("No published versions on GitHub");
    // electron-builder names a release's update file after its stage: beta-linux.yml, or latest-linux.yml for a stable.
    const stage = semver.prerelease(tag)?.[0];
    const file = `${stage ? this.getCustomChannelName(String(stage)) : this.getDefaultChannelName()}.yml`;
    const url = new URL(`${path}/download/${tag}/${file}`, this.baseUrl);
    return { tag, ...parseUpdateInfo(await this.httpRequest(url), file, url) };
  }
}
