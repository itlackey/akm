// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Amazon Q Developer CLI (`q`). Headless is `q chat --no-interactive`, which
 * prints the reply and exits; `--trust-all-tools` stops it asking before each
 * tool. The prompt is the trailing positional, after `--`.
 */

import {
  type AgentDispatchRequest,
  type AkmHarness,
  type BuiltCommand,
  type HarnessSpawn,
  withoutLeading,
  withoutModelFlag,
} from "../harness";

export class AmazonqHarness implements AkmHarness {
  readonly id = "amazonq" as const;
  readonly displayName = "Amazon Q Developer CLI";
  readonly profile = { bin: "q", args: [], envPassthrough: ["AWS_PROFILE", "AWS_REGION"] };
  readonly systemPrompt = false;
  readonly nativeAgent = false;
  readonly confinable = false;

  build({ bin, args }: HarnessSpawn, req: AgentDispatchRequest): BuiltCommand {
    const authored = withoutLeading(args, "chat");
    const base = [bin, "chat", ...(req.model ? withoutModelFlag(authored) : authored)];
    const model = req.model ? ["--model", req.model] : [];
    if (req.prompt === undefined) return { argv: [...base, ...model] };
    return { argv: [...base, "--no-interactive", "--trust-all-tools", ...model, "--", req.prompt] };
  }
}
