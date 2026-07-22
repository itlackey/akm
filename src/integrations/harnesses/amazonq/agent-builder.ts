// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Amazon Q Developer CLI agent command builder (P2, plan §"The adapter
 * contract" step 2 / §"Capability matrix").
 *
 * Translates a platform-agnostic {@link AgentDispatchRequest} into the exact
 * headless argv the `q` CLI expects. Per the capability matrix the headless
 * invocation is:
 *
 *   q chat --no-interactive --trust-all-tools "<prompt>"
 *
 * with `--model <m>` for model selection and `--resume` for resume — NOTE:
 * unlike every other harness's resume, Q's `--resume` is a bare flag that
 * replays the previous conversation *of the working directory*; it takes no
 * session id. There is nothing to thread from `workflow_run_units` — akm's own
 * unit rows remain the durable resume source of truth regardless (plan
 * §"Session, MCP, and identity across harnesses").
 *
 * Platform-specific mapping decisions (all localized here, per the adapter
 * contract):
 *
 * - **subcommand** — headless dispatch is the `chat` subcommand. The builder
 *   prepends `chat` itself (mirroring the codex builder's `exec` handling); a
 *   user profile that already pins `chat` as its first arg is not doubled.
 * - **prompt** — the trailing positional `[INPUT]` argument of `q chat`,
 *   preceded by the `--` end-of-options separator (mirroring the
 *   claude/codex/pi builders) so a prompt whose text begins with `-`/`--` can
 *   never be parsed as flags. `--no-interactive` makes Q print the response
 *   and exit instead of opening the REPL.
 * - **systemPrompt** — `q chat` has no system-prompt flag (persona/context
 *   comes from Q's own agent config files), so the system prompt is folded
 *   into the positional payload ahead of the task prompt, separated by a
 *   blank line. `assertNotFlag` still guards it.
 * - **schema** — the matrix places Q in the NO-structured-output tier
 *   ("via prompt+validate": *(none documented)* — there is no `--json` or
 *   `--output-format` to ask for). The JSON Schema is therefore passed
 *   through the prompt: a directive matching the engine's wording
 *   (`step-work.ts` `buildUnitPrompt`) is appended to the payload.
 *   Stdout stays plain text; `./result-extractor.ts` strips terminal framing
 *   and the engine's shared embedded-JSON parse + retry-until-valid loop does
 *   the rest. No schema temp file is written — that seam is codex-only
 *   (`--output-schema`); inventing a flag here would produce a silently
 *   broken command.
 * - **tools** — a string/array tool policy maps to Q's documented
 *   `--trust-tools=<t1,t2>` allowlist flag (equals-joined, per `q chat
 *   --help`). With no policy at all, headless runs need autonomy, so
 *   `--trust-all-tools` is emitted per the matrix. A *structured* policy
 *   object is NOT expressible as Q flags; it is deliberately dropped without
 *   falling back to `--trust-all-tools` (never silently widen a restriction)
 *   — Q then refuses untrusted tool actions in non-interactive mode, which is
 *   the conservative failure mode.
 * - **effort** — stays unconsumed (reserved; the shared request contract's
 *   "no builder consumes it yet" note stays true).
 *
 * NOT registered anywhere: `builders.ts` / `harnesses/index.ts` wiring is a
 * follow-up integration task (as is the registry-side capability entry —
 * pattern `local-runner`, structuredOutput `none`). Exported standalone so
 * that task only adds a registry entry.
 */

import {
  type AgentCommandBuilder,
  type AgentDispatchRequest,
  assertNotFlag,
  resolveDispatchModel,
} from "../../agent/builder-shared";

/** Canonical harness/platform id used for model-alias resolution. */
export const AMAZONQ_PLATFORM = "amazonq";

/**
 * Split a tool policy into individual tool names for `--trust-tools`.
 * Strings are comma-separated lists; arrays are taken as-is. Structured
 * policy objects return `undefined` (not expressible as Q flags — see
 * module doc).
 */
function toolPolicyEntries(tools: NonNullable<AgentDispatchRequest["tools"]>): string[] | undefined {
  if (typeof tools === "string") {
    return tools
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
  }
  if (Array.isArray(tools)) {
    return tools.map((t) => t.trim()).filter(Boolean);
  }
  return undefined;
}

/**
 * Assemble the positional prompt payload: optional system prompt, the task
 * prompt, and — when a schema is requested — the same schema directive the
 * workflow engine's prompt assembly uses, so both dispatch paths speak one
 * dialect.
 */
function buildPromptPayload(req: AgentDispatchRequest): string {
  const sections: string[] = [];
  if (req.systemPrompt) sections.push(req.systemPrompt);
  sections.push(req.prompt);
  if (req.schema) {
    sections.push(
      `Respond with ONLY a JSON value matching this JSON Schema (no prose, no code fences):\n${JSON.stringify(req.schema)}`,
    );
  }
  return sections.join("\n\n");
}

/**
 * Amazon Q Developer CLI builder.
 * Command shape:
 *   q chat --no-interactive (--trust-all-tools | --trust-tools=<t1,t2>)
 *          [--model <m>] -- "<systemPrompt?\n\nprompt\n\nschema directive?>"
 */
export const amazonqBuilder: AgentCommandBuilder = {
  platform: AMAZONQ_PLATFORM,
  build(profile, req) {
    assertNotFlag(req.systemPrompt, "systemPrompt");
    assertNotFlag(req.model, "model");
    // Built-in q profiles would ship `args: []`; headless dispatch is the
    // `chat` subcommand. Don't double it when a user profile already pins it.
    const extra = profile.args[0] === "chat" ? profile.args.slice(1) : [...profile.args];
    const args: string[] = ["chat", ...extra];
    // Print the response and exit — required for captured dispatch.
    args.push("--no-interactive");
    if (req.tools) {
      // Structured policy objects (entries === undefined) emit NO trust
      // flags: dropping a restriction must never widen to --trust-all-tools.
      const entries = toolPolicyEntries(req.tools);
      if (entries !== undefined) {
        for (const tool of entries) {
          assertNotFlag(tool, "tools entry");
        }
        // Q's documented allowlist form is equals-joined and comma-separated
        // (`--trust-tools=fs_read,fs_write`); an empty list trusts no tools.
        args.push(`--trust-tools=${entries.join(",")}`);
      }
    } else {
      // Headless default per the capability matrix: units must run without
      // interactive tool-approval prompts.
      args.push("--trust-all-tools");
    }
    if (req.model) {
      const resolved = resolveDispatchModel(req, profile, AMAZONQ_PLATFORM) as string;
      args.push("--model", resolved);
    }
    // No system-prompt / schema flags exist on `q chat` — both travel in the
    // positional payload, after the end-of-options separator.
    args.push("--");
    args.push(buildPromptPayload(req));
    return { argv: [profile.bin, ...args] };
  },
};
