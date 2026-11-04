// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { sensitive, UsageError } from "akm-cli/workspace";
import { fields } from "../input.js";

/**
 * Desktop's policy for showing a protected value: only an explicit, authenticated request returns it, and the route
 * sends it uncached and unscrubbed. akm decides what the file is and what it contains; this decides who may ask.
 */
export function reveal(body: unknown) {
  const value = fields<{ ref?: unknown; bundle?: unknown; file?: unknown }>(body, ["ref", "bundle", "file"], "reveal");
  if (Object.values(value).some((entry) => typeof entry !== "string")) throw new UsageError("Choose a file to show.");
  return sensitive.readValue(value as { ref?: string; bundle?: string; file?: string });
}
