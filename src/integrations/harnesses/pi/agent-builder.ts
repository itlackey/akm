// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Pi coding-agent CLI command builder (P2, plan §"The adapter contract"
 * step 2 / §"Capability matrix").
 *
 * Translates a platform-agnostic {@link AgentDispatchRequest} into the exact
 * headless argv the `pi` CLI expects. Per the capability matrix the headless
 * invocation is:
 *
 *   pi -p "<prompt>"
 *
 * with `--mode json` for structured (JSONL) output, `--model <m>` for model
 * selection, and `-c`/`-r`/`--session <id>` for resume. Resume is
 * registry-side (`AkmHarness.resume`, flag-shaped: {@link PI_RESUME_FLAG}) —
 * not built here because `AgentDispatchRequest` carries no session id.
 *
 * Platform-specific mapping decisions (all localized here, per the adapter
 * contract):
 *
 * - **prompt** — `-p` is Pi's non-interactive print mode (same convention as
 *   Claude Code's `--print`); the prompt is the trailing positional message.
 *   The `--` end-of-options separator precedes it, mirroring the claude/codex
 *   builders, so a prompt whose text begins with `-`/`--` can never be parsed
 *   as flags.
 * - **systemPrompt** — passed via `--system-prompt` (Pi follows the Claude
 *   Code flag conventions), guarded by `assertNotFlag`.
 * - **schema** — the matrix places Pi in the "via prompt+validate" tier (no
 *   native `--output-schema` equivalent, unlike Codex), so the JSON Schema is
 *   passed through the prompt: a directive matching the engine's wording
 *   (`native-executor.ts` `buildUnitPrompt`) is appended to the prompt
 *   payload, and `--mode json` is emitted so stdout is the documented JSONL
 *   event stream that `./result-extractor.ts` normalizes. The engine's shared
 *   retry-until-valid loop performs the actual validation. Without a schema
 *   the argv matches the matrix's bare headless shape (`pi -p "<p>"`) and the
 *   extractor's plain-text path applies.
 * - **tools** — deliberately unconsumed. Pi manages tool access through its
 *   own config/extension system (the matrix lists MCP as "extensions only");
 *   there is no documented per-tool allowlist flag, and inventing one would
 *   produce a silently broken command. A restrictive policy is therefore
 *   dropped rather than approximated — never silently widened.
 * - **effort** — stays unconsumed (reserved; the shared request contract's
 *   "no builder consumes it yet" note stays true).
 *
 * NOT registered anywhere: `builders.ts` / `harnesses/index.ts` wiring is a
 * follow-up integration task (as are the `PI_*` identity-env markers, which
 * are registry-side). Exported standalone so that task only adds a registry
 * entry.
 */

import { type AgentCommandBuilder, type AgentDispatchRequest, assertNotFlag } from "../../agent/builder-shared";
import { resolveModel } from "../../agent/model-aliases";

/** Canonical harness/platform id used for model-alias resolution. */
export const PI_PLATFORM = "pi";

/**
 * Flag-shaped resume support per the capability matrix (`--session <id>`).
 * Exported for the integration task's `AkmHarness.resume` registry entry; the
 * harness-native session id comes from the unit row (stored opportunistically
 * by the result extractor) — akm never depends on it (plan §"Session, MCP,
 * and identity across harnesses").
 */
export const PI_RESUME_FLAG = "--session";

/**
 * Assemble the positional prompt payload: the task prompt and — when a schema
 * is requested — the same schema directive the workflow engine's prompt
 * assembly uses, so both dispatch paths speak one dialect.
 */
function buildPromptPayload(req: AgentDispatchRequest): string {
  const sections: string[] = [req.prompt];
  if (req.schema) {
    sections.push(
      `Respond with ONLY a JSON value matching this JSON Schema (no prose, no code fences):\n${JSON.stringify(req.schema)}`,
    );
  }
  return sections.join("\n\n");
}

/**
 * Pi builder.
 * Command shape:
 *   pi [--system-prompt "..."] [--model <m>] [--mode json] -p -- "<prompt[\n\nschema directive]>"
 */
export const piBuilder: AgentCommandBuilder = {
  platform: PI_PLATFORM,
  build(profile, req) {
    assertNotFlag(req.systemPrompt, "systemPrompt");
    assertNotFlag(req.model, "model");
    const args: string[] = [...profile.args];
    if (req.systemPrompt) {
      args.push("--system-prompt", req.systemPrompt);
    }
    if (req.model) {
      const resolved = resolveModel(req.model, PI_PLATFORM, profile.modelAliases, profile.globalModelAliases);
      args.push("--model", resolved);
    }
    if (req.schema) {
      // Structured unit: JSONL event stream on stdout — the pi result
      // extractor's documented input (prompt+validate tier).
      args.push("--mode", "json");
    }
    // -p = non-interactive print mode; prompt is the trailing positional.
    args.push("-p");
    args.push("--");
    args.push(buildPromptPayload(req));
    return { argv: [profile.bin, ...args] };
  },
};
