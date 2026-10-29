// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Gemini CLI (`gemini`). `-p` runs one prompt headless. Autonomy flags
 * (`--yolo`, `--approval-mode`) belong in the config's `args`, where the user opts in.
 */

import {
  type AgentDispatchRequest,
  type AkmHarness,
  type BuiltCommand,
  type HarnessSpawn,
  withoutModelFlag,
} from "../harness";

export class GeminiHarness implements AkmHarness {
  readonly id = "gemini" as const;
  readonly displayName = "Gemini CLI";
  readonly profile = { bin: "gemini", args: [] };
  // GEMINI_CLI=1 is stamped only on processes Gemini CLI spawns, so it means "running under
  // gemini"; its value is a bare flag, not a session id.
  readonly presenceEnv = ["GEMINI_CLI"] as const;
  readonly systemPrompt = false;
  readonly nativeAgent = false;
  readonly confinable = false;

  build({ bin, args }: HarnessSpawn, req: AgentDispatchRequest): BuiltCommand {
    const argv = [bin, ...(req.model ? withoutModelFlag(args) : args)];
    if (req.model) argv.push("--model", req.model);
    if (req.prompt !== undefined) argv.push("-p", req.prompt);
    return { argv };
  }
}
