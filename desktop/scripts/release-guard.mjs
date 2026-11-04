// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** Why a build must not be distributed, or null. Desktop X embeds released akm X: one version, one release. */
/** @param {{ version: string, dirty: boolean, tags: string[] }} build */
export function releaseRefusal({ version, dirty, tags }) {
  if (dirty) return "The working tree has uncommitted changes. Commit them and build from the release tag.";
  if (!tags.includes(`v${version}`))
    return `HEAD is not tagged v${version}. Build distributable AppImages from the release tag.`;
  return null;
}
