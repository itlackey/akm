// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * OpenCode agent command builder (migrated from `agent/builders.ts`, #564).
 *
 * Translates a platform-agnostic {@link AgentDispatchRequest} into the exact
 * argv the `opencode` CLI expects. This is the OpenCode-specific slice of the
 * builder strategy; the shared infrastructure (`AgentCommandBuilder`,
 * `getCommandBuilder`, the default builder, flag/tool helpers) stays in
 * `agent/builders.ts`, which imports this builder back into `BUILTIN_BUILDERS`.
 *
 * Behaviour-preserving relocation: the produced argv is byte-identical to the
 * pre-migration `opencodeBuilder`. The builder's `platform` stays `'opencode'`
 * (the canonical harness id).
 */

import { type AgentCommandBuilder, resolveDispatchModel } from "../../agent/builder-shared";
import { createAgentRequestLowerer } from "../../agent/request-lowering";

/**
 * OpenCode builder.
 * Command shape: opencode run [--agent <name>] [--model <m>] -- "<prompt>"
 *
 * `opencode run` has no system-prompt option (1.18.25 prints its usage and
 * exits 1 on `--system-prompt`), so the shared lowerer composes a persona
 * into the prompt.
 *
 * Tool policy is omitted — opencode manages tool access through its own agent
 * config files, not via CLI flags.
 */
export const opencodeBuilder: AgentCommandBuilder = {
  platform: "opencode",
  personaChannel: "prompt",
  lower: createAgentRequestLowerer({
    adapter: "opencode",
    personaChannel: "prompt",
    nativeAgentSelector: true,
    tools: "none",
  }),
  build(profile, req) {
    const args: string[] = req.model ? [] : [...profile.args];
    if (req.model) {
      for (let index = 0; index < profile.args.length; index += 1) {
        const arg = profile.args[index];
        if (arg === undefined) continue;
        if (arg === "--model") {
          index += 1;
        } else if (!arg.startsWith("--model=")) {
          args.push(arg);
        }
      }
    }
    if (req.agent) {
      args.push("--agent", req.agent);
    }
    if (req.model) {
      const resolved = resolveDispatchModel(req, profile, "opencode") as string;
      args.push("--model", resolved);
    }
    args.push("--");
    args.push(req.prompt);
    return { argv: [profile.bin, ...args] };
  },
};
