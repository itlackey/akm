// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * OpenHands CLI (`openhands`). `--headless --task` runs one task. Like aider the
 * task is a flag value, glued on with `=` so a task that starts with `-` is not
 * read as an option. The CLI takes its model from `LLM_MODEL`, not a flag.
 */

import type { AgentDispatchRequest, AkmHarness, BuiltCommand, HarnessSpawn } from "../harness";

/** The environment variable OpenHands reads its model from. */
const MODEL_ENV = "LLM_MODEL";

export class OpenhandsHarness implements AkmHarness {
  readonly id = "openhands" as const;
  readonly displayName = "OpenHands";
  readonly profile = { bin: "openhands", args: [] };
  readonly systemPrompt = false;
  readonly nativeAgent = false;
  readonly confinable = false;

  build({ bin, args }: HarnessSpawn, req: AgentDispatchRequest): BuiltCommand {
    const argv = [bin, ...args];
    if (req.prompt !== undefined) argv.push("--headless", `--task=${req.prompt}`);
    return { argv, ...(req.model ? { env: { [MODEL_ENV]: req.model } } : {}) };
  }
}
