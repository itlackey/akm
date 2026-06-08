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

import { claudeBuilder } from "../harnesses/claude/agent-builder";
// Types + shared validation helpers live in the leaf module `builder-shared.ts`
// so per-harness builders (harnesses/claude/agent-builder.ts) can depend on them
// without importing this file back — avoiding an init-order cycle through
// BUILTIN_BUILDERS (#563). Re-exported here so existing `agent/builders` import
// sites keep working.
import { type AgentCommandBuilder, assertNotFlag } from "./builder-shared";
import { resolveModel } from "./model-aliases";

export type { AgentCommandBuilder, AgentDispatchRequest, BuiltCommand } from "./builder-shared";
export { assertNotFlag, normalizeTools } from "./builder-shared";

// ── Platform builders ─────────────────────────────────────────────────────────

/**
 * OpenCode builder.
 * Command shape: opencode run [--system-prompt "..."] [--model <m>] "<prompt>"
 *
 * Tool policy is omitted — opencode manages tool access through its own agent
 * config files, not via CLI flags.
 */
const opencodeBuilder: AgentCommandBuilder = {
  platform: "opencode",
  build(profile, req) {
    assertNotFlag(req.systemPrompt, "systemPrompt");
    assertNotFlag(req.model, "model");
    const args: string[] = [...profile.args]; // starts with ["run"]
    if (req.systemPrompt) {
      args.push("--system-prompt", req.systemPrompt);
    }
    if (req.model) {
      const resolved = resolveModel(req.model, "opencode", profile.modelAliases);
      args.push("--model", resolved);
    }
    args.push("--");
    args.push(req.prompt);
    return { argv: [profile.bin, ...args] };
  },
};

// The Claude Code builder was migrated to its harness directory in #563:
// `src/integrations/harnesses/claude/agent-builder.ts`. It is imported back
// into BUILTIN_BUILDERS below so platform routing is unchanged.

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
      const resolved = resolveModel(req.model, profile.name, profile.modelAliases);
      args.push("--model", resolved);
    }
    args.push("--");
    args.push(req.prompt);
    return { argv: [profile.bin, ...args] };
  },
};

// ── Registry ──────────────────────────────────────────────────────────────────

const BUILTIN_BUILDERS: Readonly<Record<string, AgentCommandBuilder>> = {
  opencode: opencodeBuilder,
  "opencode-headless": opencodeBuilder,
  claude: claudeBuilder,
  "claude-headless": claudeBuilder,
};

/**
 * Return the builder for the given platform name, falling back to the default
 * builder for unknown platforms. Custom builders injected via tests can be
 * passed as `registry`.
 */
export function getCommandBuilder(
  platform: string,
  registry: Record<string, AgentCommandBuilder> = BUILTIN_BUILDERS,
): AgentCommandBuilder {
  return registry[platform] ?? defaultBuilder;
}
