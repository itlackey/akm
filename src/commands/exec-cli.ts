// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { getParsedInvocation } from "../cli/invocation";
import { defineJsonCommand } from "../cli/shared";
import { loadConfig } from "../core/config/config";
import { EXEC_CONFIG_KEY, isExecEnabled } from "../core/config/experimental";
import { ConfigError, UsageError } from "../core/errors";
import { buildChildEnv } from "./env/child-env";
import { INJECTION_ARGS, resolveInjections, runChild } from "./env/injection";

/** `akm exec`: any program, with env assets and secrets injected. Experimental and off by default. `akm run` is the same for an akm asset. */
export const execCommand = defineJsonCommand({
  meta: {
    name: "exec",
    description:
      "Experimental, off until `experimental.exec` is true in config. Run any command with env assets and secrets injected into its environment: `akm exec [--env <ref>]... [--secret <ref>:<VAR>]... -- <command>`. Use `-- $SHELL` for an interactive session. The command's own output is not scrubbed. Pass --clean to start it with a minimal inherited environment. To run an akm asset, use `akm run <ref>`.",
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
      description: "With --clean, also inherit these parent env vars (comma-separated)",
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
    const env = buildChildEnv(process.env, {
      clean: args.clean === true,
      inherit: (args.inherit ?? "").split(/[,\s]+/).filter(Boolean),
    });
    Object.assign(env, resolveInjections().values);
    runChild(command, env);
  },
});
