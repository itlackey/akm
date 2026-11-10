// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import path from "node:path";
import { defineCommand } from "citty";
import { findCittyTopLevelCommandIndex, getStringArg, hasSubcommand, parsePositiveIntFlag } from "../../cli/parse-args";
import { SELECTION_ARGS, selectionFromArgs } from "../../cli/selection";
import { defineJsonCommand, GLOBAL_OUTPUT_ARGS, output, runWithJsonErrors } from "../../cli/shared";
import { type AssetRef, isFullRefInput, parsePlacementRef } from "../../core/asset/resolve-ref";
import type { AkmConfig } from "../../core/config/config";
import { loadConfig } from "../../core/config/config";
import { collectCredentialValues } from "../../core/config/credentials";
import { UsageError } from "../../core/errors";
import { getRunLogDir } from "../../core/paths";
import { redactSensitiveText } from "../../core/redaction";
import { clearLogFile, setLogFile } from "../../core/warn";
import { getOutputMode } from "../../output/context";
import { deliverRendered } from "../../output/stdout";
import { resolveMutationTarget } from "../../sources/mutation-target";
import { resolveWriteTarget } from "../../sources/write-source";
import { namesIndexedRootAsset } from "./eligibility";
import { akmImprove, buildLockSkippedResult, IMPROVE_TARGET_FLAG, resolveImproveReadSource } from "./improve";
import { runImproveReportQuery } from "./improve-report";
import {
  buildImproveRunId,
  recordImproveRunResult,
  recordTerminatedImproveRun,
  type TerminationReason,
} from "./improve-result-file";
import { runImproveSession } from "./improve-session";
import { type ResolvedImprovePlan, resolveImprovePlan } from "./improve-strategies";
import { formatUsageReportTable } from "./improve-usage-report";
import { renderReflectPromptPreview } from "./reflect";

let akmImproveForRun: typeof akmImprove = akmImprove;

/** Swap the CLI's improve work implementation in deterministic subprocess tests. */
export function _setAkmImproveForTests(fake?: typeof akmImprove): void {
  akmImproveForRun = fake ?? akmImprove;
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
      description: "Report for one improve_runs row instead of the latest (not with --since)",
    },
    since: {
      type: "string",
      description: "Aggregate every run since a duration (24h, 7d) or ISO time (not with --run)",
    },
  },
  run({ args }) {
    const result = runImproveReportQuery({ runId: getStringArg(args, "run"), since: getStringArg(args, "since") });
    output("improve-report", { ok: true, ...result });
  },
});

/** The subcommands `setup` withheld for this run, restored by `cleanup` (one command runs per process; in-process tests run many). */
let subCommandsWithheld = false;

const IMPROVE_SUBCOMMANDS = { report: improveReportCommand };

export const improveCommand = defineCommand({
  meta: {
    name: "improve",
    description:
      "Analyze existing AKM assets and generate improvement proposals; also consolidates memories when the selected strategy enables consolidate. `improve report` is a subcommand.",
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
      description: "Bundle to improve (default: the working bundle)",
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
      description: "Skip (exit 0, not 75) if another improve run holds the lock",
      default: false,
    },
    "show-prompt": {
      type: "boolean",
      description: "Print the composed reflect prompt for one asset ref and exit (no lock, index write or model call)",
      default: false,
    },
    strategy: {
      type: "string",
      description: "Named improve strategy: improve.strategies key, or consolidate or default",
    },
    ...SELECTION_ARGS,
    sync: {
      type: "boolean",
      description: "Sync the git-backed primary bundle before and after the run (--no-sync disables)",
    },
    push: {
      type: "boolean",
      description: "Push after the sync commits (--no-push commits only)",
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
      const scopeArg = getStringArg(args, "scope");
      // `improve judge` (removed in 0.11) would otherwise run as the scope `judge`. A root asset named `judge` is still a scope.
      if (scopeArg === "judge" && !namesIndexedRootAsset("judge")) {
        throw new UsageError("`akm improve judge` is gone.", "UNKNOWN_COMMAND", "Use `akm judge reflect.quality`.");
      }
      const effectiveConfig = loadConfig();
      const scopeRef = scopeArg && isFullRefInput(scopeArg) ? parsePlacementRef(scopeArg) : undefined;
      // The host-wide switch (`akm setup --learning off`): nothing runs, scheduled or by hand, dry run or not.
      if (effectiveConfig.improve?.enabled === false) {
        process.stderr.write(
          "[improve] Background learning is off on this host, so nothing ran. Turn it on with `akm setup --learning on`.\n",
        );
        const scope = scopeRef
          ? { mode: "ref" as const }
          : scopeArg
            ? { mode: "type" as const }
            : { mode: "all" as const };
        output("improve", {
          ...buildLockSkippedResult(
            strategyArg ?? effectiveConfig.improve?.strategy ?? "default",
            { ...scope, ...(scopeArg ? { value: scopeArg } : {}) },
            undefined,
            "learning-off",
          ),
          dryRun: Boolean(dryRun),
        });
        return;
      }
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
