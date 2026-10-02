// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * OpenCode SDK harness DESCRIPTOR (#564).
 *
 * This module is a dependency-graph LEAF: it imports only the harness base
 * types (`../types`) and nothing from `core/config` or the SDK runner. Keeping
 * the descriptor separate from the runtime runner (`./sdk-runner`, which pulls
 * `core/config`) is load-bearing: `HARNESS_REGISTRY` in `../index.ts` imports
 * this class from HERE, not from the per-harness barrel (`./index.ts`). The
 * barrel additionally re-exports `runOpencodeSdk`/`closeServer` from
 * `./sdk-runner`; that re-export makes the barrel transitively depend on
 * `core/config`, and `core/config/config-types` derives `VALID_HARNESS_IDS`
 * back from `../index.ts`. If the registry imported the class through the
 * barrel, that cycle would evaluate `../index.ts` (and `new
 * OpencodeSdkHarness()`) while the barrel — and hence this class binding — was
 * still initializing, throwing a temporal-dead-zone "Cannot access
 * 'OpencodeSdkHarness' before initialization" whenever the barrel is the first
 * module loaded in a fresh graph (e.g. the workflow-exec subprocess entry).
 * Importing the descriptor from this leaf keeps the registry a config-leaf and
 * breaks the cycle.
 */

import { isModelWorkTools } from "../../../execution/source";
import { createAgentRequestLowerer } from "../../agent/request-lowering";
import { opencodeCarriedKeys } from "../opencode/model-config";
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
      nativeAgentSelector: true,
      tools: "sdk",
      modelWorkTools: true,
      // The server config gives the routed model its inference entry, so the request must name a model, except
      // that model work's agent carries its options whichever model opencode picks.
      inference: (_profile, request) =>
        opencodeCarriedKeys(Boolean(request.model?.resolved), request.inference, isModelWorkTools(request.tools)),
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
  });
}
