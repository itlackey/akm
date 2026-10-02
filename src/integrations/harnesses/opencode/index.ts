// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * OpenCode harness (#564).
 *
 * Per-harness barrel that gathers the OpenCode integration surfaces previously
 * scattered across the codebase:
 *   - session-log reader     → ./session-log.ts   (OpenCodeProvider)
 *   - agent command builder  → ./agent-builder.ts (opencodeBuilder)
 *   - config importer        → ./config-import.ts (openCodeImporter)
 *
 * It also defines {@link OpencodeHarness}, the {@link AkmHarness} descriptor
 * that `HARNESS_REGISTRY` registers.
 *
 * id normalization: OpenCode's canonical id (`'opencode'`) is also its runtime
 * identity and session-log provider name — there is no historical split (unlike
 * Claude Code's 'claude' vs 'claude'), so no alias bridge is needed.
 */

import type { SessionLogHarness } from "../../session-logs/types";
import { caps } from "../shared";
import { BaseHarness } from "../types";
import { opencodeBuilder } from "./agent-builder";
import { OpenCodeProvider } from "./session-log";

export { opencodeBuilder } from "./agent-builder";
export { openCodeImporter } from "./config-import";
export { OpenCodeProvider } from "./session-log";

/**
 * OpenCode.
 *
 * Canonical id is `'opencode'`; it has no distinct runtime identity or alias.
 */
export class OpencodeHarness extends BaseHarness {
  readonly id = "opencode" as const;
  readonly displayName = "OpenCode";
  // Home-relative config dir scanned by `akm setup` (#567). OpenCode has a
  // session-log provider, so offering it as a stash source is functional.
  readonly setupDetectionDir = ".config/opencode";
  readonly agentBuilder = opencodeBuilder;
  // ── Workflow-engine descriptor (plan §"Capability matrix", P2) ────────────
  // Session-id env marker for run attribution.
  readonly identityEnv = ["OPENCODE_SESSION_ID"] as const;
  readonly sessionLogProvider = (): SessionLogHarness => new OpenCodeProvider();
  readonly capabilities = caps({
    sessionLogs: true,
    agentDispatch: true,
    detection: true,
    configImport: true,
  });
}
