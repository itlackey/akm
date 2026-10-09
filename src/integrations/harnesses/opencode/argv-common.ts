// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * What the OpenCode 1 and OpenCode 2 argv adapters share: how an ordinary
 * (non-model-work) dispatch merges the engine's `args` with the request's
 * `--agent` and `--model`. Both majors spell these flags the same way; the
 * adapters differ only in what they add around them.
 */

import { type AgentDispatchRequest, resolveDispatchModel } from "../../agent/builder-shared";
import type { AgentProfile } from "../../agent/profiles";

/**
 * The flags before the `--` separator: the engine's `args` (without any
 * `--model` when the request names one), then `--agent` and `--model`.
 */
export function ordinaryOpencodeFlags(profile: AgentProfile, req: AgentDispatchRequest): string[] {
  const args: string[] = req.model ? [] : [...profile.args];
  if (req.model) {
    for (let index = 0; index < profile.args.length; index += 1) {
      const arg = profile.args[index];
      if (arg === undefined) continue;
      if (arg === "--model") {
        index += 1;
      } else if (!arg.startsWith("--model=")) {
        args.push(arg);
      }
    }
  }
  if (req.agent) {
    args.push("--agent", req.agent);
  }
  if (req.model) {
    args.push("--model", resolveDispatchModel(req, profile, "opencode") as string);
  }
  return args;
}
