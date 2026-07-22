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
 *   prompt, separated by a blank line. `assertNotFlag` still guards it so a
 *   `--`-prefixed system prompt cannot turn the front of the `-p` value into
 *   a flag.
 * - **schema** — the matrix places Gemini in the "via prompt+validate" tier
 *   (no native `--output-schema` equivalent, unlike Codex — so no temp-file
 *   plumbing here), so the JSON Schema is passed through the prompt: a
 *   directive matching the engine's wording (`step-work.ts`
 *   `buildUnitPrompt`) is appended to the `-p` payload, and
 *   `--output-format json` is emitted so stdout is the documented JSON
 *   envelope the gemini result extractor normalizes. The engine's shared
 *   retry-until-valid loop performs the actual validation.
 * - **tools** — a string/array tool policy maps to repeated
 *   `--allowed-tools <t>` flags (Gemini's run-without-confirmation
 *   allowlist). A *structured* policy object is NOT expressible as Gemini
 *   flags; it is deliberately dropped without widening to an auto-approve
 *   flag (never silently widen a restriction). With no policy at all,
 *   NOTHING is emitted — the matrix's headless shape is the bare
 *   `gemini -p "<p>"`; autonomy flags (`--yolo`, `--approval-mode`) belong in
 *   `profile.args` where the operator opts in explicitly.
 *
 * NOT registered anywhere: `builders.ts` / `harnesses/index.ts` wiring is a
 * follow-up integration task. Exported standalone so that task only adds a
 * registry entry.
 */

import {
  type AgentCommandBuilder,
  type AgentDispatchRequest,
  assertNotFlag,
  resolveDispatchModel,
} from "../../agent/builder-shared";

/** Canonical harness/platform id used for model-alias resolution. */
export const GEMINI_PLATFORM = "gemini";

/**
 * Split a tool policy into individual tool names for `--allowed-tools`.
 * Strings are comma-separated lists; arrays are taken as-is. Structured
 * policy objects return `undefined` (not expressible as Gemini flags — see
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
 * Assemble the `-p` payload: optional system prompt, the task prompt, and —
 * when a schema is requested — the same schema directive the workflow
 * engine's prompt assembly uses, so both dispatch paths speak one dialect.
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
 * Gemini CLI builder.
 * Command shape:
 *   gemini [--model <m>] [--allowed-tools <t> ...]
 *          [--output-format json] -p "<systemPrompt?\n\nprompt\n\nschema?>"
 */
export const geminiBuilder: AgentCommandBuilder = {
  platform: GEMINI_PLATFORM,
  build(profile, req) {
    assertNotFlag(req.systemPrompt, "systemPrompt");
    assertNotFlag(req.model, "model");
    const args: string[] = [...profile.args];
    if (req.model) {
      const resolved = resolveDispatchModel(req, profile, GEMINI_PLATFORM) as string;
      args.push("--model", resolved);
    }
    if (req.tools) {
      // Structured policy objects (entries === undefined) emit NO flags:
      // dropping a restriction must never widen to auto-approval.
      for (const tool of toolPolicyEntries(req.tools) ?? []) {
        assertNotFlag(tool, "tools entry");
        args.push("--allowed-tools", tool);
      }
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
