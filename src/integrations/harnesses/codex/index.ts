// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * OpenAI Codex CLI (`codex`). Headless is the `exec` subcommand, which prints the
 * final message on stdout and its progress on stderr. Agent work runs with the
 * sandbox the user's Codex configuration sets (or the `--sandbox` their `args`
 * name); model work gets `read-only` whatever the config says.
 * `--skip-git-repo-check` lets it run outside a git repository.
 */

import type { SessionLogHarness } from "../../session-logs/types";
import {
  type AgentDispatchRequest,
  type AkmHarness,
  type BuiltCommand,
  type HarnessSpawn,
  modelFromArgs,
  withoutLeading,
  withoutModelFlag,
} from "../harness";
import { CodexProvider } from "./session-log";

export { CodexProvider } from "./session-log";

export class CodexHarness implements AkmHarness {
  readonly id = "codex" as const;
  readonly displayName = "OpenAI Codex CLI";
  // No `setupDetectionDir`: `~/.codex` holds credentials and session rollouts,
  // not assets, so `akm setup` must not offer it as a stash source.
  readonly profile = { bin: "codex", args: [] };
  // CODEX_SANDBOX is stamped only on processes codex itself spawns inside its sandbox, so it
  // means "running under codex"; its value (e.g. "seatbelt") is a sandbox mode, not a session id.
  readonly presenceEnv = ["CODEX_SANDBOX"] as const;
  readonly sessionLogProvider = (): SessionLogHarness => new CodexProvider();
  readonly systemPrompt = false;
  readonly nativeAgent = false;
  readonly confinable = true;

  build({ bin, args }: HarnessSpawn, req: AgentDispatchRequest): BuiltCommand {
    const authored = withoutLeading(args, "exec");
    // Model work drops the config's args (a `--sandbox` among them would widen the policy), keeping the model they name.
    const extra = req.modelWork ? [] : req.model ? withoutModelFlag(authored) : authored;
    const model = req.model ?? (req.modelWork ? modelFromArgs(authored) : undefined);
    const modelFlag = model ? ["--model", model] : [];
    if (req.prompt === undefined) return { argv: [bin, ...extra, ...modelFlag] };
    const sandbox = req.modelWork ? ["--sandbox", "read-only"] : [];
    return { argv: [bin, "exec", ...extra, ...sandbox, "--skip-git-repo-check", ...modelFlag, "--", req.prompt] };
  }
}
