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
 * one thing that depends on the OpenCode major (`./version.ts`, one cached
 * `--version` run per binary) is `--standalone`, added on OpenCode 2 only; the
 * OpenCode 1 argv is byte-identical to the pre-OpenCode-2 builder's.
 */

import {
  type AgentCommandBuilder,
  type AgentDispatchRequest,
  type BuiltCommand,
  modelFromArgs,
  resolveDispatchModel,
} from "../../agent/builder-shared";
import type { AgentProfile } from "../../agent/profiles";
import { createAgentRequestLowerer } from "../../agent/request-lowering";
import { MODEL_WORK_AGENT_INFERENCE, opencodeInferenceConfig } from "./model-config";
import { MODEL_WORK_OPENCODE_AGENT, modelWorkOpencodeConfig, modelWorkPluginEnv } from "./model-work-agent";
import { detectOpencodeMajor } from "./version";

/**
 * OpenCode 2's `run` attaches to a shared background service by default,
 * starting it when absent and leaving it running after the run; `--standalone`
 * runs a private server that exits with the run (and reads the
 * `OPENCODE_CONFIG_CONTENT` model work travels in, which the service ignores).
 * OpenCode 1 has no such flag. An engine whose own `args` name `--server`
 * chose that server, so it gets no `--standalone`. `--auto` is never passed:
 * a non-interactive run rejects a permission request, on both majors.
 */
const STANDALONE_FLAG = "--standalone";

/**
 * How the prompt reaches `run`. OpenCode 2 sends a positional prompt twice when
 * it follows `--` (cli/src/commands/handlers/run.ts appends the args after `--`
 * to the message it already parsed) and quotes any argument with a space in it
 * (run/run.ts `formatMessage`), so on major 2 the prompt goes on stdin, which
 * `run` reads verbatim. OpenCode 1 takes it after `--`.
 */
function withPrompt(major: 1 | 2, argv: string[], prompt: string): Pick<BuiltCommand, "argv" | "stdin"> {
  return major === 2 ? { argv, stdin: prompt } : { argv: [...argv, "--", prompt] };
}

function standalone(major: 1 | 2, flags: readonly string[]): string[] {
  if (major !== 2) return [];
  const chosen = flags.some((arg) => arg === STANDALONE_FLAG || arg === "--server" || arg.startsWith("--server="));
  return chosen ? [] : [STANDALONE_FLAG];
}

/**
 * The flags before the `--` separator of an ordinary dispatch: the engine's
 * `args` (without any `--model` when the request names one), then `--agent`
 * and `--model`. Both majors spell these the same way.
 */
function ordinaryFlags(profile: AgentProfile, req: AgentDispatchRequest): string[] {
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
    args.push("--model", resolveDispatchModel(req, profile, "opencode") as string);
  }
  return args;
}

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
  build(profile, req): BuiltCommand {
    const major = detectOpencodeMajor(profile.bin).major;
    if (req.modelWork) {
      const model = req.model ?? modelFromArgs(profile.args);
      const { agentOptions } = opencodeInferenceConfig(req.inference, true);
      return {
        ...withPrompt(
          major,
          [
            profile.bin,
            "run",
            ...standalone(major, []),
            "--agent",
            MODEL_WORK_OPENCODE_AGENT,
            ...(model ? ["--model", model] : []),
          ],
          req.prompt,
        ),
        env: {
          ...modelWorkPluginEnv(),
          OPENCODE_CONFIG_CONTENT: JSON.stringify(modelWorkOpencodeConfig(agentOptions)),
        },
      };
    }
    const flags = ordinaryFlags(profile, req);
    return withPrompt(major, [profile.bin, ...flags, ...standalone(major, flags)], req.prompt);
  },
};
