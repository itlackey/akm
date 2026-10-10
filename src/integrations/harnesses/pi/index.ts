// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Pi coding-agent CLI harness (P2 integration, plan §"The adapter contract").
 *
 * Per-harness barrel gathering the Pi integration surfaces:
 *   - agent command builder → ./agent-builder.ts    (piBuilder)
 *   - result extractor      → ./result-extractor.ts (piResultExtractor)
 *
 * It also defines {@link PiHarness}, the {@link AkmHarness} descriptor that
 * `HARNESS_REGISTRY` registers. Dispatch-only: no native session-log reader or
 * config importer yet.
 */

import { caps } from "../shared";
import { BaseHarness } from "../types";
import { piBuilder } from "./agent-builder";
import { piResultExtractor } from "./result-extractor";

export { PI_PLATFORM, piBuilder } from "./agent-builder";
export { piResultExtractor } from "./result-extractor";

/**
 * Pi coding-agent CLI.
 *
 * Canonical id is `'pi'`; no alias or distinct runtime identity.
 */
export class PiHarness extends BaseHarness {
  readonly id = "pi" as const;
  readonly displayName = "Pi";
  readonly agentBuilder = piBuilder;
  readonly profile = { bin: "pi", args: [], envPassthrough: ["PI_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"] };
  readonly resultExtractor = piResultExtractor;
  // ── Workflow-engine descriptor (plan §"Capability matrix", P2) ────────────
  // Session-id env marker only — the matrix's bare PI_* presence vars must
  // not stamp identity onto manual runs (see `AkmHarness.identityEnv`).
  readonly identityEnv = ["PI_SESSION_ID"] as const;
  readonly capabilities = caps({
    agentDispatch: true,
    detection: true,
  });
}
