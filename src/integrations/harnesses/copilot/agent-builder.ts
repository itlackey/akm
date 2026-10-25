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
 * - **tools** — headless runs need autonomy, so `--allow-all-tools` is always
 *   emitted, per the matrix.
 *
 * Registered: `copilotBuilder` is `CopilotHarness.agentBuilder`
 * (`./index.ts`), one of the ten harnesses `HARNESS_REGISTRY` constructs
 * (`harnesses/index.ts`); `agent/builders.ts` derives `BUILTIN_BUILDERS` from
 * that registry, so this builder is reachable under the `"copilot"` platform
 * name without any further wiring.
 */

import type { AgentDispatchRequest, HarnessBuilder } from "../harness";

/** Canonical harness/platform id used for model-alias resolution. */
export const COPILOT_PLATFORM = "copilot";

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
 *   copilot [--model <m>] --allow-all-tools
 *           [--output-format json] -p "<systemPrompt?\n\nprompt>"
 */
export const copilotBuilder: HarnessBuilder = {
  build(profile, req) {
    const args: string[] = [...profile.args];
    if (req.model) {
      args.push("--model", req.model);
    }
    // Headless: units must run without interactive tool-approval prompts.
    args.push("--allow-all-tools");
    if (req.schema) {
      // Structured unit: ask for the documented JSON envelope so the result
      // extractor can pull the final message + session id deterministically.
      args.push("--output-format", "json");
    }
    args.push("-p", buildPromptPayload(req));
    return { argv: [profile.bin, ...args] };
  },
};
