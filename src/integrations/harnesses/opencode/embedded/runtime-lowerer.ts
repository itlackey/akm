// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * How a resolved request becomes a run on akm's internal runtime. The persona
 * goes to the session's instructions (a native channel), and every portable
 * setting (`temperature`, `maxTokens`, `reasoningEffort`, `enableThinking`,
 * `extraParams`) is carried: the runner translates them to the endpoint's request
 * fields with the one translation the chat transport uses (`./plugin.ts` lays
 * them over the session's requests).
 */

import { PORTABLE_INFERENCE_KEYS } from "../../../../core/llm-inference";
import { createAgentRequestLowerer } from "../../../agent/request-lowering";

export const runtimeLowerer = createAgentRequestLowerer({
  adapter: "akm-runtime",
  personaChannel: "native",
  inference: PORTABLE_INFERENCE_KEYS,
  capabilities: { nativeAgent: true, modelWork: true },
});
