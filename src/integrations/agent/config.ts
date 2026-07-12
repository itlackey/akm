// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** Default hard timeout for an agent CLI when neither engine nor call overrides it. */
export const DEFAULT_AGENT_TIMEOUT_MS = 60_000;

/** Default hard timeout for direct LLM calls when no engine/use override exists. */
export const DEFAULT_LLM_TIMEOUT_MS = 600_000;
