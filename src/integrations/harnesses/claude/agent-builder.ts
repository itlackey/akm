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
 * (`{"type":"result","result":"<final answer>","session_id":"…", …}`) — the
 * "native-json" tier, NOT "native-schema". (The registry's earlier
 * `native-schema` claim described Claude Code's IN-HARNESS `Workflow`/`agent()`
 * tool-input-schema path, which is a different execution surface than the
 * agentBuilder dispatch akm's local-runner uses; the descriptor is aligned to
 * `native-json` to match this builder honestly.)
 *
 * So for a schema-bearing unit this builder emits `--output-format json` and
 * appends the SAME schema directive the engine's prompt assembly uses
 * (`step-work.ts` `buildUnitPrompt`) so a direct (non-workflow) dispatch is
 * self-sufficient — matching the copilot/gemini native-json builders. The
 * result envelope is unwrapped by `./result-extractor.ts`, and the engine's
 * shared `runStructured` retry-until-valid loop still validates the extracted
 * text against the node schema (constrained/hinted output is trusted but
 * verified). Without a schema the argv is byte-identical to the pre-fix shape.
 *
 * The builder's `platform` stays `'claude'` (the canonical harness id).
 */

import {
  type AgentCommandBuilder,
  type AgentDispatchRequest,
  assertNotFlag,
  normalizeTools,
  resolveDispatchModel,
} from "../../agent/builder-shared";

/**
 * Assemble the positional prompt: the task prompt and — when a schema is
 * requested — the same schema directive the workflow engine's prompt assembly
 * uses (`step-work.ts` `buildUnitPrompt`), so both dispatch paths speak one
 * dialect. Claude Code takes the system prompt as a `--system-prompt` FLAG (it
 * has one, unlike copilot/gemini), so only the schema directive is folded in
 * here.
 */
function buildPromptPayload(req: AgentDispatchRequest): string {
  if (!req.schema) return req.prompt;
  return `${req.prompt}\n\nRespond with ONLY a JSON value matching this JSON Schema (no prose, no code fences):\n${JSON.stringify(req.schema)}`;
}

/**
 * Claude Code builder.
 * Command shape:
 *   claude [--system-prompt "..."] [--model <m>] [--allowedTools <t>]
 *          [--output-format json] --print -- "<prompt (+ schema directive)>"
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
    args.push(buildPromptPayload(req));
    return { argv: [profile.bin, ...args] };
  },
};
