// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Platform detection leaf. Imports NOTHING so both `common.ts` and `paths.ts`
 * can depend on it without a `common.ts ↔ paths.ts` import cycle (paths needs
 * only this constant from common).
 */

export const IS_WINDOWS = process.platform === "win32";
