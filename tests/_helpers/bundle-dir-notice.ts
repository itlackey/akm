// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The test sandbox points a spawned CLI at its bundle with `AKM_BUNDLE_DIR`, and since 0.10.261122 akm prints one
 * deprecation line for that variable. Tests that read a spawned CLI's stderr drop that line with this.
 */
export function withoutBundleDirNotice(stderr: string): string {
  return stderr
    .split("\n")
    .filter((line) => !line.startsWith("[deprecated] AKM_BUNDLE_DIR is deprecated"))
    .join("\n");
}
