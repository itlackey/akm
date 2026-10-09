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
 * The builder's `platform` stays `'opencode'` (the canonical harness id). The
 * argv comes from one of two small adapters, chosen by the major the
 * engine's binary reports (`./version.ts`, one cached `--version` run per binary): `./agent-builder-v1.ts` (OpenCode 1, byte-identical to the
 * pre-OpenCode-2 builder) and `./agent-builder-v2.ts` (OpenCode 2, adds
 * `--standalone` so no background service is started or left running).
 */

import type { AgentCommandBuilder } from "../../agent/builder-shared";
import { createAgentRequestLowerer } from "../../agent/request-lowering";
import { buildOpencodeV1Command } from "./agent-builder-v1";
import { buildOpencodeV2Command } from "./agent-builder-v2";
import { MODEL_WORK_AGENT_INFERENCE } from "./model-config";
import { detectOpencodeMajor } from "./version";

/**
 * OpenCode builder: `opencode run [--standalone] [--agent <name>] [--model <m>] -- "<prompt>"`
 * (`--standalone` on OpenCode 2 only).
 *
 * `opencode run` has no system-prompt option (1.18.25 prints its usage and
 * exits 1 on `--system-prompt`), so the shared lowerer composes a persona
 * into the prompt.
 *
 * Tool policy is omitted: opencode manages tool access through its own agent
 * config files, not via CLI flags. The one exception is the model-work tool
 * policy: the builder injects its confined agent through
 * `OPENCODE_CONFIG_CONTENT` and selects it with `--agent`. That command is
 * akm's own: the engine's `args` are left out, because one such as `--attach`
 * or `--dir` would move the run out of the injected config or the scratch
 * working directory. Only the model they name is kept.
 *
 * Model work's agent carries the request's inference options
 * (`./model-config.ts`). Any other dispatch injects nothing and carries none, so
 * the model's own opencode config applies: set inference there.
 */
export const opencodeBuilder: AgentCommandBuilder = {
  platform: "opencode",
  personaChannel: "prompt",
  lower: createAgentRequestLowerer({
    adapter: "opencode",
    personaChannel: "prompt",
    tools: "none",
    inference: MODEL_WORK_AGENT_INFERENCE,
  }),
  build(profile, req) {
    return detectOpencodeMajor(profile.bin).major === 1
      ? buildOpencodeV1Command(profile, req)
      : buildOpencodeV2Command(profile, req);
  },
};
