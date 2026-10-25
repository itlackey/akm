// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Pi coding-agent CLI (`pi`). `-p` is its print mode; the prompt follows it as the
 * message. No `--` separator: after one, pi does not take the message.
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
  readonly profile = { bin: "pi", args: [], envPassthrough: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"] };
  readonly systemPrompt = true;
  readonly nativeAgent = false;
  readonly confinable = false;

  build({ bin, args }: HarnessSpawn, req: AgentDispatchRequest): BuiltCommand {
    const argv = [bin, ...(req.model ? withoutModelFlag(args) : args)];
    if (req.systemPrompt) argv.push("--system-prompt", req.systemPrompt);
    if (req.model) argv.push("--model", req.model);
    if (req.prompt !== undefined) argv.push("-p", req.prompt);
    return { argv };
  }
}
