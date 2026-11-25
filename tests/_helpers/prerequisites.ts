// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Tests that need something of the machine (#1772). Ask for the prerequisite by name:
 *
 *     const gap = prerequisiteGap("non-root");
 *     test.skipIf(gap !== undefined)("…", …);
 *
 * Locally an unmet prerequisite skips, with the reason printed. Under `CI` (GitHub runners always set it) it throws,
 * so a runner that stops meeting one fails loudly instead of quietly dropping coverage.
 */

import { enforcesPermissionBits } from "./unreadable-path";

const PREREQUISITES = {
  "non-root": { met: () => enforcesPermissionBits, reason: "running as root: permission bits do not stop root" },
};

export type Prerequisite = keyof typeof PREREQUISITES;

export function prerequisiteGap(
  name: Prerequisite,
  { met = PREREQUISITES[name].met(), ci = Boolean(process.env.CI) }: { met?: boolean; ci?: boolean } = {},
): string | undefined {
  if (met) return undefined;
  const { reason } = PREREQUISITES[name];
  if (ci) throw new Error(`CI must meet the "${name}" prerequisite: ${reason}`);
  console.warn(`skipped, needs ${name}: ${reason}`);
  return reason;
}
