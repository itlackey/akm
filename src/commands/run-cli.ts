// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fs from "node:fs";
import { type ArgsDef, type CommandDef, parseArgs, runCommand } from "citty";
import { warnWorkflowUse } from "../cli/deprecations";
import { createParsedInvocation, findCittyTopLevelCommandIndex, getParsedInvocation } from "../cli/invocation";
import { parseNonNegativeIntFlag, parseTimeoutValue } from "../cli/parse-args";
import { defineJsonCommand, GLOBAL_OUTPUT_ARGS, reportChildExit } from "../cli/shared";
import { assertKnownFlags, type FlagScanCommand, scanRoot } from "../cli/unknown-flags";
import { setResolvedUsageAssetType } from "../cli/usage";
import { adapterForId, bundleOf } from "../core/adapter/registry";
import { makeBundleRef, parseBundleRef } from "../core/asset/asset-ref";
import { loadConfig } from "../core/config/config";
import { AkmError, NotFoundError, UsageError } from "../core/errors";
import { registerInjectedSecretValues } from "../core/redaction";
import { resolveConceptOwner } from "../indexer/lookup/adapter-concept-owner";
import { resolveSourceEntries } from "../indexer/search/search-source";
import { buildFileContext } from "../indexer/walk/file-context";
import { scriptProgram } from "../tasks/frozen-script";
import { parseTaskSource } from "../tasks/source/parse-task-source";
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
args.resume = {
  type: "boolean",
  description: "Resume the failed run of a version 5 task, with the inputs and flags it was started with",
  default: false,
};
args.ref = {
  type: "positional",
  description: "Script, agent, command, task or workflow ref; or an existing workflow run id",
  required: true,
};

/** What `akm run <ref>` resolved to. `refIndex` is the ref's position in the tokens after `run`. */
export type RunTarget =
  | { kind: "script"; refIndex: number; ref: string; file: string }
  | { kind: "asset"; refIndex: number; ref: string; type: string; target: string; file: string }
  | { kind: "run-id"; refIndex: number; ref: string; target: string }
  | { kind: "error"; refIndex: number; error: unknown };

let runTarget: RunTarget | undefined;

/** Keep the target resolved at startup for the `run` command to read; `undefined` for any other command. */
export function setRunTarget(target: RunTarget | undefined): void {
  runTarget = target;
}

/** The position of the ref in the tokens after `run`, or -1 when there is none. */
export function runRefIndex(runArgs: readonly string[]): number {
  return findCittyTopLevelCommandIndex(runArgs, args);
}

/**
 * Resolve the ref of `akm run` once: the only place that decides what a ref is. Only the flags before the ref
 * (`--bundle` among them) take part. A failure is returned, not thrown: the `run` command throws it, so startup
 * still serves `--help` and the other commands that never run the target.
 */
export async function resolveRunTarget(runArgs: readonly string[]): Promise<RunTarget> {
  const refIndex = runRefIndex(runArgs);
  if (refIndex < 0) {
    return { kind: "error", refIndex, error: new UsageError("akm run needs a ref.", "MISSING_REQUIRED_ARGUMENT") };
  }
  const ref = runArgs[refIndex] as string;
  try {
    // Existing workflow run ids take precedence, just as workflow run does.
    const runId = ref.includes("/") ? undefined : await resolveWorkflowRunTarget(ref);
    if (runId !== undefined) return { kind: "run-id", refIndex, ref, target: runId };
    const bundleRef = parseBundleRef(ref);
    if (bundleRef.fragment !== undefined) {
      throw new UsageError("akm run cannot execute a fragment; pass the whole asset ref.", "INVALID_FLAG_VALUE");
    }
    const locate = (bundle: string | undefined): RunTarget => {
      if (bundle !== undefined && bundleRef.bundle !== undefined && bundleRef.bundle !== bundle) {
        throw new UsageError("--bundle conflicts with the bundle in the asset ref.", "INVALID_FLAG_VALUE");
      }
      const match = resolveConceptOwner(
        { ...bundleRef, ...(bundle === undefined ? {} : { bundle }) },
        resolveSourceEntries(undefined, loadConfig()),
      );
      if (!match) {
        throw new NotFoundError(
          `Asset not found for ref: ${ref}`,
          "ASSET_NOT_FOUND",
          "Use akm search to find an executable asset.",
        );
      }
      const owning = bundleOf({ name: match.bundleId, path: match.source.path, location: match.source.location });
      const document = adapterForId(match.adapterId)?.recognize(
        owning,
        buildFileContext(match.source.path, match.owner.path),
      );
      const type = document?.type ?? "unknown";
      const file = match.owner.path;
      if (type === "script") return { kind: "script", refIndex, ref, file };
      return { kind: "asset", refIndex, ref, type, target: makeBundleRef(match.bundleId, match.owner.conceptId), file };
    };
    const before = parseArgs(runArgs.slice(0, refIndex), { bundle: args.bundle as ArgsDef[string] }).bundle;
    const located = locate(typeof before === "string" ? before : undefined);
    if (located.kind === "script") return located;
    // Only a script's tail is its own: for any other asset a trailing `--bundle` is akm's, and picks the owner.
    const after = createParsedInvocation(["", "", ...runArgs.slice(refIndex + 1)]).getFlagValue("--bundle");
    return after === undefined ? located : locate(after);
  } catch (error) {
    return { kind: "error", refIndex, error };
  }
}

/**
 * Where the script's own tokens start in the tokens after `run`, or `undefined` when every token is akm's. A
 * script's tail is never akm's. A ref that is malformed or matches nothing is no script, so its tail stays akm's
 * (`--help` prints help); any other failure (an unreadable config, say) leaves it unknown whether the tail is a
 * script's, so akm leaves it alone and reports the failure.
 */
export function runPassthroughFrom(target: RunTarget): number | undefined {
  if (target.kind === "script") return target.refIndex + 1;
  if (target.kind !== "error" || target.refIndex < 0) return undefined;
  const refIsNotRunnable = target.error instanceof AkmError && ["usage", "not-found"].includes(target.error.kind);
  return refIsNotRunnable ? undefined : target.refIndex + 1;
}

export const runAssetCommand = defineJsonCommand({
  configFile: false,
  meta: {
    name: "run",
    description:
      "Run a script (`akm run scripts/<file> [arguments]`: akm's flags go before the ref, everything after it is the script's own), an agent (--prompt/--prompt-stdin), command (--arguments), task (declared input flags), or workflow (declared parameter flags). Repeatable --env <ref> and --secret <ref>:<VAR> inject env assets and secrets into the run. Existing workflow run ids continue their frozen run. Other workflow lifecycle operations remain under akm workflow. To run any other program, use `akm exec`.",
  },
  args,
  async run({ args: parsed, rawArgs }) {
    const resolved = runTarget;
    if (resolved === undefined) throw new Error("akm run started without a resolved target.");
    if (resolved.kind === "error") throw resolved.error;
    const invocation = getParsedInvocation();
    // `rawArgs` is what citty hands this command; `own` is the part of it akm parses.
    const own = invocation.ownArgsOf(rawArgs);
    if (resolved.kind === "script") {
      await runScript(resolved, own.slice(0, resolved.refIndex), invocation.passthroughArgs());
      return;
    }
    const { ref, target } = resolved;
    const scriptFile = resolved.kind === "asset" ? resolved.file : undefined;
    const type = resolved.kind === "asset" ? resolved.type : "workflow";
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
    const retarget = (tokens: readonly string[]): string[] => {
      const positioned = [...tokens];
      positioned[resolved.refIndex] = target;
      return positioned;
    };
    const ownsRunFlags = type === "agent" || type === "command";
    // A version 5 task reads its own start flags (`--env`, `--secret`, `--inherit`, ...) and gives each step its own environment.
    const versionFive =
      type === "task" &&
      scriptFile !== undefined &&
      parseTaskSource({ yaml: fs.readFileSync(scriptFile, "utf8"), filePath: scriptFile }).version === "5-beta";
    const allTokens = [...own, ...rawArgs.slice(own.length)];
    const withoutRunFlags = (tokens: readonly string[]): string[] =>
      versionFive
        ? [...tokens]
        : ownsRunFlags
          ? withoutFlags(tokens, ["--env", "--secret", "--inherit"], ["--clean"])
          : withoutInjectionFlags(tokens);
    const forwarded = withoutRunFlags(retarget(allTokens));
    if (type === "workflow" && own.some((token) => /^--(?:no-)?new(?:=|$)/.test(token))) {
      throw new UsageError("akm run does not accept --new; a workflow ref always starts a new run.", "UNKNOWN_FLAG");
    }
    const schema = scanRoot(executor.path, executor.command as FlagScanCommand);
    // A task reads and checks the tokens after its ref itself, once it knows the inputs it declares.
    if (type !== "task") assertKnownFlags(schema, [...executor.path, ...withoutRunFlags(retarget(own))]);
    if (type === "agent" || type === "command") {
      const selectedArgs = parseArgs(forwarded, executor.command.args as ArgsDef);
      if (selectedArgs.config !== undefined) {
        throw new UsageError("--config must come before run: akm --config <file> run <ref>.", "INVALID_FLAG_VALUE");
      }
      if (rawArgs.length > own.length || selectedArgs._.length !== 1) {
        throw new UsageError(
          `akm run ${ref} does not accept extra positional arguments or --. Use ${type === "agent" ? "--prompt or --prompt-stdin" : "--arguments"} for its input.`,
          "INVALID_FLAG_VALUE",
        );
      }
    }
    // Every process an executor starts inherits akm's environment, so the injected variables go there, and
    // the secrets among them join what each executor scrubs from the output it captures.
    const injected = versionFive ? { values: {}, secretValues: [] } : resolveInjections();
    if (ownsRunFlags && (parsed.clean === true || parsed.inherit !== undefined)) {
      const env = childEnvFromFlags(process.env, { clean: parsed.clean === true, inherit: parsed.inherit });
      for (const name of Object.keys(process.env)) delete process.env[name];
      Object.assign(process.env, env);
    }
    Object.assign(process.env, injected.values);
    registerInjectedSecretValues(injected.secretValues);
    // Bun ignores `process.exitCode = undefined`; 0 is the reset it honours.
    process.exitCode = 0;
    await runCommand(executor.command as CommandDef, { rawArgs: forwarded });
  },
});

/** Run the script in place: the flags before the ref are akm's, the tokens after it reach the script as they are. */
async function runScript(
  target: Extract<RunTarget, { kind: "script" }>,
  own: readonly string[],
  passthrough: readonly string[],
): Promise<void> {
  assertKnownFlags({ args: SCRIPT_ARGS } as FlagScanCommand, own);
  const flags = parseArgs([...own], SCRIPT_ARGS);
  const injected = resolveInjections(createParsedInvocation(["", "", ...own]));
  const env = childEnvFromFlags(process.env, { clean: flags.clean === true, inherit: flags.inherit });
  Object.assign(env, injected.values);
  const { argv, script } = scriptProgram(target.ref, target.file, passthrough);
  const result = await runProgram({
    argv,
    script,
    env,
    capture: false,
    maxRetries: parseNonNegativeIntFlag(flags["max-retries"], "--max-retries") ?? 0,
    ...(flags.cwd !== undefined ? { cwd: flags.cwd } : {}),
    ...(flags.timeout !== undefined ? { timeoutMs: parseTimeoutValue(flags.timeout) } : {}),
  });
  if (result.timedOut) console.error(`akm run: timed out after ${flags.timeout}`);
  reportChildExit(result.timedOut ? 1 : (result.exitCode ?? 1));
}
