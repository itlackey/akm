// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Claude Code (`claude`). `claude -p` prints the reply and exits; with no prompt
 * on the command line it reads the prompt from stdin, so a prompt of any length
 * or shape reaches it unparsed.
 */

import type { SessionLogHarness } from "../../session-logs/types";
import {
  type AgentDispatchRequest,
  type AkmHarness,
  type BuiltCommand,
  type HarnessSpawn,
  modelFromArgs,
  withoutModelFlag,
} from "../harness";
import { ClaudeCodeProvider } from "./session-log";

export { ClaudeCodeProvider } from "./session-log";

/**
 * The model-work tool policy on Claude Code, verified against 2.1.283:
 *   - `--restricted` ignores the user, project and local settings files (whose
 *     allow rules would otherwise pre-approve any command or path) and confines
 *     the file tools to the working directory;
 *   - `--strict-mcp-config` starts no MCP server, and `--tools` offers only Read
 *     and Bash: no Edit;
 *   - `--allowedTools` pre-approves Read and `akm search`, `akm show` and
 *     `akm curate`, and `--permission-mode dontAsk` denies everything else instead
 *     of prompting, including a compound, redirected or substituted command;
 *   - `--no-session-persistence` keeps the run out of Claude Code's transcripts,
 *     which `akm extract` would otherwise harvest as the user's own sessions.
 * The config's `args` are left out of a model-work run, because `--add-dir`,
 * `--settings` or a second `--allowedTools` would widen the policy; only the model
 * they name is kept.
 */
export const MODEL_WORK_CLAUDE_FLAGS: readonly string[] = Object.freeze([
  "--restricted",
  "--strict-mcp-config",
  "--tools",
  "Read,Bash",
  "--allowedTools",
  "Read,Bash(akm search *),Bash(akm show *),Bash(akm curate *)",
  "--permission-mode",
  "dontAsk",
  "--no-session-persistence",
]);

export class ClaudeHarness implements AkmHarness {
  readonly id = "claude" as const;
  readonly displayName = "Claude Code";
  // Home-relative config dir scanned by `akm setup` (#567). Claude Code has a
  // session-log provider, so offering it as a stash source is functional.
  readonly setupDetectionDir = ".claude";
  readonly profile = { bin: "claude", args: [], envPassthrough: ["ANTHROPIC_API_KEY", "CLAUDE_CONFIG_DIR"] };
  readonly models = {
    fast: "claude-haiku-4-5-20251001",
    balanced: "claude-sonnet-4-6",
    reasoning: "claude-opus-4-7",
  };
  // Claude Code exports its session id to the commands it runs. Only a concrete id
  // attributes a run to this harness, not the bare "running under Claude Code" fact.
  readonly identityEnv = ["CLAUDE_CODE_SESSION_ID"] as const;
  readonly sessionLogProvider = (): SessionLogHarness => new ClaudeCodeProvider();
  readonly systemPrompt = true;
  readonly nativeAgent = true;
  readonly confinable = true;

  build({ bin, args }: HarnessSpawn, req: AgentDispatchRequest): BuiltCommand {
    const argv = [bin];
    let model = req.model;
    if (req.modelWork) {
      argv.push(...MODEL_WORK_CLAUDE_FLAGS);
      model ??= modelFromArgs(args);
    } else {
      argv.push(...(model ? withoutModelFlag(args) : args));
    }
    if (req.agent) argv.push("--agent", req.agent);
    if (req.systemPrompt) argv.push("--append-system-prompt", req.systemPrompt);
    if (model) argv.push("--model", model);
    if (req.prompt === undefined) return { argv };
    return { argv: [...argv, "-p"], stdin: req.prompt };
  }
}
