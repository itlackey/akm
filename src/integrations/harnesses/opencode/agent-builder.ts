// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * OpenCode 1 command builder: the legacy `opencode run` CLI harness, treated
 * like the Claude and Codex CLIs (#1244). OpenCode 2 runs embedded through the
 * `opencode-sdk` engine, so an OpenCode 2 binary is refused here.
 *
 * The prompt goes on stdin: `opencode run` wraps an argv prompt in quotes and
 * escapes its inner quotes, which changes what the model reads; stdin is read
 * verbatim, and a prompt that starts with `-` is not taken for a flag.
 *
 * No model work, and no tool restriction: a `permissions:` grant runs with
 * OpenCode 1's defaults and a one-line warning.
 */

import {
  type AgentCommandBuilder,
  type AgentDispatchRequest,
  type BuiltCommand,
  resolveDispatchModel,
} from "../../agent/builder-shared";
import type { AgentProfile } from "../../agent/profiles";
import { createAgentRequestLowerer } from "../../agent/request-lowering";
import { detectOpencodeMajor } from "./version";

function flags(profile: AgentProfile, req: AgentDispatchRequest): string[] {
  const args: string[] = [];
  for (let index = 0; index < profile.args.length; index += 1) {
    const arg = profile.args[index];
    if (arg === undefined) continue;
    if (req.model && arg === "--model") index += 1;
    else if (!(req.model && arg.startsWith("--model="))) args.push(arg);
  }
  if (req.agent) args.push("--agent", req.agent);
  if (req.model) args.push("--model", resolveDispatchModel(req, profile, "opencode") as string);
  return args;
}

export const opencodeBuilder: AgentCommandBuilder = {
  platform: "opencode",
  personaChannel: "prompt",
  lower: createAgentRequestLowerer({ adapter: "opencode", personaChannel: "prompt", tools: "none" }),
  build(profile, req): BuiltCommand {
    const { major, version } = detectOpencodeMajor(profile.bin);
    if (major === 2) {
      throw new Error(
        `${profile.bin} is OpenCode ${version || "2"}. The opencode harness runs OpenCode 1 only; OpenCode 2 runs embedded through an engine with platform "opencode-sdk".`,
      );
    }
    return { argv: [profile.bin, ...flags(profile, req)], stdin: req.prompt };
  },
};
