// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Gemini CLI agent command builder (P2, plan §"The adapter contract" step 2 /
 * §"Capability matrix").
 *
 * Translates a platform-agnostic {@link AgentDispatchRequest} into the exact
 * headless argv the `gemini` CLI expects. Per the capability matrix the
 * headless invocation is:
 *
 *   gemini -p "<prompt>"
 *
 * with `--output-format json` for structured output, `--model <m>` for model
 * selection, and `--resume <id>` for resume; resume is not built here because
 * `AgentDispatchRequest` carries no session id. The `GEMINI_CLI=1` identity
 * env marker is likewise registry-side (`AkmHarness.identityEnv` /
 * `agent-identity.ts`), not a builder concern.
 *
 * Platform-specific mapping decisions (all localized here, per the adapter
 * contract):
 *
 * - **systemPrompt** — Gemini CLI has no system-prompt flag in headless mode
 *   (system text comes from `GEMINI.md` context files / `GEMINI_SYSTEM_MD`),
 *   so the system prompt is folded into the `-p` payload ahead of the task
 *   prompt, separated by a blank line.
 * - **schema** — the matrix places Gemini in the "via prompt+validate" tier
 *   (no native `--output-schema` equivalent, unlike Codex — so no temp-file
 *   plumbing here), so the JSON Schema reaches it as the instruction the
 *   shared request lowering appends to the prompt, and
 *   `--output-format json` is emitted so stdout is the documented JSON
 *   envelope the gemini result extractor normalizes. The engine's shared
 *   retry-until-valid loop performs the actual validation.
 * - **tools** — nothing is emitted: the matrix's headless shape is the bare
 *   `gemini -p "<p>"`; autonomy flags (`--yolo`, `--approval-mode`) belong in
 *   `profile.args` where the operator opts in explicitly.
 *
 * Registered: `geminiBuilder` is `GeminiHarness.agentBuilder` (`./index.ts`),
 * one of the ten harnesses `HARNESS_REGISTRY` constructs
 * (`harnesses/index.ts`); `agent/builders.ts` derives `BUILTIN_BUILDERS` from
 * that registry, so this builder is reachable under the `"gemini"` platform
 * name without any further wiring.
 */

import type { AgentCommandBuilder, AgentDispatchRequest } from "../../agent/builder-shared";
import { createAgentRequestLowerer } from "../../agent/request-lowering";

/** Canonical harness/platform id used for model-alias resolution. */
export const GEMINI_PLATFORM = "gemini";

/** Assemble the `-p` payload: optional system prompt, then the task prompt. */
function buildPromptPayload(req: AgentDispatchRequest): string {
  const sections: string[] = [];
  if (req.systemPrompt) sections.push(req.systemPrompt);
  sections.push(req.prompt);
  return sections.join("\n\n");
}

/**
 * Gemini CLI builder.
 * Command shape:
 *   gemini [--model <m>]
 *          [--output-format json] -p "<systemPrompt?\n\nprompt>"
 */
export const geminiBuilder: AgentCommandBuilder = {
  platform: GEMINI_PLATFORM,
  personaChannel: "prompt",
  lower: createAgentRequestLowerer({
    adapter: GEMINI_PLATFORM,
    personaChannel: "prompt",
  }),
  build(profile, req) {
    const args: string[] = [...profile.args];
    if (req.model) {
      args.push("--model", req.model);
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
