// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * OpenCode 1 command builder: the `opencode run` CLI transport of the opencode
 * harness (#1244), treated like the Claude and Codex CLIs. OpenCode 2 runs
 * embedded (`./embedded/`); which of the two a request uses is decided at
 * dispatch (`./index.ts`), so this builder only ever builds OpenCode 1's argv.
 *
 * The prompt goes on stdin: `opencode run` wraps an argv prompt in quotes and
 * escapes its inner quotes, which changes what the model reads; stdin is read
 * verbatim, and a prompt that starts with `-` is not taken for a flag.
 *
 * No tool restriction: model work on OpenCode 1 runs with its defaults, with a
 * one-line warning.
 */

import { warnOnce } from "../../../core/warn";
import type { AgentCommandBuilder, AgentDispatchRequest, BuiltCommand } from "../../agent/builder-shared";
import type { AgentProfile } from "../../agent/profiles";
import { createAgentRequestLowerer } from "../../agent/request-lowering";

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
    if (req.modelWork) {
      warnOnce(
        "opencode-1-model-work",
        "OpenCode 1 cannot restrict its tools, so model work on it runs unrestricted, in a scratch directory. OpenCode 2 runs it read-only.",
      );
    }
    return { argv: [profile.bin, ...flags(profile, req)], stdin: req.prompt };
  },
};
