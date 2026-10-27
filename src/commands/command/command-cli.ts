// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { getStringArg, parsePositiveIntFlag } from "../../cli/parse-args";
import { RETIRED_ENGINE_ARG, SELECTION_ARGS, selectionFromArgs } from "../../cli/selection";
import { defineGroupCommand, defineJsonCommand, EXIT_CODES, output } from "../../cli/shared";
import { loadConfig } from "../../core/config/config";
import { isVerbose, setVerbose, warn, warnVerbose } from "../../core/warn";
import type { UnresolvedExecutionDefaults } from "../../execution/source";
import { lookupBundleRefReadonly } from "../../indexer/indexer";
import {
  dispatchPreparedCommandInvocation,
  inspectPreparedCommandInvocation,
  prepareCommandInvocation,
} from "./command-execution";

function exactStringArg(args: unknown, key: string): string | undefined {
  const value = (args as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

export const commandRunCommand = defineJsonCommand({
  meta: {
    name: "run",
    description:
      "Resolve a stored command through its bundle adapter, apply portable arguments, and execute one fresh session",
  },
  args: {
    ref: {
      type: "positional",
      description: "Command asset ref (for example commands/review or team//commands/review)",
      required: true,
    },
    arguments: {
      type: "string",
      description: "Exact string substituted for each literal $ARGUMENTS occurrence (no tokenization or trimming)",
    },
    agent: {
      type: "string",
      description: "Override the command's agent selector with a portable agent ref or native harness selector",
    },
    ...SELECTION_ARGS,
    ...RETIRED_ENGINE_ARG,
    "timeout-ms": { type: "string", description: "Override the execution timeout in milliseconds" },
    cwd: { type: "string", description: "Override the execution workspace/current working directory" },
    "dry-run": {
      type: "boolean",
      default: false,
      description: "Authorize and lower the command, then print safe diagnostics without dispatching or writing state",
    },
  },
  async run({ args }) {
    if (args.verbose === true) setVerbose(true);
    const timeoutMs = parsePositiveIntFlag(exactStringArg(args, "timeout-ms"), "--timeout-ms");
    const current: Record<string, unknown> = {};
    const agent = getStringArg(args, "agent");
    const workspace = getStringArg(args, "cwd");
    if (agent !== undefined) current.agent = agent;
    Object.assign(current, selectionFromArgs(args));
    if (timeoutMs !== undefined) current.timeout = timeoutMs;
    if (workspace !== undefined) current.workspace = workspace;

    const argumentInput = exactStringArg(args, "arguments");
    const dryRun = args["dry-run"] === true;
    const prepared = await prepareCommandInvocation({
      action: {
        ref: args.ref,
        ...(argumentInput === undefined ? {} : { arguments: argumentInput }),
      },
      config: loadConfig(),
      current: current as UnresolvedExecutionDefaults,
      ...(dryRun ? { sourceLookup: lookupBundleRefReadonly } : {}),
    });
    const diagnostics = dryRun || isVerbose() ? inspectPreparedCommandInvocation(prepared) : undefined;
    if (dryRun) {
      output("command-dry-run", diagnostics);
      return;
    }
    if (diagnostics) {
      warnVerbose(
        `[akm:command] diagnostics ${JSON.stringify({
          engine: diagnostics.engine,
          provenance: diagnostics.provenance,
          notices: diagnostics.notices,
        })}`,
      );
    }
    const result = await dispatchPreparedCommandInvocation(prepared);
    for (const message of result.warnings ?? []) warn(message);
    output("agent-result", result);
    if (!result.ok) process.exitCode = EXIT_CODES.GENERAL;
  },
});

export const commandCommand = defineGroupCommand({
  meta: {
    name: "command",
    description: "Run reusable agent prompt templates through AKM's common execution resolver",
  },
  subCommands: { run: commandRunCommand },
});
