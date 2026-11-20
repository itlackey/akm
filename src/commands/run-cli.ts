// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fs from "node:fs";
import { type ArgsDef, type CommandDef, parseArgs, runCommand } from "citty";
import { warnWorkflowUse } from "../cli/deprecations";
import { createParsedInvocation, findCittyTopLevelCommandIndex } from "../cli/invocation";
import { parsePositiveIntFlag, parseTimeoutValue } from "../cli/parse-args";
import { defineJsonCommand, GLOBAL_OUTPUT_ARGS } from "../cli/shared";
import { assertKnownFlags, type FlagScanCommand } from "../cli/unknown-flags";
import { setResolvedUsageAssetType } from "../cli/usage";
import { adapterForId } from "../core/adapter/registry";
import { makeBundleRef, parseBundleRef } from "../core/asset/asset-ref";
import { loadConfig } from "../core/config/config";
import { NotFoundError, UsageError } from "../core/errors";
import { registerInjectedSecretValues } from "../core/redaction";
import { withRetries } from "../execution/retry";
import { resolveConceptOwner } from "../indexer/lookup/adapter-concept-owner";
import { resolveSourceEntries } from "../indexer/search/search-source";
import { buildFileContext } from "../indexer/walk/file-context";
import { scriptProgram } from "../tasks/frozen-script";
import { isTaskSourceV5 } from "../tasks/source/parse-task-source";
import { resolveWorkflowRunTarget } from "../workflows/runtime/runs";
import { agentCommand } from "./agent/contribute-cli";
import { commandRunCommand } from "./command/command-cli";
import { childEnvFromFlags } from "./env/child-env";
import { INJECTION_ARGS, resolveInjections, runProgram, withoutFlags, withoutInjectionFlags } from "./env/injection";
import { tasksRunCommand } from "./tasks/tasks-cli";
import { workflowRunCommand } from "./workflow-cli";

const EXECUTORS = {
  agent: { command: agentCommand, path: ["agent"] },
  command: { command: commandRunCommand, path: ["command", "run"] },
  task: { command: tasksRunCommand, path: ["task", "run"] },
  workflow: { command: workflowRunCommand, path: ["workflow", "run"] },
} as const;

type ExecutableType = keyof typeof EXECUTORS;

// Parse the union only to find the ref. The selected legacy command then owns
// its own flags, defaults and exact-name task/workflow input namespace.
const args: ArgsDef = {};
for (const executor of Object.values(EXECUTORS)) {
  for (const [name, definition] of Object.entries(executor.command.args ?? {})) {
    if (definition.type !== "positional") args[name] = definition;
  }
}
delete args.new;
delete args.config;
// `run`'s own: resolved here and taken off the line before an agent, command or script sees it.
Object.assign(args, INJECTION_ARGS);
args.clean = { type: "boolean", description: "Start the run with a minimal inherited environment", default: false };
args.inherit = {
  type: "string",
  description: "Start the run clean plus these parent env vars (comma-separated)",
};
// What `run` itself reads for a script: the flags before the ref. The tokens after the ref belong to the script.
const SCRIPT_ARGS: ArgsDef = {
  ...GLOBAL_OUTPUT_ARGS,
  ...INJECTION_ARGS,
  bundle: args.bundle as ArgsDef[string],
  clean: args.clean,
  inherit: args.inherit,
  cwd: args.cwd as ArgsDef[string],
  timeout: args.timeout as ArgsDef[string],
  "max-retries": args["max-retries"] as ArgsDef[string],
};
delete SCRIPT_ARGS.config;
args.ref = {
  type: "positional",
  description: "Script, agent, command, task or workflow ref; or an existing workflow run id",
  required: true,
};

export const runAssetCommand = defineJsonCommand({
  configFile: false,
  meta: {
    name: "run",
    description:
      "Run a script (`akm run scripts/<file> [arguments]`: akm's flags go before the ref, everything after it is the script's own), an agent (--prompt/--prompt-stdin), command (--arguments), task (declared input flags), or workflow (declared parameter flags). Repeatable --env <ref> and --secret <ref>:<VAR> inject env assets and secrets into the run. Existing workflow run ids continue their frozen run. Other workflow lifecycle operations remain under akm workflow. To run any other program, use `akm exec`.",
  },
  args,
  async run({ args: parsed, rawArgs }) {
    const ref = String(parsed.ref);
    let target = ref;
    let type: string;
    let scriptFile: string | undefined;
    // Existing workflow run ids take precedence, just as workflow run does.
    const runId = ref.includes("/") ? undefined : await resolveWorkflowRunTarget(ref);
    if (runId !== undefined) {
      type = "workflow";
      target = runId;
    } else {
      const bundleRef = parseBundleRef(ref);
      if (bundleRef.fragment !== undefined) {
        throw new UsageError("akm run cannot execute a fragment; pass the whole asset ref.", "INVALID_FLAG_VALUE");
      }
      const bundle = typeof parsed.bundle === "string" ? parsed.bundle : undefined;
      if (bundle !== undefined && bundleRef.bundle !== undefined && bundleRef.bundle !== bundle) {
        throw new UsageError("--bundle conflicts with the bundle in the asset ref.", "INVALID_FLAG_VALUE");
      }
      const match = resolveConceptOwner(
        { ...bundleRef, ...(bundle === undefined ? {} : { bundle }) },
        resolveSourceEntries(undefined, loadConfig()),
      );
      if (!match)
        throw new NotFoundError(
          `Asset not found for ref: ${ref}`,
          "ASSET_NOT_FOUND",
          "Use akm search to find an executable asset.",
        );
      const component = { id: match.bundleId, adapter: match.adapterId, root: match.source.path, writable: false };
      const document = adapterForId(match.adapterId)?.recognize(
        component,
        buildFileContext(match.source.path, match.owner.path),
      );
      type = document?.type ?? "unknown";
      target = makeBundleRef(match.bundleId, match.owner.conceptId);
      scriptFile = match.owner.path;
    }
    if (type === "script" && scriptFile !== undefined) {
      await runScript(ref, scriptFile, rawArgs, findCittyTopLevelCommandIndex(rawArgs, args));
      return;
    }
    setResolvedUsageAssetType(
      type,
      Object.hasOwn(EXECUTORS, type) ? { args: EXECUTORS[type as ExecutableType].command.args as ArgsDef } : undefined,
    );
    if (!Object.hasOwn(EXECUTORS, type)) {
      throw new UsageError(
        `akm run cannot execute asset type "${type}". Supported types: script, agent, command, task, workflow.`,
        "INVALID_FLAG_VALUE",
        "Use akm show <ref> to read this asset.",
      );
    }
    if (type === "workflow") warnWorkflowUse(`running workflow ${ref}`);
    const executor = EXECUTORS[type as ExecutableType];
    // Preserve raw input spellings and values; replace only the positional ref
    // with its qualified owner so another bundle cannot retarget a task.
    const positioned = [...rawArgs];
    positioned[findCittyTopLevelCommandIndex(rawArgs, args)] = target;
    const ownsRunFlags = type === "agent" || type === "command";
    // A version 5 task reads its own start flags (`--env`, `--secret`, `--inherit`, ...) and gives each step its own environment.
    const versionFive =
      type === "task" &&
      scriptFile !== undefined &&
      isTaskSourceV5({ yaml: fs.readFileSync(scriptFile, "utf8"), filePath: scriptFile });
    const forwarded = versionFive
      ? positioned
      : ownsRunFlags
        ? withoutFlags(positioned, ["--env", "--secret", "--inherit", "--max-retries"], ["--clean"])
        : withoutInjectionFlags(positioned);
    if (
      type === "workflow" &&
      rawArgs
        .slice(0, rawArgs.indexOf("--") === -1 ? undefined : rawArgs.indexOf("--"))
        .some((token) => /^--(?:no-)?new(?:=|$)/.test(token))
    ) {
      throw new UsageError("akm run does not accept --new; a workflow ref always starts a new run.", "UNKNOWN_FLAG");
    }
    let schema: FlagScanCommand = executor.command as FlagScanCommand;
    for (const part of [...executor.path].reverse()) schema = { subCommands: { [part]: schema } };
    assertKnownFlags(schema, [...executor.path, ...forwarded]);
    if (type === "agent" || type === "command") {
      const selectedArgs = parseArgs(forwarded, executor.command.args as ArgsDef);
      if (selectedArgs.config !== undefined) {
        throw new UsageError("--config must come before run: akm --config <file> run <ref>.", "INVALID_FLAG_VALUE");
      }
      if (forwarded.includes("--") || selectedArgs._.length !== 1) {
        throw new UsageError(
          `akm run ${ref} does not accept extra positional arguments or --. Use ${type === "agent" ? "--prompt or --prompt-stdin" : "--arguments"} for its input.`,
          "INVALID_FLAG_VALUE",
        );
      }
    }
    // Every process an executor starts inherits akm's environment, so the injected variables go there, and
    // the secrets among them join what each executor scrubs from the output it captures.
    const injected = versionFive ? { values: {}, secretValues: [] } : resolveInjections();
    const maxRetries = ownsRunFlags ? (parsePositiveIntFlag(parsed["max-retries"], "--max-retries") ?? 0) : 0;
    if (ownsRunFlags && (parsed.clean === true || parsed.inherit !== undefined)) {
      const env = childEnvFromFlags(process.env, { clean: parsed.clean === true, inherit: parsed.inherit });
      for (const name of Object.keys(process.env)) delete process.env[name];
      Object.assign(process.env, env);
    }
    Object.assign(process.env, injected.values);
    registerInjectedSecretValues(injected.secretValues);
    await withRetries(
      maxRetries,
      async () => {
        process.exitCode = undefined;
        await runCommand(executor.command as CommandDef, { rawArgs: forwarded });
        return process.exitCode;
      },
      (exitCode) => exitCode !== undefined && exitCode !== 0,
    );
  },
});

/** Run the script at `file` in place: the flags before the ref are akm's, the tokens after it go to the script as they are. */
async function runScript(ref: string, file: string, rawArgs: readonly string[], refIndex: number): Promise<void> {
  const own = rawArgs.slice(0, refIndex);
  assertKnownFlags({ args: SCRIPT_ARGS } as FlagScanCommand, own);
  const flags = parseArgs(own, SCRIPT_ARGS);
  const injected = resolveInjections(createParsedInvocation(["", "", ...own]));
  const env = childEnvFromFlags(process.env, { clean: flags.clean === true, inherit: flags.inherit });
  Object.assign(env, injected.values);
  const result = await runProgram({
    argv: scriptProgram(ref, file, rawArgs.slice(refIndex + 1)),
    env,
    capture: false,
    maxRetries: parsePositiveIntFlag(flags["max-retries"], "--max-retries") ?? 0,
    ...(flags.cwd !== undefined ? { cwd: flags.cwd } : {}),
    ...(flags.timeout !== undefined ? { timeoutMs: parseTimeoutValue(flags.timeout) } : {}),
  });
  if (result.timedOut) console.error(`akm run: timed out after ${flags.timeout}`);
  process.exitCode = result.timedOut ? 1 : (result.exitCode ?? 1);
}
