// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Aider (`aider`). `--message` is its one-shot mode, `--yes-always` confirms every
 * prompt so an unattended run does not stop, and `--no-pretty` keeps ANSI
 * rendering out of the captured reply. The message is a flag value, with no
 * positional prompt and no `--` to hide behind, so it is glued on with `=`: a
 * prompt that starts with `-` then binds to the flag and is never read as an option.
 */

import {
  type AgentDispatchRequest,
  type AkmHarness,
  type BuiltCommand,
  type HarnessSpawn,
  withoutModelFlag,
} from "../harness";

export class AiderHarness implements AkmHarness {
  readonly id = "aider" as const;
  readonly displayName = "Aider";
  readonly profile = {
    bin: "aider",
    args: ["--no-auto-commits"],
    envPassthrough: ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"],
  };
  readonly systemPrompt = false;
  readonly nativeAgent = false;
  readonly confinable = false;

  build({ bin, args }: HarnessSpawn, req: AgentDispatchRequest): BuiltCommand {
    const argv = [bin, ...(req.model ? withoutModelFlag(args) : args)];
    if (req.model) argv.push("--model", req.model);
    if (req.prompt !== undefined) argv.push("--yes-always", "--no-pretty", `--message=${req.prompt}`);
    return { argv };
  }
}
