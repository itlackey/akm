// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** Default agent CLI timeout; null means agents run until they finish. */
export const DEFAULT_AGENT_TIMEOUT_MS: number | null = null;

/** Default hard timeout for direct LLM calls when no engine/use override exists. */
export const DEFAULT_LLM_TIMEOUT_MS = 600_000;

/** Default bound on model work (structured calls, judgments) on every runner kind. */
export const DEFAULT_MODEL_WORK_TIMEOUT_MS = 600_000;
