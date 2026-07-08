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
 * Claude Code's 'claude' vs 'claude-code'), so no alias bridge is needed.
 */

import type { SessionLogHarness } from "../../session-logs/types";
import { BaseHarness, type HarnessCapabilities } from "../types";
import { opencodeBuilder } from "./agent-builder";
import { OpenCodeProvider } from "./session-log";

export { opencodeBuilder } from "./agent-builder";
export { openCodeImporter } from "./config-import";
export { OpenCodeProvider } from "./session-log";

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
 * OpenCode.
 *
 * Canonical id is `'opencode'`; it has no distinct runtime identity or alias.
 */
export class OpencodeHarness extends BaseHarness {
  readonly id = "opencode" as const;
  readonly displayName = "OpenCode";
  readonly aliases = [] as const;
  // Home-relative config dir scanned by `akm setup` (#567). OpenCode has a
  // session-log provider, so offering it as a stash source is functional.
  readonly setupDetectionDir = ".config/opencode";
  // Decorated v1 profile names like "opencode-fast" still belong to OpenCode.
  // `v1ProfilePlatform()` resolves most-specific-id-first, so "opencode-sdk-*"
  // is claimed by OpencodeSdkHarness before this prefix can over-match it.
  protected readonly v1ProfilePrefixes = ["opencode"] as const;
  readonly agentBuilder = opencodeBuilder;
  // ── Workflow-engine descriptor (plan §"Capability matrix", P2) ────────────
  // This entry is the CLI spawn path (`opencode run …`): akm launches the
  // harness locally per unit ⇒ local-runner. (The SDK path is the separate
  // `opencode-sdk` harness.)
  readonly pattern = "local-runner" as const;
  // The CLI path emits plain text — no JSON stream akm consumes — so the
  // engine uses the prompt-injected schema + embedded-JSON extraction tier
  // (the matrix's "via prompt+validate"). The SDK entry is native-json.
  readonly structuredOutput = "none" as const;
  // `opencode run --session <id>` continues a previous session.
  readonly resume = { flag: "--session", takesSessionId: true } as const;
  // Session-id env marker for run attribution.
  readonly identityEnv = ["OPENCODE_SESSION_ID"] as const;
  readonly sessionLogProvider = (): SessionLogHarness => new OpenCodeProvider();
  readonly capabilities = caps({
    sessionLogs: true,
    agentDispatch: true,
    detection: true,
    configImport: true,
    runtimeIdentity: true,
    v1Migration: true,
  });
}
