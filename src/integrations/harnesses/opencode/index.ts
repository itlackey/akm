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

import type { AkmHarness, HarnessCapabilities } from "../types";

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
export class OpencodeHarness implements AkmHarness {
  readonly id = "opencode" as const;
  readonly displayName = "OpenCode";
  readonly aliases = [] as const;
  readonly capabilities = caps({
    sessionLogs: true,
    agentDispatch: true,
    detection: true,
    configImport: true,
    runtimeIdentity: true,
    v1Migration: true,
  });
}
