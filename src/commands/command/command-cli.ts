// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { getStringArg, parseTimeoutFlag } from "../../cli/parse-args";
import { SELECTION_ARGS, selectionFromArgs } from "../../cli/selection";
import { defineJsonCommand, EXIT_CODES, output } from "../../cli/shared";
import { loadConfig } from "../../core/config/config";
import { UsageError } from "../../core/errors";
import { isVerbose, setVerbose, warn, warnVerbose } from "../../core/warn";
import type { UnresolvedExecutionDefaults } from "../../execution/source";
import { lookupBundleRefReadonly } from "../../indexer/indexer";
import {
  dispatchPreparedCommandInvocation,
  inspectPreparedCommandInvocation,
  prepareCommandInvocation,
} from "./command-execution";

/** `akm command run <ref>` was the 0.9 and 0.10 spelling, now `akm run <ref>`; a lone `run` is still a command named `run`. */
function rejectRetiredRunSpelling(positionals: unknown): void {
  const tokens = Array.isArray(positionals) ? positionals.map(String) : [];
  if (tokens[0] !== "run" || tokens.length < 2) return;
  throw new UsageError(`\`akm command run <ref>\` was removed: use \`akm run ${tokens[1]}\`.`, "INVALID_FLAG_VALUE");
}

function exactStringArg(args: unknown, key: string): string | undefined {
  const value = (args as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

export const commandCommand = defineJsonCommand({
  meta: {
    name: "command",
    description:
      "Run a stored command: resolve it through its bundle adapter, apply portable arguments, and execute one fresh session",
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
    timeout: { type: "string", description: "Override the execution timeout: a duration (30s, 2m) or milliseconds" },
    cwd: { type: "string", description: "Override the execution workspace/current working directory" },
    "dry-run": {
      type: "boolean",
      default: false,
      description: "Authorize and lower the command, then print safe diagnostics without dispatching or writing state",
    },
  },
  async run({ args }) {
    rejectRetiredRunSpelling(args._);
    if (args.verbose === true) setVerbose(true);
    const timeoutMs = parseTimeoutFlag(exactStringArg(args, "timeout"));
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
