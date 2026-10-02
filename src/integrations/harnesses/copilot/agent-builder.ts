// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * GitHub Copilot CLI agent command builder (P2, plan §"The adapter contract"
 * step 2 / §"Capability matrix").
 *
 * Translates a platform-agnostic {@link AgentDispatchRequest} into the exact
 * headless argv the `copilot` CLI expects. Per the capability matrix the
 * headless invocation is:
 *
 *   copilot -p "<prompt>" --allow-all-tools
 *
 * with `--output-format json` for structured output, `--model <m>` for model
 * selection, and `--resume <id>` for resume (not built here because
 * `AgentDispatchRequest` carries no session id).
 *
 * Platform-specific mapping decisions (all localized here, per the adapter
 * contract):
 *
 * - **systemPrompt** — Copilot CLI has no system-prompt flag (it reads
 *   repo/user custom-instructions files instead), so the system prompt is
 *   folded into the `-p` payload ahead of the task prompt, separated by a
 *   blank line.
 * - **schema** — the matrix places Copilot in the "via prompt+validate" tier
 *   (no native `--output-schema` equivalent, unlike Codex), so the JSON
 *   Schema reaches it as the instruction the shared request lowering appends
 *   to the prompt, and `--output-format json` is emitted so stdout is the
 *   documented JSON envelope the copilot result extractor normalizes. The
 *   engine's shared retry-until-valid loop performs the actual validation.
 * - **tools** — a string/array tool policy maps to repeated
 *   `--allow-tool <t>` flags (Copilot's per-tool approval flag). With no
 *   policy at all, headless runs need autonomy, so `--allow-all-tools` is
 *   emitted per the matrix. A *structured* policy object is NOT expressible
 *   as Copilot flags; it is deliberately dropped without falling back to
 *   `--allow-all-tools` (never silently widen a restriction) — in
 *   programmatic mode Copilot then denies unapproved tool calls, which is the
 *   conservative failure mode.
 *
 * Registered: `copilotBuilder` is `CopilotHarness.agentBuilder`
 * (`./index.ts`), one of the ten harnesses `HARNESS_REGISTRY` constructs
 * (`harnesses/index.ts`); `agent/builders.ts` derives `BUILTIN_BUILDERS` from
 * that registry, so this builder is reachable under the `"copilot"` platform
 * name without any further wiring.
 */

import { type AgentCommandBuilder, type AgentDispatchRequest, resolveDispatchModel } from "../../agent/builder-shared";
import { createAgentRequestLowerer } from "../../agent/request-lowering";

/** Canonical harness/platform id used for model-alias resolution. */
export const COPILOT_PLATFORM = "copilot";

/**
 * Split a tool policy into individual tool names for `--allow-tool`.
 * Strings are comma-separated lists; arrays are taken as-is. Structured
 * policy objects return `undefined` (not expressible as Copilot flags — see
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

/** Assemble the `-p` payload: optional system prompt, then the task prompt. */
function buildPromptPayload(req: AgentDispatchRequest): string {
  const sections: string[] = [];
  if (req.systemPrompt) sections.push(req.systemPrompt);
  sections.push(req.prompt);
  return sections.join("\n\n");
}

/**
 * GitHub Copilot CLI builder.
 * Command shape:
 *   copilot [--model <m>] (--allow-all-tools | --allow-tool <t> ...)
 *           [--output-format json] -p "<systemPrompt?\n\nprompt>"
 */
export const copilotBuilder: AgentCommandBuilder = {
  platform: COPILOT_PLATFORM,
  personaChannel: "prompt",
  lower: createAgentRequestLowerer({
    adapter: COPILOT_PLATFORM,
    personaChannel: "prompt",
    tools: "flat",
  }),
  build(profile, req) {
    const args: string[] = [...profile.args];
    if (req.model) {
      const resolved = resolveDispatchModel(req, profile, COPILOT_PLATFORM) as string;
      args.push("--model", resolved);
    }
    if (req.tools) {
      const entries = toolPolicyEntries(req.tools);
      // Structured policy objects (entries === undefined) emit NO allow flags:
      // dropping a restriction must never widen to --allow-all-tools.
      for (const tool of entries ?? []) {
        args.push("--allow-tool", tool);
      }
    } else {
      // Headless default per the capability matrix: units must run without
      // interactive tool-approval prompts.
      args.push("--allow-all-tools");
    }
    if (req.schema) {
      // Structured unit: ask for the documented JSON envelope so the result
      // extractor can pull the final message + session id deterministically.
      args.push("--output-format", "json");
    }
    args.push("-p", buildPromptPayload(req));
    return { argv: [profile.bin, ...args] };
  },
};
