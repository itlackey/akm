// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * OpenHands CLI harness (P2 integration, plan §"The adapter contract").
 *
 * Per-harness barrel gathering the OpenHands integration surfaces:
 *   - agent command builder → ./agent-builder.ts    (openhandsBuilder)
 *   - result extractor      → ./result-extractor.ts (openhandsResultExtractor)
 *
 * It also defines {@link OpenhandsHarness}, the {@link AkmHarness} descriptor
 * that `HARNESS_REGISTRY` registers. Dispatch-only: no native session-log
 * reader or config importer yet.
 */

import { BaseHarness, type HarnessCapabilities } from "../types";
import { openhandsBuilder } from "./agent-builder";
import { openhandsResultExtractor } from "./result-extractor";

export { OPENHANDS_MODEL_ENV, OPENHANDS_PLATFORM, openhandsBuilder } from "./agent-builder";
export { openhandsResultExtractor } from "./result-extractor";

function caps(c: Partial<HarnessCapabilities>): HarnessCapabilities {
  return {
    sessionLogs: false,
    agentDispatch: false,
    detection: false,
    configImport: false,
    runtimeIdentity: false,
    v1Migration: false,
    ...c,
  };
}

/**
 * OpenHands CLI.
 *
 * Canonical id is `'openhands'`; no alias or distinct runtime identity.
 */
export class OpenhandsHarness extends BaseHarness {
  readonly id = "openhands" as const;
  readonly displayName = "OpenHands";
  readonly aliases = [] as const;
  readonly agentBuilder = openhandsBuilder;
  readonly resultExtractor = openhandsResultExtractor;
  // ── Workflow-engine descriptor (plan §"Capability matrix", P2) ────────────
  // akm spawns `openhands --headless` locally per unit ⇒ local-runner.
  readonly pattern = "local-runner" as const;
  // `--json` emits a documented JSONL event stream akm parses, then validates
  // against the node schema ⇒ native-json tier.
  readonly structuredOutput = "native-json" as const;
  // No `resume`: per the matrix OpenHands resumes from workspace state, not a
  // session-id flag. The extractor still captures a conversation id
  // opportunistically; akm's `workflow_run_units` remains the durable source
  // of truth.
  // No `identityEnv`: the matrix lists OpenHands' identity markers as
  // uncertain, and it stamps no session var onto child processes.
  readonly capabilities = caps({
    agentDispatch: true,
    detection: true,
  });
}
