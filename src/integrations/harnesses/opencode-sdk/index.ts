// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * OpenCode SDK harness descriptor (#564).
 *
 * Descriptor only. The runner (`./sdk-runner`) imports `core/config`, so the
 * registry must never load it; `agent/runner-dispatch.ts` imports it directly.
 */

import { createAgentRequestLowerer } from "../../agent/request-lowering";
import { MODEL_WORK_AGENT_INFERENCE } from "../opencode/model-config";
import { caps } from "../shared";
import { BaseHarness } from "../types";

/**
 * OpenCode SDK (embedded-SDK dispatch path).
 *
 * Dispatch-only: no native session logs, but detected at setup.
 */
export class OpencodeSdkHarness extends BaseHarness {
  readonly id = "opencode-sdk" as const;
  readonly displayName = "OpenCode SDK";
  // ── Workflow-engine descriptor (plan §"Capability matrix", P2) ────────────
  readonly executionLowerer = {
    platform: "opencode-sdk",
    personaChannel: "native" as const,
    lower: createAgentRequestLowerer({
      adapter: "opencode-sdk",
      personaChannel: "native",
      tools: "sdk",
      inference: MODEL_WORK_AGENT_INFERENCE,
    }),
  };
  // No flag-shaped resume: session reuse is programmatic — the SDK session id is
  // stored opportunistically on the unit row and passed back to
  // `session.prompt`, not replayed via a CLI flag.
  // No `identityEnv`: the SDK runs in-process; it does not mark a child
  // process environment with a session id of its own.
  readonly capabilities = caps({
    agentDispatch: true,
    detection: true,
    modelWork: true,
    nativeAgent: true,
  });
}
