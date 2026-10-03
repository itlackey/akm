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
 * ## Structured output
 *
 * For a schema-bearing request this builder emits `--output-format json`,
 * which wraps the run in a RESULT ENVELOPE
 * (`{"type":"result","result":"<final answer>","session_id":"…", …}`); the
 * shared request lowering has already appended the schema instruction to the
 * prompt. The envelope is unwrapped by `./result-extractor.ts`, and the
 * engine's shared `runStructured` retry-until-valid loop validates the
 * extracted text against the schema (hinted output is trusted but verified).
 * Without a schema the argv carries no output flag.
 *
 * Claude Code 2.1.283 also has `--json-schema <schema>` (JSON Schema for
 * structured output validation, with `--print`). akm does not pass it; the
 * instruction and the validation loop above are what enforce a schema.
 *
 * The builder's `platform` stays `'claude'` (the canonical harness id).
 */

import { isModelWorkTools } from "../../../execution/source";
import {
  type AgentCommandBuilder,
  modelFromArgs,
  normalizeTools,
  resolveDispatchModel,
} from "../../agent/builder-shared";
import { createAgentRequestLowerer } from "../../agent/request-lowering";

/** The model-work tool policy on Claude Code: read, edit in the working directory, `akm search`, `akm show`. */
export const MODEL_WORK_CLAUDE_FLAGS: readonly string[] = Object.freeze([
  "--restricted",
  "--strict-mcp-config",
  "--tools",
  "Read,Edit,Bash",
  "--allowedTools",
  "Read,Edit,Bash(akm search *),Bash(akm show *)",
  "--permission-mode",
  "dontAsk",
]);

/**
 * Claude Code builder.
 * Command shape:
 *   claude [--agent <name>] [--system-prompt "..."] [--model <m>] [--allowedTools <t>]
 *          [--output-format json] --print -- "<prompt>"
 *
 * --print switches Claude Code to non-interactive captured output mode.
 *
 * The model-work tool policy lowers to {@link MODEL_WORK_CLAUDE_FLAGS} in place
 * of the engine's `args` and `--allowedTools`, verified against Claude Code
 * 2.1.283 and a local stub:
 *   - `--restricted` ignores the user, project and local settings files (whose
 *     allow rules would otherwise pre-approve any command or path) and confines
 *     the file tools to the working directory;
 *   - `--strict-mcp-config` starts no MCP server, and `--tools` offers only
 *     Read, Edit and Bash;
 *   - `--allowedTools` pre-approves Read, Edit, `akm search` and `akm show`,
 *     and `--permission-mode dontAsk` denies everything else instead of
 *     prompting, including a compound, redirected or substituted command.
 * The engine's `args` are left out because `--add-dir`, `--settings` or a
 * second `--allowedTools` would widen that. Only the model they name is kept.
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
    const modelWork = isModelWorkTools(req.tools);
    const args: string[] = modelWork ? [...MODEL_WORK_CLAUDE_FLAGS] : [...profile.args];
    if (req.agent) {
      args.push("--agent", req.agent);
    }
    if (req.systemPrompt) {
      args.push("--system-prompt", req.systemPrompt);
    }
    if (req.model) {
      const resolved = resolveDispatchModel(req, profile, "claude") as string;
      args.push("--model", resolved);
    } else if (modelWork) {
      const model = modelFromArgs(profile.args);
      if (model) args.push("--model", model);
    }
    if (req.tools && !modelWork) {
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
