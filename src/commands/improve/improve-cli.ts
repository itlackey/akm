// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import path from "node:path";
import { defineCommand } from "citty";
import { findCittyTopLevelCommandIndex, getStringArg, hasSubcommand, parsePositiveIntFlag } from "../../cli/parse-args";
import { SELECTION_ARGS, selectionFromArgs } from "../../cli/selection";
import { defineJsonCommand, GLOBAL_OUTPUT_ARGS, output, runWithJsonErrors } from "../../cli/shared";
import { type AssetRef, isFullRefInput, parseRefInput } from "../../core/asset/resolve-ref";
import type { AkmConfig } from "../../core/config/config";
import { loadConfig } from "../../core/config/config";
import { collectCredentialValues } from "../../core/config/credentials";
import { ConfigError, UsageError } from "../../core/errors";
import { resolveMutationTarget } from "../../core/mutation-target";
import { getRunLogDir } from "../../core/paths";
import { redactSensitiveText } from "../../core/redaction";
import { clearLogFile, setLogFile, warnOnce } from "../../core/warn";
import { resolveWriteTarget } from "../../core/write-source";
import { defaultWhich } from "../../integrations/agent/detect";
import { materializeConnection } from "../../integrations/agent/runner-dispatch";
import { type ChatCompletionConfig, probeLlmReachable } from "../../llm/client";
import { getOutputMode } from "../../output/context";
import { deliverRendered } from "../../output/html-render";
import { readStdin } from "../../runtime";
import { akmImprove, IMPROVE_TARGET_FLAG, resolveImproveReadSource } from "./improve";
import { runImproveReportQuery } from "./improve-report";
import {
  buildImproveRunId,
  recordImproveRunResult,
  recordTerminatedImproveRun,
  type TerminationReason,
} from "./improve-result-file";
import { runImproveSession } from "./improve-session";
import {
  type EngineProbeOutcome,
  type EngineUnavailableProcessName,
  type ResolvedImprovePlan,
  type ResolvedImproveProcess,
  resolveImprovePlan,
  resolveImproveStrategy,
} from "./improve-strategies";
import { formatUsageReportTable } from "./improve-usage-report";
import { renderReflectPromptPreview } from "./reflect";
import { resolveQualityGateJudge, runReflectQualityJudge } from "./stage";

let akmImproveForRun: typeof akmImprove = akmImprove;

/** Swap the CLI's improve work implementation in deterministic subprocess tests. */
export function _setAkmImproveForTests(fake?: typeof akmImprove): void {
  akmImproveForRun = fake ?? akmImprove;
}

/**
 * `--require-targets` (#957): fail before any side effect when an enabled
 * process cannot run, naming what each is missing — a scheduled run would
 * rather fail loudly than index and then skip everything.
 */
function assertRequiredTargetsAvailable(plan: ResolvedImprovePlan): void {
  if (plan.engineUnavailable.length === 0) return;
  const lines = plan.engineUnavailable.map((item) => `  - ${item.process} (${item.configKey}): ${item.reason}`);
  throw new ConfigError(
    `--require-targets: ${plan.engineUnavailable.length} improve process${plan.engineUnavailable.length === 1 ? "" : "es"} cannot run because ${plan.engineUnavailable.length === 1 ? "its" : "their"} connection or harness is not configured:\n${lines.join("\n")}`,
    "LLM_NOT_CONFIGURED",
  );
}

/**
 * One connection or harness `--require-targets` must prove usable, in the way
 * its kind allows: a connection gets one short completion, and a harness's
 * binary must resolve on PATH.
 */
interface RequiredTarget {
  process: EngineUnavailableProcessName;
  engine: string;
  connection?: ChatCompletionConfig;
  bin?: string;
}

/** Every engine the plan would dispatch to, triage's judgment engine included. */
function collectRequiredTargets(plan: ResolvedImprovePlan): RequiredTarget[] {
  const runners = (Object.entries(plan.processes) as [EngineUnavailableProcessName, ResolvedImproveProcess][])
    .flatMap(([processName, process]) => (process.runner ? [[processName, process.runner] as const] : []))
    .concat(plan.triageJudgment ? [["triage.judgment", plan.triageJudgment] as const] : []);
  return runners.map(([processName, runner]) => ({
    process: processName,
    engine: runner.name,
    ...(runner.kind === "harness" ? { bin: runner.bin } : { connection: materializeConnection(runner) }),
  }));
}

/**
 * The bound on `--require-targets`' probe: the connection's own request
 * timeout, at most two minutes. A local server busy with another job queues
 * the probe behind that job, and a fixed 3s bound failed every scheduled
 * improve run on 2026-09-27 against a reachable endpoint; the cap still ends a
 * hung endpoint (#957) long before a run's own multi-minute calls would.
 */
export function requiredTargetProbeTimeoutMs(connection: ChatCompletionConfig): number {
  return Math.min(connection.timeoutMs ?? REQUIRED_TARGET_PROBE_MAX_MS, REQUIRED_TARGET_PROBE_MAX_MS);
}

const REQUIRED_TARGET_PROBE_MAX_MS = 120_000;

/**
 * `--require-targets`, live: probe each connection's real completion path
 * (a gateway can list a model whose completion route is dead, #980), once per
 * endpoint + model, within {@link requiredTargetProbeTimeoutMs}, and look each
 * agent harness's binary up on PATH. Returns each target's latency for the run
 * result (R17); an unreachable one fails the run.
 */
export async function assertRequiredTargetsReachable(
  plan: ResolvedImprovePlan,
  probeReachable: (connection: ChatCompletionConfig) => Promise<{ reachable: boolean; error?: string }> = (
    connection,
  ) => probeLlmReachable(connection, requiredTargetProbeTimeoutMs(connection)),
  which: (bin: string) => string | undefined = defaultWhich,
): Promise<EngineProbeOutcome[]> {
  const targets = collectRequiredTargets(plan);
  if (targets.length === 0) return [];
  const probesByConnection = new Map<
    string,
    Promise<{ reach: { reachable: boolean; error?: string }; latencyMs: number }>
  >();
  const probeConnectionOnce = (connection: ChatCompletionConfig) => {
    const key = `${connection.endpoint.replace(/\/+$/, "")}|${connection.model}`;
    let pending = probesByConnection.get(key);
    if (!pending) {
      const probeStartedAt = Date.now();
      pending = probeReachable(connection).then((reach) => ({ reach, latencyMs: Date.now() - probeStartedAt }));
      probesByConnection.set(key, pending);
    }
    return pending;
  };
  const probed = await Promise.all(
    targets.map(async (target) => {
      if (target.bin !== undefined && which(target.bin) === undefined) {
        return { ...target, reach: { reachable: false, error: `${target.bin} is not on PATH` }, latencyMs: 0 };
      }
      if (!target.connection) return { ...target, reach: { reachable: true }, latencyMs: 0 };
      return { ...target, ...(await probeConnectionOnce(target.connection)) };
    }),
  );
  const unreachable = probed.filter((item) => !item.reach.reachable);
  if (unreachable.length > 0) {
    const lines = unreachable.map(
      (item) =>
        `  - ${item.process} (${item.connection ? "connection" : "harness"} "${item.engine}", ${item.connection?.endpoint ?? item.bin}): ${item.reach.error ?? "did not respond"}`,
    );
    throw new ConfigError(
      `--require-targets: ${unreachable.length} improve process${unreachable.length === 1 ? "" : "es"} cannot run because ${unreachable.length === 1 ? "its" : "their"} connection or harness completion path is not reachable:\n${lines.join("\n")}`,
      "LLM_NOT_CONFIGURED",
      "Check that each listed endpoint is up and serves its model, and that each listed agent binary is installed. The endpoint probe is one short completion, bounded by the connection's timeoutMs (at most two minutes).",
    );
  }
  return probed.map((item) => ({
    process: item.process,
    engine: item.engine,
    endpoint: item.connection?.endpoint ?? (item.bin as string),
    reachable: item.reach.reachable,
    latencyMs: item.latencyMs,
  }));
}

/** `--show-prompt` (#952): print reflect's composed prompt for one ref — no lock, write or dispatch. */
async function runShowPromptCli(
  refArg: string,
  parsedRef: AssetRef,
  taskArg: string | undefined,
  targetArg: string | undefined,
  resolvedPlan: ResolvedImprovePlan,
): Promise<void> {
  const readSource = resolveImproveReadSource(resolvedPlan.config as AkmConfig, parsedRef, targetArg);
  const preview = await renderReflectPromptPreview({
    ref: refArg,
    ...(taskArg ? { task: taskArg } : {}),
    improveProfile: resolvedPlan.strategy.config,
    config: resolvedPlan.config as AkmConfig,
    // A strategy that turns reflect off froze no runner for it; the preview resolves its own.
    ...(resolvedPlan.processes.reflect.runner ? { llmRunner: resolvedPlan.processes.reflect.runner } : {}),
    ...(resolvedPlan.run ? { run: resolvedPlan.run } : {}),
    stashDir: readSource.source.path,
  });
  const outputMode = getOutputMode();
  if (outputMode.format === "text") {
    deliverRendered(preview.prompt, outputMode.outputPath);
    return;
  }
  output("improve", {
    schemaVersion: 2,
    ok: true,
    ref: preview.ref,
    engine: preview.engine,
    engineKind: preview.engineKind,
    prompt: preview.prompt,
  });
}

/** `akm improve report` (#944): the per-run LLM usage/routing report ("report" is no asset type). */
const improveReportCommand = defineJsonCommand({
  meta: {
    name: "report",
    description: "Show the LLM usage/routing report for the most recent improve run, one run, or a window of runs.",
  },
  args: {
    run: {
      type: "string",
      description:
        "Show the report for one specific improve_runs row instead of the most recent run. Mutually exclusive with --since.",
    },
    since: {
      type: "string",
      description:
        'Aggregate the report over every real run started since <window> (a duration like "24h"/"7d", or an ISO timestamp) instead of showing one run. Mutually exclusive with --run.',
    },
  },
  run({ args }) {
    const result = runImproveReportQuery({ runId: getStringArg(args, "run"), since: getStringArg(args, "since") });
    output("improve-report", { ok: true, ...result });
  },
});

/**
 * `akm improve judge`: reflect's quality judge on one revision, read as
 * `{"source", "candidate", "feedback"}` JSON from stdin, with the engine the
 * strategy's reflect quality gate names. It writes nothing.
 */
const improveJudgeCommand = defineJsonCommand({
  meta: {
    name: "judge",
    description:
      "Run reflect's quality judge on one revision, read as {source, candidate, feedback, ref} JSON from stdin. Writes nothing.",
  },
  args: {
    strategy: {
      type: "string",
      description: "Named improve strategy whose reflect quality gate names the judge engine.",
    },
  },
  async run({ args }) {
    const input = process.stdin.isTTY
      ? {}
      : (JSON.parse((await readStdin()).toString("utf8")) as Record<string, unknown>);
    const { source, candidate, feedback, ref } = input;
    if (typeof source !== "string" || typeof candidate !== "string") {
      throw new UsageError(
        '`akm improve judge` reads {"source": "...", "candidate": "...", "feedback": "...", "ref": "..."} JSON from stdin.',
        "MISSING_REQUIRED_ARGUMENT",
      );
    }
    const config = loadConfig();
    const judge = resolveQualityGateJudge(
      config,
      resolveImproveStrategy(getStringArg(args, "strategy"), config).config,
      "reflect",
    );
    if (!judge) {
      throw new ConfigError(
        "`akm improve judge` judges with the reflect quality gate's connection or harness. Set improve.qualityGate.connection.",
        "INVALID_CONFIG_FILE",
      );
    }
    const notes = typeof feedback === "string" && feedback.trim() !== "" ? [feedback.trim()] : [];
    const verdict = await runReflectQualityJudge(config, candidate, source, notes, undefined, {
      runnerSelectionFrozen: true,
      llmRunner: judge,
      ...(typeof ref === "string" && ref ? { ref } : {}),
    });
    output("improve-judge", { engine: judge.name, ...verdict });
  },
});

/** The subcommands `setup` withheld for this run, restored by `cleanup` (one command runs per process; in-process tests run many). */
let subCommandsWithheld = false;

const IMPROVE_SUBCOMMANDS = { report: improveReportCommand, judge: improveJudgeCommand };

export const improveCommand = defineCommand({
  meta: {
    name: "improve",
    description:
      "Analyze existing AKM assets and generate improvement proposals; also consolidates memories when the selected strategy enables consolidate. `improve report` and `improve judge` are subcommands.",
  },
  subCommands: IMPROVE_SUBCOMMANDS,
  // `improve` takes a scope positional (an asset type or ref), and citty reads
  // the first positional of a command with subcommands as a subcommand name,
  // failing with an unknown command for a scope. So the subcommands stay
  // registered only for an invocation that names one; any other, scope or none,
  // is the improve run itself.
  setup(context) {
    const index = findCittyTopLevelCommandIndex(context.rawArgs, improveCommand.args as never);
    const token = index >= 0 ? context.rawArgs[index] : undefined;
    if (token !== undefined && token in IMPROVE_SUBCOMMANDS) return;
    subCommandsWithheld = true;
    context.cmd.subCommands = undefined;
  },
  cleanup(context) {
    if (!subCommandsWithheld) return;
    context.cmd.subCommands = IMPROVE_SUBCOMMANDS;
    subCommandsWithheld = false;
  },
  // Declared explicitly: otherwise citty takes `--format`'s value as the scope.
  args: {
    ...GLOBAL_OUTPUT_ARGS,
    scope: {
      type: "positional",
      description: "Optional asset type or asset ref to improve",
      required: false,
    },
    task: { type: "string", description: "Add extra guidance for this improvement pass" },
    "dry-run": { type: "boolean", description: "Show planned actions without writing", default: false },
    bundle: {
      type: "string",
      description:
        "Bundle to improve and write proposals to (default: defaultWriteTarget, else the working bundle); only its assets are planned",
    },
    limit: { type: "string", description: "Maximum number of assets to process (highest salience first)" },
    "timeout-ms": {
      type: "string",
      description: "Wall-clock budget for the entire run in milliseconds (default: 7200000 = 2 hours)",
    },
    "require-feedback-signal": {
      type: "boolean",
      description:
        "Turn the proactive-maintenance lane off for this run, so only assets with recent feedback are planned",
      default: false,
    },
    "json-to-stdout": {
      type: "boolean",
      description: "Also emit the full persisted run result on stdout as JSON.",
      default: false,
    },
    "skip-if-locked": {
      type: "boolean",
      description:
        "If another improve run already holds the lock, skip gracefully (exit 0) instead of failing with 'already running' (exit 75). Use for high-frequency scheduled runs so they don't pile up failures while a longer run is in progress.",
      default: false,
    },
    "require-targets": {
      type: "boolean",
      description:
        "Fail before the run starts (exit 78, before any indexing, lock, or log side effect) if the connection or harness an enabled process runs on (and triage's judgment, when it is on) is not usable: an enabled process has none configured, a connection's credential cannot be resolved in this process's environment, a connection does not answer one short completion (bounded by its timeoutMs, at most two minutes), or a harness binary is not on PATH. The quality-gate judges are not probed. Without this flag, improve degrades gracefully instead: it skips the affected processes and reports them in the result's skippedProcesses. Recommended alongside --skip-if-locked for scheduled runs.",
      default: false,
    },
    // Retired spelling of --require-targets: parsed, left out of --help, warns once.
    "require-engines": { type: "boolean", hidden: true, description: "Retired: use --require-targets." },
    "show-prompt": {
      type: "boolean",
      description:
        "Print the composed reflect prompt for one asset ref and exit — no lock, index write, or engine dispatch (#952). Requires a fully-qualified asset ref as the scope positional (e.g. `akm improve lessons/my-lesson --show-prompt`). JSON/yaml format carries the prompt as a `prompt` field; text format prints it directly.",
      default: false,
    },
    strategy: {
      type: "string",
      description:
        "Named improve strategy from improve.strategies or built-in strategies (consolidate, default). Controls which sub-processes run and which asset types are processed, never where they run.",
    },
    ...SELECTION_ARGS,
    sync: {
      type: "boolean",
      description:
        "Sync the git-backed primary bundle like `akm sync` (fetch and merge the upstream, commit, push) before the run, and commit (and optionally push) when it finishes. Use --no-sync to disable. Default: on for git-backed bundles (per profile config).",
    },
    push: {
      type: "boolean",
      description:
        "Push after the pre-run and end-of-run sync commits when writable + remote configured. Use --no-push to commit only. Default: per profile config (true).",
    },
  },
  async run({ args }) {
    await runWithJsonErrors(async () => {
      // citty runs this body after a subcommand it dispatched too.
      if (hasSubcommand(args, new Set(Object.keys(IMPROVE_SUBCOMMANDS)))) return;
      const jsonToStdout = args["json-to-stdout"];
      const targetArg = getStringArg(args, "bundle");
      const taskArg = getStringArg(args, "task");
      // `--show-prompt` is read-only too.
      const dryRun = args["dry-run"] || args["show-prompt"];
      const limitRaw = parsePositiveIntFlag(args.limit ?? undefined);
      const timeoutMs = parsePositiveIntFlag(args["timeout-ms"], "--timeout-ms");
      const requireFeedbackSignal = args["require-feedback-signal"];
      const skipIfLocked = args["skip-if-locked"];
      const strategyArg = getStringArg(args, "strategy");
      // What the run selected is the nearest layer of every call in it, judges included.
      const run = selectionFromArgs(args);
      const effectiveConfig = loadConfig();
      const scopeArg = getStringArg(args, "scope");
      const scopeRef = scopeArg && isFullRefInput(scopeArg) ? parseRefInput(scopeArg) : undefined;
      const writeTarget = dryRun
        ? undefined
        : scopeRef
          ? resolveMutationTarget(effectiveConfig, scopeRef, targetArg, { flag: IMPROVE_TARGET_FLAG }).target
          : resolveWriteTarget(effectiveConfig, targetArg, { flag: IMPROVE_TARGET_FLAG });
      // Every model-backed process resolves before any side effect; a dry run
      // never dispatches, so it tolerates every process being disabled.
      const resolvedPlan = resolveImprovePlan(strategyArg, effectiveConfig, Object.keys(run).length > 0 ? { run } : {});
      if (args["show-prompt"]) {
        if (!scopeArg || !scopeRef) {
          throw new UsageError(
            "`--show-prompt` requires a fully-qualified asset ref as the scope (e.g. `akm improve lessons/my-lesson --show-prompt`).",
            "INVALID_FLAG_VALUE",
          );
        }
        await runShowPromptCli(scopeArg, scopeRef, taskArg, targetArg, resolvedPlan);
        return;
      }
      let engineProbe: EngineProbeOutcome[] | undefined;
      if (args["require-engines"]) {
        warnOnce(
          "retired-flag:--require-engines",
          "--require-engines is retired: use --require-targets, which does the same.",
        );
      }
      if (args["require-targets"] || args["require-engines"]) {
        assertRequiredTargetsAvailable(resolvedPlan);
        engineProbe = await assertRequiredTargetsReachable(resolvedPlan);
      }
      const selectedStrategyName = resolvedPlan.strategy.name;
      const sensitiveValues = collectCredentialValues(effectiveConfig);
      // Only flags actually passed override the strategy's `sync` block.
      const syncFlag = args.sync;
      const pushFlag = args.push;
      const syncOverride: { enabled?: boolean; push?: boolean } = {};
      if (syncFlag !== undefined) syncOverride.enabled = syncFlag;
      if (pushFlag !== undefined) syncOverride.push = pushFlag;

      if (!dryRun) {
        const improveLogFile = path.join(
          getRunLogDir("improve"),
          `${new Date().toISOString().replace(/[:.]/g, "-")}.log`,
        );
        setLogFile(improveLogFile);
      }
      const startedAtMs = Date.now();
      const startedAtIso = new Date(startedAtMs).toISOString();

      // The run id is minted up front so a killed run still leaves an improve_runs row.
      const runId = buildImproveRunId();
      const primaryStashDir = writeTarget?.source.path;
      const inferredScopeMode = scopeRef ? "ref" : scopeArg ? "type" : "all";

      let runRecorded = false;
      const persistTerminated = (reason: TerminationReason, errorMessage?: string): void => {
        if (dryRun) return;
        if (runRecorded) return;
        if (!primaryStashDir) return;
        runRecorded = true;
        try {
          recordTerminatedImproveRun(primaryStashDir, runId, startedAtIso, reason, {
            scopeMode: inferredScopeMode,
            scopeValue: scopeArg ?? null,
            dryRun: Boolean(dryRun),
            strategy: selectedStrategyName,
            ...(errorMessage ? { errorMessage: redactSensitiveText(errorMessage, sensitiveValues) } : {}),
            sensitiveValues,
          });
        } catch (err) {
          process.stderr.write(
            `warning: failed to persist terminated improve run ${runId}: ${err instanceof Error ? err.message : String(err)}\n`,
          );
        }
      };

      // The session persists the terminated-run row before exiting on a signal.
      let improveResult: Awaited<ReturnType<typeof akmImprove>>;
      try {
        improveResult = await runImproveSession(
          {
            runWork: () =>
              akmImproveForRun({
                scope: scopeArg,
                task: taskArg,
                dryRun,
                resolvedPlan,
                target: targetArg,
                ...(writeTarget ? { writeTarget } : {}),
                ...(runId !== undefined ? { runId } : {}),
                ...(limitRaw !== undefined ? { limit: limitRaw } : {}),
                ...(timeoutMs !== undefined ? { timeoutMs } : {}),
                ...(requireFeedbackSignal ? { requireFeedbackSignal } : {}),
                ...(skipIfLocked ? { skipIfLocked } : {}),
                ...(strategyArg !== undefined ? { strategy: strategyArg } : {}),
                ...(engineProbe !== undefined ? { engineProbe } : {}),
                onBudgetHardKill: () => persistTerminated("budget_exhausted"),
                ...(Object.keys(syncOverride).length > 0 ? { sync: syncOverride } : {}),
              }),
          },
          {
            signalSource: process,
            exit: process.exit,
            onTerminate: (reason) => persistTerminated(reason),
            ack: (message) =>
              process.stderr.write(
                dryRun
                  ? `[improve] ${message}; dry-run state was not persisted\n`
                  : `[improve] ${message}; recorded terminated run ${runId}\n`,
              ),
          },
        );
      } catch (err) {
        persistTerminated("exception", err instanceof Error ? err.message : String(err));
        throw err;
      } finally {
        clearLogFile();
      }
      if (dryRun) {
        // A dry run persists nothing: stdout is its only result channel.
        output("improve", improveResult);
        return;
      }

      // A live run's result goes to state.db's improve_runs, not stdout
      // (progress stays on stderr). The success path owns the row now.
      runRecorded = true;
      if (primaryStashDir) {
        try {
          recordImproveRunResult(primaryStashDir, runId, improveResult, startedAtIso, sensitiveValues);
        } catch (err) {
          process.stderr.write(
            `warning: failed to record improve run ${runId}: ${err instanceof Error ? err.message : String(err)}\n`,
          );
        }
      } else {
        process.stderr.write(
          `warning: no writable bundle directory resolved; improve result not persisted to state.db (use --json-to-stdout to capture)\n`,
        );
      }

      // The `akm improve report` table, on stderr, when there is anything to report (#944).
      if (improveResult.usageReport) {
        process.stderr.write(`${formatUsageReportTable(improveResult.usageReport)}\n`);
      }

      if (jsonToStdout) output("improve", improveResult);
    });
  },
});
