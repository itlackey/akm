// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Agent command builder strategy (v1 spec §12.2).
 *
 * Each supported agent CLI platform has its own `AgentCommandBuilder` that
 * translates a platform-agnostic `AgentDispatchRequest` into the exact argv
 * the CLI expects. This keeps all per-platform arg differences out of the
 * spawn wrapper and profiles.
 *
 * Adding a new platform: implement `AgentCommandBuilder`, add to
 * `BUILTIN_BUILDERS`. Nothing else changes.
 */

import { ConfigError } from "../../core/errors";
import { HARNESS_REGISTRY } from "../harnesses";
// Types + shared validation helpers live in the leaf module `builder-shared.ts`
// so per-harness builders (harnesses/claude/agent-builder.ts) can depend on them
// without importing this file back — avoiding an init-order cycle through
// BUILTIN_BUILDERS (#563). Re-exported here so existing `agent/builders` import
// sites keep working.
import type { AgentCommandBuilder } from "./builder-shared";

export type { AgentCommandBuilder, AgentDispatchRequest, BuiltCommand } from "./builder-shared";
export { assertNotFlag, normalizeTools } from "./builder-shared";

// ── Platform builders ─────────────────────────────────────────────────────────

// The OpenCode builder was migrated to its harness directory in #564
// (`harnesses/opencode/agent-builder.ts`) and the Claude Code builder in #563
// (`harnesses/claude/agent-builder.ts`). Both are imported back into
// BUILTIN_BUILDERS below so platform routing is unchanged.

// ── Registry ──────────────────────────────────────────────────────────────────

/**
 * DERIVED from `HARNESS_REGISTRY` (P0.5 registry-drift fix): each harness that
 * owns an `agentBuilder` is registered under its canonical id. Named engines
 * are schema-validated to canonical harness ids before reaching this boundary.
 */
const BUILTIN_BUILDERS: Readonly<Record<string, AgentCommandBuilder>> = (() => {
  const registry: Record<string, AgentCommandBuilder> = {};
  for (const harness of HARNESS_REGISTRY as readonly (typeof HARNESS_REGISTRY)[number][]) {
    if (!harness.agentBuilder) continue;
    registry[harness.id] = harness.agentBuilder;
  }
  return Object.freeze(registry);
})();

/**
 * Return the builder for the given platform name.
 *
 * Unknown platforms are rejected: there is no safe generic CLI flag shape.
 * Custom builders injected by tests can be passed as `registry`.
 */
export function getCommandBuilder(
  platform: string,
  registry: Record<string, AgentCommandBuilder> = BUILTIN_BUILDERS,
): AgentCommandBuilder {
  const found = registry[platform];
  if (found) return found;
  throw new ConfigError(
    `Agent platform "${platform}" has no registered command builder.`,
    "INVALID_CONFIG_FILE",
    "Select a canonical agent platform in engines.<name>.platform.",
  );
}
