// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { toPosix } from "../common";

/** Bundle-root directory reserved for temporary working material; never indexed. */
export const SCRATCH_DIR = ".scratch";

/**
 * True when `relPath` (relative to the effective bundle/component root) is the
 * root `.scratch/` directory or anything beneath it. Root-scoped: a nested
 * `.scratch` is ordinary content. Paths that escape the root are not scratch.
 */
export function isScratchPath(relPath: string): boolean {
  return toPosix(relPath).split("/")[0] === SCRATCH_DIR;
}
