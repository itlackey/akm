// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Aider CLI harness (P2 integration, plan §"The adapter contract").
 *
 * Per-harness barrel gathering the Aider integration surfaces:
 *   - agent command builder → ./agent-builder.ts    (aiderBuilder)
 *   - result extractor      → ./result-extractor.ts (aiderResultExtractor)
 *
 * It also defines {@link AiderHarness}, the {@link AkmHarness} descriptor that
 * `HARNESS_REGISTRY` registers. Dispatch-only: no native session-log reader or
 * config importer yet.
 */

import { caps } from "../shared";
import { BaseHarness } from "../types";
import { aiderBuilder } from "./agent-builder";
import { aiderResultExtractor } from "./result-extractor";

export { AIDER_PLATFORM, aiderBuilder } from "./agent-builder";
export { aiderResultExtractor } from "./result-extractor";

/**
 * Aider.
 *
 * Canonical id is `'aider'`; no alias or distinct runtime identity.
 */
export class AiderHarness extends BaseHarness {
  readonly id = "aider" as const;
  readonly displayName = "Aider";
  readonly aliases = [] as const;
  readonly agentBuilder = aiderBuilder;
  readonly resultExtractor = aiderResultExtractor;
  // ── Workflow-engine descriptor (plan §"Capability matrix", P2) ────────────
  // akm spawns the `aider` CLI locally per unit ⇒ local-runner.
  readonly pattern = "local-runner" as const;
  // No structured-output mode at all (the matrix's "none — parse output"):
  // akm injects the schema into the prompt and extracts embedded JSON.
  readonly structuredOutput = "none" as const;
  // No flag-shaped resume: Aider persists context in chat-history files
  // (`.aider.chat.history.md`), not session ids — the plan's named example of
  // a harness with no session model. akm's `workflow_run_units` remains the
  // durable resume source of truth.
  // No `identityEnv`: the matrix lists Aider's identity markers as uncertain,
  // and Aider stamps no session var onto child processes.
  readonly capabilities = caps({
    agentDispatch: true,
    detection: true,
  });
}
