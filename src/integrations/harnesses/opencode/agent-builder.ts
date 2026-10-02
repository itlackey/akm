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

import { isModelWorkTools } from "../../../execution/source";
import { type AgentCommandBuilder, modelFromArgs, resolveDispatchModel } from "../../agent/builder-shared";
import { createAgentRequestLowerer } from "../../agent/request-lowering";
import { opencodeCarriedKeys, opencodeInferenceConfig, opencodeModelConfig, splitOpencodeModel } from "./model-config";
import { MODEL_WORK_OPENCODE_AGENT, modelWorkOpencodeConfig } from "./model-work-agent";

/**
 * OpenCode builder.
 * Command shape: opencode run [--agent <name>] [--model <m>] -- "<prompt>"
 *
 * `opencode run` has no system-prompt option (1.18.25 prints its usage and
 * exits 1 on `--system-prompt`), so the shared lowerer composes a persona
 * into the prompt.
 *
 * Tool policy is omitted — opencode manages tool access through its own agent
 * config files, not via CLI flags. The one exception is the model-work tool
 * policy: the builder injects its confined agent through
 * `OPENCODE_CONFIG_CONTENT` and selects it with `--agent`. That command is
 * akm's own (`opencode run --agent akm-model-work`): the engine's `args` are
 * left out, because one such as `--attach` or `--dir` would move the run out
 * of the injected config or the scratch working directory. Only the model they
 * name is kept.
 *
 * Inference reaches the run the same way (`./model-config.ts`): the model it
 * names gets an entry in the injected config, which merges over the user's own
 * config for that model, and model work's agent carries the options, whether
 * or not a model is named. A dispatch whose request carries no translatable
 * inference injects nothing, so its argv and env are as they were.
 */
export const opencodeBuilder: AgentCommandBuilder = {
  platform: "opencode",
  personaChannel: "prompt",
  lower: createAgentRequestLowerer({
    adapter: "opencode",
    personaChannel: "prompt",
    nativeAgentSelector: true,
    tools: "none",
    modelWorkTools: true,
    inference: (profile, request) => {
      const model = request.model?.resolved ?? modelFromArgs(profile.args);
      return opencodeCarriedKeys(
        model !== undefined && splitOpencodeModel(model) !== undefined,
        request.inference,
        isModelWorkTools(request.tools),
      );
    },
  }),
  build(profile, req) {
    const model = req.model ?? modelFromArgs(profile.args);
    const modelWork = isModelWorkTools(req.tools);
    // What goes on the model needs a `provider/model` to go on; model work's agent options do not.
    const { entry, agentOptions } = opencodeInferenceConfig(req.inference, modelWork);
    const modelConfig = opencodeModelConfig(model, entry);
    if (modelWork) {
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
        env: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...modelWorkOpencodeConfig(agentOptions), ...modelConfig }) },
      };
    }
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
    return {
      argv: [profile.bin, ...args],
      ...(modelConfig ? { env: { OPENCODE_CONFIG_CONTENT: JSON.stringify(modelConfig) } } : {}),
    };
  },
};
