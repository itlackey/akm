// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * OpenCode 1 command builder: the legacy `opencode run` CLI harness, treated
 * like the Claude and Codex CLIs (#1244). OpenCode 2 runs embedded in akm, with
 * no harness of its own, so an OpenCode 2 binary is refused here.
 *
 * The prompt goes on stdin: `opencode run` wraps an argv prompt in quotes and
 * escapes its inner quotes, which changes what the model reads; stdin is read
 * verbatim, and a prompt that starts with `-` is not taken for a flag.
 *
 * No tool restriction: a `permissions:` grant runs with OpenCode 1's defaults
 * and a one-line warning.
 */

import type { AgentCommandBuilder, AgentDispatchRequest, BuiltCommand } from "../../agent/builder-shared";
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
  if (req.model) args.push("--model", req.model);
  return args;
}

export const opencodeBuilder: AgentCommandBuilder = {
  platform: "opencode",
  personaChannel: "prompt",
  lower: createAgentRequestLowerer({ adapter: "opencode", personaChannel: "prompt" }),
  build(profile, req): BuiltCommand {
    // Refuse only a binary that reports OpenCode 2 or later; one whose version cannot be read is run as given.
    const { reportedMajor, version } = detectOpencodeMajor(profile.bin);
    if (reportedMajor !== undefined && reportedMajor >= 2) {
      throw new Error(
        `${profile.bin} reports ${version}. The opencode harness runs OpenCode 1 only; OpenCode 2 runs embedded in akm, with no harness of its own.`,
      );
    }
    return { argv: [profile.bin, ...flags(profile, req)], stdin: req.prompt };
  },
};
