// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { getParsedInvocation } from "../cli/invocation";
import { getStringArg, parsePositiveIntFlag, parseTimeoutValue } from "../cli/parse-args";
import { SELECTION_ARGS, selectionFromArgs } from "../cli/selection";
import { defineJsonCommand } from "../cli/shared";
import { loadConfig } from "../core/config/config";
import { EXEC_CONFIG_KEY, isExecEnabled } from "../core/config/experimental";
import { ConfigError, UsageError } from "../core/errors";
import { withRetries } from "../execution/retry";
import { shellCommand } from "../tasks/run/run-native-task";
import { akmAgentDispatch } from "./agent/agent-dispatch";
import { readPromptStdin } from "./agent/contribute-cli";
import { buildChildEnv } from "./env/child-env";
import { INJECTION_ARGS, resolveInjections, runProgram } from "./env/injection";

function definedEntries(env: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

/** `akm exec`: any program, with env assets and secrets injected. Experimental and off by default. `akm run` is the same for an akm asset. */
export const execCommand = defineJsonCommand({
  meta: {
    name: "exec",
    description:
      'Experimental, off until `experimental.exec` is true in config. Run any command with env assets and secrets injected into its environment: `akm exec [--env <ref>]... [--secret <ref>:<VAR>]... -- <command>`. Use `-- $SHELL` for an interactive session. `--prompt <text>` (or `--prompt-stdin`) instead runs a prompt on the default agent, or on `--harness`, `--connection` and `--model`, and prints its reply. One argument is a shell line (`-- "a | b"`); several are a program and its arguments, unsplit. The command\'s own output is not scrubbed. Pass --clean to start it with a minimal inherited environment, or --inherit <VAR,...> for that plus the named variables. To run an akm asset, use `akm run <ref>`.',
  },
  args: {
    ...INJECTION_ARGS,
    prompt: {
      type: "string",
      description: "Run this prompt on an agent instead of a command; its reply is the output",
    },
    "prompt-stdin": {
      type: "boolean",
      description: "Read the prompt from stdin (mutually exclusive with --prompt and a command)",
      default: false,
    },
    ...SELECTION_ARGS,
    clean: {
      type: "boolean",
      description: "Start the child with a minimal inherited environment",
      default: false,
    },
    inherit: {
      type: "string",
      description: "Start the child clean plus these parent env vars (comma-separated); implies --clean",
    },
    cwd: {
      type: "string",
      description: "Run in this folder, made if missing; relative to the folder akm was started in",
    },
    timeout: {
      type: "string",
      description: "Kill the command after this long: 30s, 2m, 1h; bare N is milliseconds",
    },
    "max-retries": {
      type: "string",
      description: "Run again up to N times when the command fails or times out; each try gets the whole --timeout",
    },
  },
  async run({ args }) {
    if (!isExecEnabled(loadConfig())) {
      throw new ConfigError(
        `akm exec is Experimental and is off. Set ${EXEC_CONFIG_KEY} to true to use it.`,
        "INVALID_CONFIG_FILE",
        `Run \`akm config set ${EXEC_CONFIG_KEY} true\`. To run an akm asset with env assets and secrets injected, use \`akm run <ref> --env <ref> --secret <ref>:<VAR>\`.`,
      );
    }
    const command = getParsedInvocation().passthroughArgs();
    const promptText = getStringArg(args, "prompt");
    const promptStdin = args["prompt-stdin"] === true;
    if (promptText !== undefined && promptStdin) {
      throw new UsageError("--prompt-stdin cannot be combined with --prompt.", "INVALID_FLAG_VALUE");
    }
    const hasPrompt = promptText !== undefined || promptStdin;
    if (hasPrompt && command.length > 0) {
      throw new UsageError(
        "--prompt and --prompt-stdin cannot be combined with a command after --.",
        "INVALID_FLAG_VALUE",
      );
    }
    if (!hasPrompt && command.length === 0) {
      throw new UsageError(
        "Missing command. Usage: akm exec [--env <ref>]... [--secret <ref>:<VAR>]... -- <command>, or akm exec --prompt <text>",
      );
    }
    const inherit = (args.inherit ?? "").split(/[,\s]+/).filter(Boolean);
    const clean = args.clean === true || args.inherit !== undefined;
    const env = buildChildEnv(process.env, { clean, inherit });
    const injected = resolveInjections().values;
    Object.assign(env, injected);
    const timeoutMs = args.timeout === undefined ? undefined : parseTimeoutValue(args.timeout);
    const maxRetries = parsePositiveIntFlag(args["max-retries"], "--max-retries") ?? 0;
    if (hasPrompt) {
      const prompt = promptText ?? readPromptStdin();
      const selection = selectionFromArgs(args);
      const result = await withRetries(
        maxRetries,
        () =>
          akmAgentDispatch({
            prompt,
            agentConfig: loadConfig(),
            env: injected,
            ...(clean ? { baseEnv: definedEntries(env) } : {}),
            ...(Object.keys(selection).length === 0 ? {} : { selection }),
            ...(args.cwd !== undefined ? { cwd: args.cwd } : {}),
            ...(timeoutMs !== undefined ? { timeoutMs } : {}),
          }),
        (r) => !r.ok && r.reason !== "aborted" && r.reason !== "spawn_failed",
      );
      if (!result.ok) {
        console.error(
          result.reason === "timeout"
            ? `akm exec: timed out after ${args.timeout}`
            : `akm exec: ${result.error ?? "the agent failed"}`,
        );
        process.exitCode = 1;
        return;
      }
      process.stdout.write(result.stdout);
      return;
    }
    const argv =
      command.length === 1
        ? shellCommand({ command: command[0] as string, shell: process.platform === "win32" ? "cmd" : "sh" })
        : command;
    const result = await runProgram({
      argv,
      env,
      capture: false,
      maxRetries,
      ...(args.cwd !== undefined ? { cwd: args.cwd } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });
    if (result.timedOut) {
      console.error(`akm exec: timed out after ${args.timeout}`);
      process.exitCode = 1;
      return;
    }
    // Not `process.exit`: the CLI's own cleanup still runs before the process ends with the child's status.
    process.exitCode = result.exitCode ?? 1;
  },
});
