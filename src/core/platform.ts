// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Platform detection leaf (chunk-8 WI-8.6, DoD 11). Imports NOTHING so both
 * `common.ts` and `paths.ts` can depend on it — extracting IS_WINDOWS here
 * broke the `common.ts ↔ paths.ts` import cycle (paths needed only this
 * constant from common).
 */

export const IS_WINDOWS = process.platform === "win32";
