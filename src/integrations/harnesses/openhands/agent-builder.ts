// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * OpenHands CLI agent command builder (P2, plan §"The adapter contract"
 * step 2 / §"Capability matrix").
 *
 * Translates a platform-agnostic {@link AgentDispatchRequest} into the exact
 * headless argv the `openhands` CLI expects. Per the capability matrix the
 * headless invocation is:
 *
 *   openhands --headless -t "<p>" --json
 *
 * with `--json` producing the documented JSONL event stream (structured tier
 * "via prompt+validate"), workspace-state resume (no session-id flag), and
 * native MCP support.
 *
 * Platform-specific mapping decisions (all localized here, per the adapter
 * contract):
 *
 * - **prompt** — `--task` is the long form of the matrix's `-t` (used for
 *   self-documenting argv, mirroring the aider builder's `--message`). Like
 *   aider — and unlike claude/codex/pi — there is NO positional prompt and NO
 *   `--` end-of-options separator to hide behind: the task is a *flag value*.
 *   The glued `--task=<payload>` form is therefore used so a payload that
 *   begins with `-`/`--` binds to the flag lexically and can never be parsed
 *   as a separate option by the CLI's argument parser.
 * - **--headless / --json** — always emitted: `--headless` is what makes a
 *   captured, unattended run possible, and `--json` switches stdout to the
 *   JSONL event stream that `./result-extractor.ts` normalizes (the same
 *   "dispatch is the captured path" reasoning as the Claude builder's
 *   unconditional `--print`; both flags are the matrix's documented headless
 *   shape).
 * - **systemPrompt** — OpenHands headless mode has no documented
 *   system-prompt flag (agent behaviour is shaped by its own agent configs
 *   and microagents). Folded into the task payload — system text first, blank
 *   line, then the task — mirroring the aider/codex treatment.
 * - **model** — OpenHands does not take the model on the headless command
 *   line; its documented configuration channel is the `LLM_MODEL` environment
 *   variable (config.toml `[llm] model` equivalent). The alias is resolved via
 *   `resolveModel` with this platform id and returned on `BuiltCommand.env`
 *   (the seam exists precisely for platform-specific extras), NOT as an
 *   invented `--model` flag that would produce a silently broken command.
 * - **schema** — the matrix places OpenHands in the "via prompt+validate"
 *   tier (plan §"Structured-output normalization", tier "native-json"): no
 *   Codex-style `--output-schema` flag exists, so NO temp schema file is
 *   written; the JSON Schema reaches it as the instruction the shared request
 *   lowering appends to the prompt. Downstream, the extractor pulls the
 *   final message out of the JSONL stream and the engine's shared
 *   retry-until-valid loop performs the actual validation.
 * - **tools** — deliberately unconsumed. OpenHands has no per-tool allowlist
 *   flag; tool access is governed by its own runtime/sandbox configuration
 *   and (natively supported) MCP config. A restrictive policy is therefore
 *   dropped rather than approximated — never silently widened.
 * - **resume/session** — NOT expressible: per the matrix OpenHands resumes
 *   from *workspace state*, not a session-id flag, so there is no flag-shaped
 *   resume to describe. The extractor still captures a
 *   conversation/session id opportunistically when the stream reveals one;
 *   akm's `workflow_run_units` remains the durable source of truth either way
 *   (plan §"Session, MCP, and identity across harnesses").
 * - **effort** — stays unconsumed (reserved; the shared request contract's
 *   "no builder consumes it yet" note stays true).
 *
 * Registered: `openhandsBuilder` is `OpenhandsHarness.agentBuilder`
 * (`./index.ts`), one of the ten harnesses `HARNESS_REGISTRY` constructs
 * (`harnesses/index.ts`); `agent/builders.ts` derives `BUILTIN_BUILDERS` from
 * that registry, so this builder is reachable under the `"openhands"`
 * platform name without any further wiring. The registry entry also declares
 * `pattern: "local-runner"`, `structuredOutput: "native-json"` alongside it
 * (`./index.ts`).
 */

import { type AgentCommandBuilder, type AgentDispatchRequest, resolveDispatchModel } from "../../agent/builder-shared";
import { createAgentRequestLowerer } from "../../agent/request-lowering";

/** Canonical harness/platform id used for model-alias resolution. */
export const OPENHANDS_PLATFORM = "openhands";

/**
 * Env var OpenHands reads its LLM model from — the platform's documented
 * model-selection channel for headless runs (there is no headless model
 * flag). Exported (re-exported from `./index.ts`) so this harness's tests
 * share the one constant.
 */
export const OPENHANDS_MODEL_ENV = "LLM_MODEL";

/** Assemble the `--task` payload: optional system text, then the task prompt. */
function buildTaskPayload(req: AgentDispatchRequest): string {
  const sections: string[] = [];
  if (req.systemPrompt) sections.push(req.systemPrompt);
  sections.push(req.prompt);
  return sections.join("\n\n");
}

/**
 * OpenHands builder.
 * Command shape:
 *   openhands --headless --json --task=<[system\n\n]prompt>
 * with the resolved model (if any) carried on env as LLM_MODEL.
 */
export const openhandsBuilder: AgentCommandBuilder = {
  platform: OPENHANDS_PLATFORM,
  personaChannel: "prompt",
  lower: createAgentRequestLowerer({
    adapter: OPENHANDS_PLATFORM,
    personaChannel: "prompt",
    tools: "none",
  }),
  build(profile, req) {
    const args: string[] = [...profile.args];
    // Headless essentials (matrix shape): non-interactive run, JSONL stdout
    // for the extractor.
    args.push("--headless");
    args.push("--json");
    // Glued form: the payload is a flag VALUE (no positional prompt exists),
    // so `=` binding keeps a dash-leading payload from parsing as an option.
    args.push(`--task=${buildTaskPayload(req)}`);
    let env: Record<string, string> | undefined;
    if (req.model) {
      const resolved = resolveDispatchModel(req, profile, OPENHANDS_PLATFORM) as string;
      // Model travels via env, not argv — OpenHands' documented channel.
      env = { [OPENHANDS_MODEL_ENV]: resolved };
    }
    return { argv: [profile.bin, ...args], ...(env ? { env } : {}) };
  },
};
