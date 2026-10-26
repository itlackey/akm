// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { XDG_BASE_DIR_ENV_PASSTHROUGH } from "../../../core/spawn-env";

/**
 * The names an `opencode` process reads beyond the common baseline: its API key
 * (OpenCode Go and Zen read `OPENCODE_API_KEY`), the config file, directory and
 * inline content it is pointed at, and the XDG base directories. The inline
 * content can hold a provider's `apiKey`, so it is left out of the names whose
 * values may be shown (`../../../core/redaction.ts`). A run and the `--version`
 * probe (`./version.ts`) build their environment from the same names.
 */
export const OPENCODE_ENV_PASSTHROUGH = [
  "OPENCODE_API_KEY",
  "OPENCODE_CONFIG",
  "OPENCODE_CONFIG_DIR",
  "OPENCODE_CONFIG_CONTENT",
  ...XDG_BASE_DIR_ENV_PASSTHROUGH,
] as const;
