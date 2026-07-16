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
  readonly aliases = [] as const;
  readonly agentBuilder = piBuilder;
  readonly resultExtractor = piResultExtractor;
  // ── Workflow-engine descriptor (plan §"Capability matrix", P2) ────────────
  // akm spawns the `pi` CLI locally per unit ⇒ local-runner.
  readonly pattern = "local-runner" as const;
  // `--mode json` emits a documented JSONL event stream akm parses, then
  // validates against the node schema ⇒ native-json tier.
  readonly structuredOutput = "native-json" as const;
  // Session-id env marker only — the matrix's bare PI_* presence vars must
  // not stamp identity onto manual runs (see `AkmHarness.identityEnv`).
  readonly identityEnv = ["PI_SESSION_ID"] as const;
  readonly capabilities = caps({
    agentDispatch: true,
    detection: true,
  });
}
