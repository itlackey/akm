// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { getParsedInvocation } from "../cli/invocation";
import { parsePositiveIntFlag, parseTimeoutValue } from "../cli/parse-args";
import { defineJsonCommand } from "../cli/shared";
import { loadConfig } from "../core/config/config";
import { EXEC_CONFIG_KEY, isExecEnabled } from "../core/config/experimental";
import { ConfigError, UsageError } from "../core/errors";
import { shellCommand } from "../tasks/run/run-native-task";
import { buildChildEnv } from "./env/child-env";
import { INJECTION_ARGS, resolveInjections, runProgram } from "./env/injection";

/** `akm exec`: any program, with env assets and secrets injected. Experimental and off by default. `akm run` is the same for an akm asset. */
export const execCommand = defineJsonCommand({
  meta: {
    name: "exec",
    description:
      'Experimental, off until `experimental.exec` is true in config. Run any command with env assets and secrets injected into its environment: `akm exec [--env <ref>]... [--secret <ref>:<VAR>]... -- <command>`. Use `-- $SHELL` for an interactive session. One argument is a shell line (`-- "a | b"`); several are a program and its arguments, unsplit. The command\'s own output is not scrubbed. Pass --clean to start it with a minimal inherited environment, or --inherit <VAR,...> for that plus the named variables. To run an akm asset, use `akm run <ref>`.',
  },
  args: {
    ...INJECTION_ARGS,
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
    if (command.length === 0) {
      throw new UsageError("Missing command. Usage: akm exec [--env <ref>]... [--secret <ref>:<VAR>]... -- <command>");
    }
    const inherit = (args.inherit ?? "").split(/[,\s]+/).filter(Boolean);
    const env = buildChildEnv(process.env, { clean: args.clean === true || args.inherit !== undefined, inherit });
    Object.assign(env, resolveInjections().values);
    const timeoutMs = args.timeout === undefined ? undefined : parseTimeoutValue(args.timeout);
    const maxRetries = parsePositiveIntFlag(args["max-retries"], "--max-retries") ?? 0;
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
      process.exitCode = 124;
      return;
    }
    // Not `process.exit`: the CLI's own cleanup still runs before the process ends with the child's status.
    process.exitCode = result.exitCode ?? 1;
  },
});
