// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Pi coding-agent CLI (`pi`). `-p` is its print mode, and it reads the message from
 * piped stdin: as an argument a prompt that starts with `-`, `--` or `@` is taken as an
 * option or a file include. The persona is appended to pi's own system prompt, which
 * is the one that explains pi's tools.
 */

import {
  type AgentDispatchRequest,
  type AkmHarness,
  type BuiltCommand,
  type HarnessSpawn,
  withoutModelFlag,
} from "../harness";

export class PiHarness implements AkmHarness {
  readonly id = "pi" as const;
  readonly displayName = "Pi";
  readonly profile = { bin: "pi", args: [] };
  readonly systemPrompt = true;
  readonly nativeAgent = false;
  readonly confinable = false;

  build({ bin, args }: HarnessSpawn, req: AgentDispatchRequest): BuiltCommand {
    const argv = [bin, ...(req.model ? withoutModelFlag(args) : args)];
    if (req.systemPrompt) argv.push("--append-system-prompt", req.systemPrompt);
    if (req.model) argv.push("--model", req.model);
    if (req.prompt === undefined) return { argv };
    argv.push("-p");
    return { argv, stdin: req.prompt };
  }
}
