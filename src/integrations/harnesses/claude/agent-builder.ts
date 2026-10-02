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
 * ## Structured output (Codex round-3 finding A)
 *
 * The headless `claude -p` (`--print`) CLI has NO native output-SCHEMA flag
 * (unlike Codex's `--output-schema <file>`). Its documented structured path is
 * `--output-format json`, which wraps the run in a RESULT ENVELOPE
 * (`{"type":"result","result":"<final answer>","session_id":"…", …}`).
 *
 * So for a schema-bearing unit this builder emits `--output-format json`; the
 * shared request lowering has already appended the schema instruction to the
 * prompt. The result envelope is unwrapped by `./result-extractor.ts`, and the
 * engine's shared `runStructured` retry-until-valid loop still validates the
 * extracted text against the node schema (constrained/hinted output is trusted
 * but verified). Without a schema the argv is byte-identical to the pre-fix
 * shape.
 *
 * The builder's `platform` stays `'claude'` (the canonical harness id).
 */

import { type AgentCommandBuilder, normalizeTools, resolveDispatchModel } from "../../agent/builder-shared";
import { createAgentRequestLowerer } from "../../agent/request-lowering";

/**
 * Claude Code builder.
 * Command shape:
 *   claude [--agent <name>] [--system-prompt "..."] [--model <m>] [--allowedTools <t>]
 *          [--output-format json] --print -- "<prompt>"
 *
 * --print switches Claude Code to non-interactive captured output mode.
 */
export const claudeBuilder: AgentCommandBuilder = {
  platform: "claude",
  personaChannel: "native",
  lower: createAgentRequestLowerer({
    adapter: "claude",
    personaChannel: "native",
    nativeAgentSelector: true,
    tools: "all",
  }),
  build(profile, req) {
    const args: string[] = [...profile.args];
    if (req.agent) {
      args.push("--agent", req.agent);
    }
    if (req.systemPrompt) {
      args.push("--system-prompt", req.systemPrompt);
    }
    if (req.model) {
      const resolved = resolveDispatchModel(req, profile, "claude") as string;
      args.push("--model", resolved);
    }
    if (req.tools) {
      args.push("--allowedTools", normalizeTools(req.tools));
    }
    if (req.schema) {
      // Structured unit: request the documented JSON result envelope so
      // `./result-extractor.ts` can pull the final answer + session id.
      args.push("--output-format", "json");
    }
    // --print = non-interactive, outputs to stdout — required for captured mode
    args.push("--print");
    args.push("--");
    args.push(req.prompt);
    return { argv: [profile.bin, ...args] };
  },
};
