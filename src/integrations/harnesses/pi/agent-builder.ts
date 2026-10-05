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
 * selection, and `-c`/`-r`/`--session <id>` for resume — not built here
 * because `AgentDispatchRequest` carries no session id (akm's
 * `workflow_run_units` is the durable resume source of truth).
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
 *   Code flag conventions).
 * - **schema** — the matrix places Pi in the "via prompt+validate" tier (no
 *   native `--output-schema` equivalent, unlike Codex), so the JSON Schema
 *   reaches it as the instruction the shared request lowering appends to the
 *   prompt, and `--mode json` is emitted so stdout is the documented JSONL
 *   event stream that `./result-extractor.ts` normalizes. The engine's shared
 *   retry-until-valid loop performs the actual validation. Without a schema
 *   the argv matches the matrix's bare headless shape (`pi -p "<p>"`) and the
 *   extractor's plain-text path applies.
 * - **tools** — deliberately unconsumed. Pi manages tool access through its
 *   own config/extension system (the matrix lists MCP as "extensions only");
 *   there is no documented per-tool allowlist flag, and inventing one would
 *   produce a silently broken command. A restrictive policy is therefore
 *   dropped rather than approximated — never silently widened.
 * - **inference** — not translated: the shared lowering reports each field of
 *   the request's inference as untranslated.
 *
 * Registered: `piBuilder` is `PiHarness.agentBuilder` (`./index.ts`), one of
 * the ten harnesses `HARNESS_REGISTRY` constructs (`harnesses/index.ts`);
 * `agent/builders.ts` derives `BUILTIN_BUILDERS` from that registry, so this
 * builder is reachable under the `"pi"` platform name without any further
 * wiring. The `PI_SESSION_ID` identity-env marker is declared alongside it
 * (`./index.ts`).
 */

import { type AgentCommandBuilder, resolveDispatchModel } from "../../agent/builder-shared";
import { createAgentRequestLowerer } from "../../agent/request-lowering";

/** Canonical harness/platform id used for model-alias resolution. */
export const PI_PLATFORM = "pi";

/**
 * Pi builder.
 * Command shape:
 *   pi [--system-prompt "..."] [--model <m>] [--mode json] -p -- "<prompt>"
 */
export const piBuilder: AgentCommandBuilder = {
  platform: PI_PLATFORM,
  personaChannel: "native",
  lower: createAgentRequestLowerer({
    adapter: PI_PLATFORM,
    personaChannel: "native",
    tools: "none",
  }),
  build(profile, req) {
    const args: string[] = [...profile.args];
    if (req.systemPrompt) {
      args.push("--system-prompt", req.systemPrompt);
    }
    if (req.model) {
      const resolved = resolveDispatchModel(req, profile, PI_PLATFORM) as string;
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
    args.push(req.prompt);
    return { argv: [profile.bin, ...args] };
  },
};
