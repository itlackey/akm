// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Claude Code harness (#563).
 *
 * This is the per-harness barrel that gathers the Claude Code integration
 * surfaces that were previously scattered across the codebase:
 *   - session-log reader     → ./session-log.ts   (ClaudeCodeProvider)
 *   - agent command builder  → ./agent-builder.ts (claudeBuilder)
 *   - config importer        → ./config-import.ts (claudeCodeImporter)
 *
 * It also defines {@link ClaudeHarness}, the {@link AkmHarness} descriptor that
 * `HARNESS_REGISTRY` registers.
 *
 * The single identifier for config, dispatch, workflow attribution, and
 * session logs is `claude`.
 */

import type { SessionLogHarness } from "../../session-logs/types";
import { caps } from "../shared";
import { BaseHarness } from "../types";
import { claudeBuilder } from "./agent-builder";
import { claudeCodeImporter } from "./config-import";
import { claudeResultExtractor } from "./result-extractor";
import { ClaudeCodeProvider } from "./session-log";

export { claudeBuilder } from "./agent-builder";
export { claudeCodeImporter } from "./config-import";
export { claudeResultExtractor } from "./result-extractor";
export { ClaudeCodeProvider } from "./session-log";

/**
 * Claude Code.
 *
 * `claude` is the sole runtime and persisted id.
 */
export class ClaudeHarness extends BaseHarness {
  readonly id = "claude" as const;
  readonly displayName = "Claude Code";
  // Home-relative config dir scanned by `akm setup` (#567). Claude Code has a
  // session-log provider, so offering it as a stash source is functional.
  readonly setupDetectionDir = ".claude";
  readonly agentBuilder = claudeBuilder;
  readonly profile = { bin: "claude", args: [], envPassthrough: ["ANTHROPIC_API_KEY", "CLAUDE_CONFIG"] };
  readonly resultExtractor = claudeResultExtractor;
  readonly configImporter = claudeCodeImporter;
  // ── Workflow-engine descriptor (plan §"Capability matrix", P2) ────────────
  // Session-id env marker: presence of a concrete session id (not the bare
  // "running under Claude Code" flag) attributes a run to this harness.
  readonly identityEnv = ["CLAUDE_SESSION_ID"] as const;
  readonly sessionLogProvider = (): SessionLogHarness => new ClaudeCodeProvider();
  readonly capabilities = caps({
    sessionLogs: true,
    agentDispatch: true,
    detection: true,
    modelWork: true,
    nativeAgent: true,
    configImport: true,
  });
}
