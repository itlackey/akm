// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Aider CLI agent command builder (P2, plan §"The adapter contract" step 2 /
 * §"Capability matrix").
 *
 * Translates a platform-agnostic {@link AgentDispatchRequest} into the exact
 * headless argv the `aider` CLI expects. Per the capability matrix the
 * headless invocation is:
 *
 *   aider -m "<p>" --yes-always
 *
 * with `--model <m>` for model selection, NO structured-output mode (Aider is
 * the "none" tier — prompt-injected schema + embedded-JSON extraction), and
 * NO session flag (resume is chat-history files, not an id).
 *
 * Platform-specific mapping decisions (all localized here, per the adapter
 * contract):
 *
 * - **prompt** — `--message` is Aider's one-shot non-interactive mode (the
 *   matrix's `-m`; the long form is used for self-documenting argv). Unlike
 *   claude/codex/pi there is NO positional prompt and NO `--` end-of-options
 *   separator to hide behind: the prompt is a *flag value*. The glued
 *   `--message=<payload>` form is therefore used so a payload that begins
 *   with `-`/`--` binds to the flag lexically and can never be parsed as a
 *   separate option by Aider's argument parser.
 * - **--yes-always** — always emitted: auto-confirms every interactive
 *   prompt (create file? run command? …), which is what makes a captured,
 *   unattended run possible. This is the matrix's documented headless shape.
 * - **--no-pretty** — always emitted: disables colored/pretty terminal
 *   rendering so captured stdout is clean text for `./result-extractor.ts`
 *   (the same "dispatch is the captured path" reasoning as the Claude
 *   builder's unconditional `--print` and Codex's unconditional `--json`).
 * - **systemPrompt** — Aider has no system-prompt flag (its nearest concept
 *   is conventions files via `--read`, which take a path, not text). Folded
 *   into the message payload — system text first, blank line, then the task —
 *   mirroring the codex builder's treatment.
 * - **schema** — the matrix places Aider in the "via prompt+validate" tier
 *   with *no* structured output mode at all (plan §"Structured-output
 *   normalization", tier "none"): there is no schema flag and no JSON output
 *   flag, so the JSON Schema is injected into the message payload using the
 *   exact directive wording of the engine's prompt assembly
 *   (`step-work.ts` `buildUnitPrompt`) and the pi builder, so all
 *   dispatch paths speak one dialect. Downstream, embedded-JSON extraction +
 *   the engine's shared retry-until-valid loop supply the validation Aider
 *   lacks. No temp schema file is written — that is Codex's native-schema
 *   mechanism (`--output-schema`), which Aider does not have.
 * - **tools** — deliberately unconsumed. Aider has no per-tool allowlist
 *   flag; tool-ish behaviour is governed by its own switches (`--yes-always`,
 *   git integration, shell-command confirmation). A restrictive policy is
 *   therefore dropped rather than approximated — never silently widened.
 * - **resume/session** — NOT expressible: Aider persists context in
 *   chat-history files (`.aider.chat.history.md`), not session ids, so there
 *   is no flag-shaped `HarnessResumeSupport` to export and the extractor
 *   never yields a `sessionId`. akm's `workflow_run_units` remains the
 *   durable source of truth; resume works even against a harness with no
 *   session model (plan §"Session, MCP, and identity across harnesses" —
 *   Aider is the plan's named example).
 * - **effort** — stays unconsumed (reserved; the shared request contract's
 *   "no builder consumes it yet" note stays true).
 *
 * NOT registered anywhere: `builders.ts` / `harnesses/index.ts` wiring is a
 * follow-up integration task (as is the registry entry declaring
 * `structuredOutput: "none"` and no `resume`). Exported standalone so that
 * task only adds a registry entry.
 */

import { type AgentCommandBuilder, type AgentDispatchRequest, assertNotFlag } from "../../agent/builder-shared";
import { resolveModel } from "../../agent/model-aliases";

/** Canonical harness/platform id used for model-alias resolution. */
export const AIDER_PLATFORM = "aider";

/**
 * Assemble the `--message` payload: optional system text, the task prompt,
 * and — when a schema is requested — the same schema directive the workflow
 * engine's prompt assembly uses (Aider has no native structured output, so
 * the prompt is the only channel; plan §"Structured-output normalization",
 * tier "none").
 */
function buildMessagePayload(req: AgentDispatchRequest): string {
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
 * Aider builder.
 * Command shape:
 *   aider [--model <m>] --yes-always --no-pretty --message=<[system\n\n]prompt[\n\nschema directive]>
 */
export const aiderBuilder: AgentCommandBuilder = {
  platform: AIDER_PLATFORM,
  build(profile, req) {
    assertNotFlag(req.systemPrompt, "systemPrompt");
    assertNotFlag(req.model, "model");
    const args: string[] = [...profile.args];
    if (req.model) {
      const resolved = resolveModel(req.model, AIDER_PLATFORM, profile.modelAliases, profile.globalModelAliases);
      args.push("--model", resolved);
    }
    // Headless essentials (matrix shape): auto-confirm everything, and keep
    // captured stdout free of pretty/ANSI rendering for the extractor.
    args.push("--yes-always");
    args.push("--no-pretty");
    // Glued form: the payload is a flag VALUE (no positional prompt exists),
    // so `=` binding keeps a dash-leading payload from parsing as an option.
    args.push(`--message=${buildMessagePayload(req)}`);
    return { argv: [profile.bin, ...args] };
  },
};
