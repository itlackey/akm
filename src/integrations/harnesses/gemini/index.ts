// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Gemini CLI harness (P2 integration, plan §"The adapter contract").
 *
 * Per-harness barrel gathering the Gemini CLI integration surfaces:
 *   - agent command builder → ./agent-builder.ts    (geminiBuilder)
 *   - result extractor      → ./result-extractor.ts (geminiResultExtractor)
 *
 * It also defines {@link GeminiHarness}, the {@link AkmHarness} descriptor
 * that `HARNESS_REGISTRY` registers. Dispatch-only: no native session-log
 * reader or config importer yet.
 */

import { caps } from "../shared";
import { BaseHarness } from "../types";
import { geminiBuilder } from "./agent-builder";
import { geminiResultExtractor } from "./result-extractor";

export { GEMINI_PLATFORM, geminiBuilder } from "./agent-builder";
export { geminiResultExtractor } from "./result-extractor";

/**
 * Gemini CLI.
 *
 * Canonical id is `'gemini'`; no alias or distinct runtime identity.
 */
export class GeminiHarness extends BaseHarness {
  readonly id = "gemini" as const;
  readonly displayName = "Gemini CLI";
  readonly aliases = [] as const;
  readonly agentBuilder = geminiBuilder;
  readonly resultExtractor = geminiResultExtractor;
  // ── Workflow-engine descriptor (plan §"Capability matrix", P2) ────────────
  // akm spawns the `gemini` CLI locally per unit ⇒ local-runner.
  readonly pattern = "local-runner" as const;
  // `--output-format json` emits a documented JSON envelope akm parses, then
  // validates against the node schema ⇒ native-json tier.
  readonly structuredOutput = "native-json" as const;
  // The matrix's identity marker: Gemini CLI stamps GEMINI_CLI=1 only on
  // processes it spawns, so it genuinely means "running under gemini" (it is
  // not a user-profile config var) — but its VALUE ("1") is a bare flag, not
  // a session id, so it is registered as `presenceEnv` (harness inference
  // only), never `identityEnv` (whose values persist as agent_session_id).
  readonly presenceEnv = ["GEMINI_CLI"] as const;
  readonly capabilities = caps({
    agentDispatch: true,
    detection: true,
  });
}
