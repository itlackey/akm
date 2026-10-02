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
 *   blank line.
 * - **schema** — the matrix places Q in the NO-structured-output tier
 *   ("via prompt+validate": *(none documented)* — there is no `--json` or
 *   `--output-format` to ask for). The JSON Schema therefore reaches it only
 *   as the instruction the shared request lowering appends to the prompt.
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
 * Registered: `amazonqBuilder` is `AmazonqHarness.agentBuilder`
 * (`./index.ts`), one of the ten harnesses `HARNESS_REGISTRY` constructs
 * (`harnesses/index.ts`); `agent/builders.ts` derives `BUILTIN_BUILDERS` from
 * that registry, so this builder is reachable under the `"amazonq"` platform
 * name without any further wiring. The registry-side capability entry —
 * pattern `local-runner`, structuredOutput `none` — is declared alongside it
 * (`./index.ts`).
 */

import { type AgentCommandBuilder, type AgentDispatchRequest, resolveDispatchModel } from "../../agent/builder-shared";
import { createAgentRequestLowerer } from "../../agent/request-lowering";

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

/** Assemble the positional prompt payload: optional system prompt, then the task prompt. */
function buildPromptPayload(req: AgentDispatchRequest): string {
  const sections: string[] = [];
  if (req.systemPrompt) sections.push(req.systemPrompt);
  sections.push(req.prompt);
  return sections.join("\n\n");
}

/**
 * Amazon Q Developer CLI builder.
 * Command shape:
 *   q chat --no-interactive (--trust-all-tools | --trust-tools=<t1,t2>)
 *          [--model <m>] -- "<systemPrompt?\n\nprompt>"
 */
export const amazonqBuilder: AgentCommandBuilder = {
  platform: AMAZONQ_PLATFORM,
  personaChannel: "prompt",
  lower: createAgentRequestLowerer({
    adapter: AMAZONQ_PLATFORM,
    personaChannel: "prompt",
    tools: "flat",
  }),
  build(profile, req) {
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
    // No system-prompt flag exists on `q chat` — it travels in the positional
    // payload, after the end-of-options separator.
    args.push("--");
    args.push(buildPromptPayload(req));
    return { argv: [profile.bin, ...args] };
  },
};
