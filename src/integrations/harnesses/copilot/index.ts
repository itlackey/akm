// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * GitHub Copilot CLI harness (P2 integration, plan §"The adapter contract").
 *
 * Per-harness barrel gathering the Copilot CLI integration surfaces:
 *   - agent command builder → ./agent-builder.ts    (copilotBuilder)
 *   - result extractor      → ./result-extractor.ts (copilotResultExtractor)
 *
 * It also defines {@link CopilotHarness}, the {@link AkmHarness} descriptor
 * that `HARNESS_REGISTRY` registers. This is the LOCAL Copilot CLI
 * (`copilot -p …`); the cloud "Copilot coding agent" is the plan's
 * cloud-delegate pattern and is a separate, future descriptor.
 */

import { BaseHarness, type HarnessCapabilities } from "../types";
import { copilotBuilder } from "./agent-builder";
import { copilotResultExtractor } from "./result-extractor";

export { COPILOT_PLATFORM, copilotBuilder } from "./agent-builder";
export { copilotResultExtractor } from "./result-extractor";

function caps(c: Partial<HarnessCapabilities>): HarnessCapabilities {
  return {
    sessionLogs: false,
    agentDispatch: false,
    detection: false,
    configImport: false,
    runtimeIdentity: false,
    ...c,
  };
}

/**
 * GitHub Copilot CLI (local headless CLI, not the cloud coding agent).
 *
 * Canonical id is `'copilot'`; no alias or distinct runtime identity.
 */
export class CopilotHarness extends BaseHarness {
  readonly id = "copilot" as const;
  readonly displayName = "GitHub Copilot CLI";
  readonly aliases = [] as const;
  readonly agentBuilder = copilotBuilder;
  readonly resultExtractor = copilotResultExtractor;
  // ── Workflow-engine descriptor (plan §"Capability matrix", P2) ────────────
  // akm spawns the `copilot` CLI locally per unit ⇒ local-runner.
  readonly pattern = "local-runner" as const;
  // `--output-format json` emits a documented JSON envelope akm parses, then
  // validates against the node schema ⇒ native-json tier.
  readonly structuredOutput = "native-json" as const;
  // Session-id env marker only. The matrix's other candidates (GH_TOKEN,
  // bare COPILOT_* presence vars) are credential/presence flags that would
  // stamp identity onto manual runs, so they are deliberately NOT registered
  // (see `AkmHarness.identityEnv`).
  readonly identityEnv = ["COPILOT_SESSION_ID"] as const;
  readonly capabilities = caps({
    agentDispatch: true,
    detection: true,
  });
}
