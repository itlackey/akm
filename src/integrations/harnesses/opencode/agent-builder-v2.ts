// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * OpenCode 2 argv adapter (`@opencode/cli` 2.x, checked against 2.0.26). The
 * default; `opencodeVersion: 1` selects the OpenCode 1 adapter instead.
 *
 * Differences from OpenCode 1 that matter here:
 *   - `opencode run` 2.x attaches to a shared BACKGROUND SERVICE by default,
 *     starting it when absent, and that service outlives the run. akm must not
 *     start or leave one behind, so every dispatch passes `--standalone` (a
 *     private server that exits with the run). The one exception is an engine
 *     whose own `args` name `--server`: the operator chose that server.
 *   - A service would also ignore the `OPENCODE_CONFIG_CONTENT` the model-work
 *     agent travels in; standalone reads it.
 *   - `--auto` is never passed: a non-interactive run rejects a permission
 *     request that is not explicitly allowed, as OpenCode 1 does.
 *   - `run` has no `--dir` or `--attach`; the working directory is the spawn's.
 *   - `--model` takes `provider/model#variant`; akm passes the model string
 *     through unchanged.
 * The output is the default text format (non-TTY stdout is the reply text), so
 * no output parser is needed; `--format json` is not requested.
 *
 * The model-work agent definition has the same shape as in OpenCode 1
 * (`agent.<name>` with `mode`, `prompt`, `options`, `permission`, and the same
 * permission names), see `./model-work-agent.ts`.
 */

import { type AgentDispatchRequest, type BuiltCommand, modelFromArgs } from "../../agent/builder-shared";
import type { AgentProfile } from "../../agent/profiles";
import { ordinaryOpencodeFlags } from "./argv-common";
import { opencodeInferenceConfig } from "./model-config";
import { MODEL_WORK_OPENCODE_AGENT, modelWorkOpencodeConfigV2, modelWorkPluginEnv } from "./model-work-agent";

export const OPENCODE_V2_STANDALONE_FLAG = "--standalone";

export function buildOpencodeV2Command(profile: AgentProfile, req: AgentDispatchRequest): BuiltCommand {
  if (req.modelWork) {
    const model = req.model ?? modelFromArgs(profile.args);
    const { agentOptions } = opencodeInferenceConfig(req.inference, true);
    return {
      argv: [
        profile.bin,
        "run",
        OPENCODE_V2_STANDALONE_FLAG,
        "--agent",
        MODEL_WORK_OPENCODE_AGENT,
        ...(model ? ["--model", model] : []),
        "--",
        req.prompt,
      ],
      env: {
        ...modelWorkPluginEnv(),
        OPENCODE_CONFIG_CONTENT: JSON.stringify(modelWorkOpencodeConfigV2(agentOptions)),
      },
    };
  }
  const flags = ordinaryOpencodeFlags(profile, req);
  const hasServer = flags.some((arg) => arg === "--server" || arg.startsWith("--server="));
  const hasStandalone = flags.includes(OPENCODE_V2_STANDALONE_FLAG);
  const standalone = hasServer || hasStandalone ? [] : [OPENCODE_V2_STANDALONE_FLAG];
  return { argv: [profile.bin, ...flags, ...standalone, "--", req.prompt] };
}
