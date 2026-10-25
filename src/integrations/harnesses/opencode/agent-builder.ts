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
import {
  type AgentDispatchRequest,
  type BuiltCommand,
  type HarnessBuilder,
  type HarnessSpawn,
  withoutLeading,
  withoutModelFlag,
} from "../harness";

function flags(profile: HarnessSpawn, req: AgentDispatchRequest): string[] {
  // An interactive launch is the TUI, which `run` (headless) is not.
  const args = req.prompt === undefined ? withoutLeading(profile.args, "run") : [...profile.args];
  const out = req.model ? withoutModelFlag(args) : args;
  if (req.agent) out.push("--agent", req.agent);
  if (req.model) out.push("--model", req.model);
  return out;
}

export const opencodeBuilder: HarnessBuilder = {
  build(profile, req): BuiltCommand {
    if (req.modelWork) {
      warnOnce(
        "opencode-1-model-work",
        "OpenCode 1 cannot restrict its tools, so model work on it runs unrestricted, in a scratch directory. OpenCode 2 runs it read-only.",
      );
    }
    return { argv: [profile.bin, ...flags(profile, req)], ...(req.prompt !== undefined ? { stdin: req.prompt } : {}) };
  },
};
