// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Amazon Q Developer CLI harness (P2 integration, plan §"The adapter
 * contract").
 *
 * Per-harness barrel gathering the Amazon Q integration surfaces:
 *   - agent command builder → ./agent-builder.ts    (amazonqBuilder)
 *   - result extractor      → ./result-extractor.ts (amazonqResultExtractor)
 *
 * It also defines {@link AmazonqHarness}, the {@link AkmHarness} descriptor
 * that `HARNESS_REGISTRY` registers. Dispatch-only: no native session-log
 * reader or config importer yet.
 */

import type { AkmHarness } from "../harness";
import { amazonqBuilder } from "./agent-builder";
import { amazonqResultExtractor } from "./result-extractor";

export { AMAZONQ_PLATFORM, amazonqBuilder } from "./agent-builder";
export { amazonqResultExtractor, stripTerminalFraming } from "./result-extractor";

/**
 * Amazon Q Developer CLI (`q`).
 *
 * Canonical id is `'amazonq'`; no alias or distinct runtime identity.
 */
export class AmazonqHarness implements AkmHarness {
  readonly id = "amazonq" as const;
  readonly displayName = "Amazon Q Developer CLI";
  readonly build = amazonqBuilder.build;
  readonly profile = { bin: "q", args: [], envPassthrough: ["AWS_PROFILE", "AWS_REGION"] };
  readonly resultExtractor = amazonqResultExtractor;
  // ── Workflow-engine descriptor (plan §"Capability matrix", P2) ────────────
  // No `identityEnv`: the matrix lists Q's identity markers as uncertain, and
  // Q stamps no session var onto child processes.
  readonly systemPrompt = false;
  readonly nativeAgent = false;
  readonly confinable = false;
}
