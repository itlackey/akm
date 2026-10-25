// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Claude Code harness (#563).
 *
 * The per-harness barrel for Claude Code:
 *   - session-log reader     → ./session-log.ts   (ClaudeCodeProvider)
 *   - agent command builder  → ./agent-builder.ts (claudeBuilder)
 *
 * It also defines {@link ClaudeHarness}, the {@link AkmHarness} descriptor that
 * `HARNESS_REGISTRY` registers.
 *
 * The single identifier for config, dispatch, workflow attribution, and
 * session logs is `claude`.
 */

import type { SessionLogHarness } from "../../session-logs/types";
import type { AkmHarness } from "../harness";
import { claudeBuilder } from "./agent-builder";
import { claudeResultExtractor } from "./result-extractor";
import { ClaudeCodeProvider } from "./session-log";

export { claudeBuilder } from "./agent-builder";
export { claudeResultExtractor } from "./result-extractor";
export { ClaudeCodeProvider } from "./session-log";

/**
 * Claude Code.
 *
 * `claude` is the sole runtime and persisted id.
 */
export class ClaudeHarness implements AkmHarness {
  readonly id = "claude" as const;
  readonly displayName = "Claude Code";
  // Home-relative config dir scanned by `akm setup` (#567). Claude Code has a
  // session-log provider, so offering it as a stash source is functional.
  readonly setupDetectionDir = ".claude";
  readonly build = claudeBuilder.build;
  readonly profile = { bin: "claude", args: [], envPassthrough: ["ANTHROPIC_API_KEY", "CLAUDE_CONFIG"] };
  readonly resultExtractor = claudeResultExtractor;
  readonly models = {
    fast: "claude-haiku-4-5-20251001",
    balanced: "claude-sonnet-4-6",
    reasoning: "claude-opus-4-7",
  };
  // ── Workflow-engine descriptor (plan §"Capability matrix", P2) ────────────
  // Session-id env marker: presence of a concrete session id (not the bare
  // "running under Claude Code" flag) attributes a run to this harness.
  readonly identityEnv = ["CLAUDE_SESSION_ID"] as const;
  readonly sessionLogProvider = (): SessionLogHarness => new ClaudeCodeProvider();
  readonly systemPrompt = true;
  readonly nativeAgent = true;
  readonly confinable = true;
}
