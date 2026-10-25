// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * GitHub Copilot CLI (`copilot`), the local headless CLI and not the cloud coding
 * agent. `-p` runs one prompt; `--allow-all-tools` is what lets it run without
 * asking for approval at each tool.
 */

import {
  type AgentDispatchRequest,
  type AkmHarness,
  type BuiltCommand,
  type HarnessSpawn,
  withoutModelFlag,
} from "../harness";

export class CopilotHarness implements AkmHarness {
  readonly id = "copilot" as const;
  readonly displayName = "GitHub Copilot CLI";
  readonly profile = {
    bin: "copilot",
    args: [],
    envPassthrough: ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"],
  };
  readonly systemPrompt = false;
  readonly nativeAgent = false;
  readonly confinable = false;

  build({ bin, args }: HarnessSpawn, req: AgentDispatchRequest): BuiltCommand {
    const argv = [bin, ...(req.model ? withoutModelFlag(args) : args)];
    if (req.model) argv.push("--model", req.model);
    if (req.prompt !== undefined) argv.push("--allow-all-tools", "-p", req.prompt);
    return { argv };
  }
}
