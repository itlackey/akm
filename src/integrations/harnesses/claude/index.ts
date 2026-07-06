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
 * ## id normalization bridge ('claude' vs 'claude-code')
 *
 * The canonical, persisted id is `'claude'` (used by the agent runner, agent
 * profiles, the Zod config schema and `--type` resolution after normalization).
 * `'claude-code'` is the historical RUNTIME identity — the string stamped on
 * session-log events/refs, the extracted-session dedup key, and the value
 * `resolveAgentIdentity` reports. It is registered as an `alias` and exposed as
 * `runtimeId` so BOTH directions round-trip via `normalizeHarnessId()` /
 * `denormalizeRuntimeIdentity()`. Existing persisted configs and session logs
 * that say `'claude-code'` keep working unchanged.
 */

import type { SessionLogHarness } from "../../session-logs/types";
import { BaseHarness, type HarnessCapabilities } from "../types";
import { claudeBuilder } from "./agent-builder";
import { ClaudeCodeProvider } from "./session-log";

export { claudeBuilder } from "./agent-builder";
export { claudeCodeImporter } from "./config-import";
export { ClaudeCodeProvider } from "./session-log";

function caps(c: Partial<HarnessCapabilities>): HarnessCapabilities {
  return {
    sessionLogs: false,
    agentDispatch: false,
    detection: false,
    configImport: false,
    runtimeIdentity: false,
    v1Migration: false,
    ...c,
  };
}

/**
 * Claude Code.
 *
 * Canonical id is `'claude'`; `'claude-code'` is the runtime/session-log
 * identity and is registered as an alias so both directions round-trip.
 */
export class ClaudeHarness extends BaseHarness {
  readonly id = "claude" as const;
  readonly displayName = "Claude Code";
  readonly aliases = ["claude-code"] as const;
  readonly runtimeId = "claude-code";
  // Home-relative config dir scanned by `akm setup` (#567). Claude Code has a
  // session-log provider, so offering it as a stash source is functional.
  readonly setupDetectionDir = ".claude";
  readonly agentBuilder = claudeBuilder;
  // ── Workflow-engine descriptor (plan §"Capability matrix", P2) ────────────
  // Claude Code is the in-harness pattern: the orchestrating session itself
  // drives units via the `akm workflow` gate spine (`claude -p` headless
  // dispatch also exists via `agentBuilder`, but the pattern classification
  // follows the matrix row).
  readonly pattern = "in-harness" as const;
  // Structured output via tool-call input schemas (forced StructuredOutput) —
  // the matrix's "via tool schema" ⇒ native-schema tier.
  readonly structuredOutput = "native-schema" as const;
  // `claude --resume <sessionId>` replays a previous session in headless mode.
  readonly resume = { flag: "--resume", takesSessionId: true } as const;
  // Session-id env marker: presence of a concrete session id (not the bare
  // "running under Claude Code" flag) attributes a run to this harness.
  readonly identityEnv = ["CLAUDE_SESSION_ID"] as const;
  readonly sessionLogProvider = (): SessionLogHarness => new ClaudeCodeProvider();
  readonly capabilities = caps({
    sessionLogs: true,
    agentDispatch: true,
    detection: true,
    configImport: true,
    runtimeIdentity: true,
    v1Migration: true,
  });
}
