// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Claude Code agent command builder (migrated from `agent/builders.ts`, #563).
 *
 * Translates a platform-agnostic {@link AgentDispatchRequest} into the exact
 * argv the `claude` CLI expects. This is the Claude-specific slice of the
 * builder strategy; the shared infrastructure (`AgentCommandBuilder`,
 * `getCommandBuilder`, the OpenCode/default builders, flag/tool helpers) stays
 * in `agent/builders.ts`, which imports this builder back into
 * `BUILTIN_BUILDERS`.
 *
 * Behaviour-preserving relocation: the produced argv is byte-identical to the
 * pre-migration `claudeBuilder`. The builder's `platform` stays `'claude'` (the
 * canonical harness id).
 */

import { type AgentCommandBuilder, assertNotFlag, normalizeTools } from "../../agent/builder-shared";
import { resolveModel } from "../../agent/model-aliases";

/**
 * Claude Code builder.
 * Command shape: claude [--system-prompt "..."] [--model <m>] [--allowedTools <t>] --print "<prompt>"
 *
 * --print switches Claude Code to non-interactive captured output mode.
 */
export const claudeBuilder: AgentCommandBuilder = {
  platform: "claude",
  build(profile, req) {
    assertNotFlag(req.systemPrompt, "systemPrompt");
    assertNotFlag(req.model, "model");
    const args: string[] = [...profile.args];
    if (req.systemPrompt) {
      args.push("--system-prompt", req.systemPrompt);
    }
    if (req.model) {
      const resolved = resolveModel(req.model, "claude", profile.modelAliases, profile.globalModelAliases);
      args.push("--model", resolved);
    }
    if (req.tools) {
      args.push("--allowedTools", normalizeTools(req.tools));
    }
    // --print = non-interactive, outputs to stdout — required for captured mode
    args.push("--print");
    args.push("--");
    args.push(req.prompt);
    return { argv: [profile.bin, ...args] };
  },
};
