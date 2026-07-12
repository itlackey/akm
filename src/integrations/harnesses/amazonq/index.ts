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

import { BaseHarness, type HarnessCapabilities } from "../types";
import { AMAZONQ_RESUME_FLAG, amazonqBuilder } from "./agent-builder";
import { amazonqResultExtractor } from "./result-extractor";

export { AMAZONQ_PLATFORM, AMAZONQ_RESUME_FLAG, amazonqBuilder } from "./agent-builder";
export { amazonqResultExtractor, stripTerminalFraming } from "./result-extractor";

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
 * Amazon Q Developer CLI (`q`).
 *
 * Canonical id is `'amazonq'`; no alias or distinct runtime identity.
 */
export class AmazonqHarness extends BaseHarness {
  readonly id = "amazonq" as const;
  readonly displayName = "Amazon Q Developer CLI";
  readonly aliases = [] as const;
  readonly agentBuilder = amazonqBuilder;
  readonly resultExtractor = amazonqResultExtractor;
  // ── Workflow-engine descriptor (plan §"Capability matrix", P2) ────────────
  // akm spawns `q chat` locally per unit ⇒ local-runner.
  readonly pattern = "local-runner" as const;
  // No documented structured output: akm injects the schema into the prompt
  // and extracts embedded JSON from plain-text stdout.
  readonly structuredOutput = "none" as const;
  // Q's `--resume` is a BARE flag (takesSessionId: false): it replays the
  // previous conversation of the working directory and takes no session id
  // (see AMAZONQ_RESUME_FLAG in ./agent-builder.ts).
  readonly resume = { flag: AMAZONQ_RESUME_FLAG, takesSessionId: false } as const;
  // No `identityEnv`: the matrix lists Q's identity markers as uncertain, and
  // Q stamps no session var onto child processes.
  readonly capabilities = caps({
    agentDispatch: true,
    detection: true,
  });
}
