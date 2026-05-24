// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Embedded "agent CLI hints" rendered by `akm hints` when no other source
 * is available.
 *
 * Extracted from `src/cli.ts` so it does not bloat the CLI module and so
 * docs/CI tooling can re-use the same constants. Two flavors:
 * `EMBEDDED_HINTS` (default reference, ~40 lines) and
 * `EMBEDDED_HINTS_FULL` (`--detail full`, ~250 lines).
 */

import EMBEDDED_HINTS_FULL from "./cli-hints-full.md" with { type: "text" };
import EMBEDDED_HINTS from "./cli-hints-short.md" with { type: "text" };

export { EMBEDDED_HINTS, EMBEDDED_HINTS_FULL };
