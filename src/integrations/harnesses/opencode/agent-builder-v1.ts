// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * OpenCode 1 argv adapter (`opencode-ai` 1.x). Selected when
 * the engine's binary reports OpenCode 1.
 *
 * `opencode run` 1.x runs in-process (it starts its own server for the run),
 * so no service flag is needed. Command shape:
 * `opencode run [--agent <name>] [--model <m>] -- "<prompt>"`.
 *
 * The model-work form injects the confined agent through
 * `OPENCODE_CONFIG_CONTENT` and selects it with `--agent`; the engine's `args`
 * are left out (one such as `--attach` or `--dir` would move the run out of the
 * injected config or the scratch working directory). Only the model they name
 * is kept. The output is the CLI's default text format.
 */

import { type AgentDispatchRequest, type BuiltCommand, modelFromArgs } from "../../agent/builder-shared";
import type { AgentProfile } from "../../agent/profiles";
import { ordinaryOpencodeFlags } from "./argv-common";
import { opencodeInferenceConfig } from "./model-config";
import { MODEL_WORK_OPENCODE_AGENT, modelWorkOpencodeConfig, modelWorkPluginEnv } from "./model-work-agent";

export function buildOpencodeV1Command(profile: AgentProfile, req: AgentDispatchRequest): BuiltCommand {
  if (req.modelWork) {
    const model = req.model ?? modelFromArgs(profile.args);
    const { agentOptions } = opencodeInferenceConfig(req.inference, true);
    return {
      argv: [
        profile.bin,
        "run",
        "--agent",
        MODEL_WORK_OPENCODE_AGENT,
        ...(model ? ["--model", model] : []),
        "--",
        req.prompt,
      ],
      env: {
        ...modelWorkPluginEnv(),
        OPENCODE_CONFIG_CONTENT: JSON.stringify(modelWorkOpencodeConfig(agentOptions)),
      },
    };
  }
  return { argv: [profile.bin, ...ordinaryOpencodeFlags(profile, req), "--", req.prompt] };
}
