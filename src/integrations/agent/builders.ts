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
import { type AgentCommandBuilder, assertNotFlag } from "./builder-shared";
import { resolveModel } from "./model-aliases";
import { getBuiltinAgentProfile } from "./profiles";

export type { AgentCommandBuilder, AgentDispatchRequest, BuiltCommand } from "./builder-shared";
export { assertNotFlag, normalizeTools } from "./builder-shared";

// ── Platform builders ─────────────────────────────────────────────────────────

// The OpenCode builder was migrated to its harness directory in #564
// (`harnesses/opencode/agent-builder.ts`) and the Claude Code builder in #563
// (`harnesses/claude/agent-builder.ts`). Both are imported back into
// BUILTIN_BUILDERS below so platform routing is unchanged.

/**
 * Default builder — used for custom profiles and any platform without a
 * dedicated builder. Passes systemPrompt and model via the same flags as
 * the builtin builders so custom profiles benefit from agent asset metadata.
 * Tools are omitted — no standard cross-platform flag exists.
 */
const defaultBuilder: AgentCommandBuilder = {
  platform: "default",
  build(profile, req) {
    assertNotFlag(req.systemPrompt, "systemPrompt");
    assertNotFlag(req.model, "model");
    const args: string[] = [...profile.args];
    if (req.systemPrompt) {
      args.push("--system-prompt", req.systemPrompt);
    }
    if (req.model) {
      const resolved = resolveModel(req.model, profile.name, profile.modelAliases, profile.globalModelAliases);
      args.push("--model", resolved);
    }
    args.push("--");
    args.push(req.prompt);
    return { argv: [profile.bin, ...args] };
  },
};

// ── Registry ──────────────────────────────────────────────────────────────────

/**
 * DERIVED from `HARNESS_REGISTRY` (P0.5 registry-drift fix): each harness that
 * owns an `agentBuilder` is registered under its canonical id, its
 * `<id>-headless` profile variant, and every alias. Previously this was a
 * hand-maintained map that could (and did) drift from the harness registry.
 */
const BUILTIN_BUILDERS: Readonly<Record<string, AgentCommandBuilder>> = (() => {
  const registry: Record<string, AgentCommandBuilder> = {};
  for (const harness of HARNESS_REGISTRY as readonly (typeof HARNESS_REGISTRY)[number][]) {
    if (!harness.agentBuilder) continue;
    registry[harness.id] = harness.agentBuilder;
    registry[`${harness.id}-headless`] = harness.agentBuilder;
    for (const alias of harness.aliases) registry[alias] = harness.agentBuilder;
  }
  return Object.freeze(registry);
})();

/**
 * Return the builder for the given platform name.
 *
 * A *custom* profile (unknown platform) falls back to the default builder —
 * that generic `--system-prompt`/`--model`/`--` shape is the documented
 * contract for user-defined wrappers. A *known built-in agent CLI* with no
 * dedicated builder (codex, gemini, aider + their `-headless` variants) is a
 * loud `ConfigError` instead: the default flag shape is wrong for those CLIs
 * (aider, for one, treats positionals as file names), so the old silent
 * fallback produced a broken command that "ran" and failed downstream.
 * Custom builders injected via tests can be passed as `registry`.
 */
export function getCommandBuilder(
  platform: string,
  registry: Record<string, AgentCommandBuilder> = BUILTIN_BUILDERS,
): AgentCommandBuilder {
  const found = registry[platform];
  if (found) return found;
  if (getBuiltinAgentProfile(platform)) {
    throw new ConfigError(
      `agent dispatch for "${platform}" is not supported yet: no command builder exists for this CLI, and the generic flag shape would produce a broken command.`,
      "INVALID_CONFIG_FILE",
      'Use an "opencode" or "claude" profile, or — if your CLI is flag-compatible with one of those — set `profiles.agent.<name>.commandBuilder` to "opencode" or "claude".',
    );
  }
  return defaultBuilder;
}
