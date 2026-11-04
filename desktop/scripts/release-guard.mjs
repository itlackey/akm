// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Why a build must not be distributed, or null. Desktop X embeds released akm X: one version, one release. So a
 * distributable build comes from a clean tree whose engine is the released tarball (`core.mjs --tarball`), never the
 * checkout's own build.
 * @param {{ dirty: boolean, core: { version?: string, source?: string } | null }} build
 */
export function releaseRefusal({ dirty, core }) {
  if (dirty) return "The working tree has uncommitted changes. Commit them and build from the release commit.";
  if (core?.source !== "release")
    return "The engine was built from this checkout, not a release. Unpack the released akm-cli tarball first: node scripts/core.mjs --tarball <file>.";
  return null;
}
