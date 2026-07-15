// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import path from "node:path";
import { defineCommand } from "citty";
import { getStringArg, parseAutoAcceptFlag, parsePositiveIntFlag } from "../../cli/parse-args";
import { output, runWithJsonErrors } from "../../cli/shared";
import { loadConfig } from "../../core/config/config";
import { UsageError } from "../../core/errors";
import { getCacheDir } from "../../core/paths";
import { redactSensitiveText } from "../../core/redaction";
import { withStateDb } from "../../core/state-db";
import { clearLogFile, setLogFile } from "../../core/warn";
import { resolveWriteTarget } from "../../core/write-source";
import { closeDatabase, openExistingDatabase } from "../../indexer/db/db";
import { collectEngineCredentialValues } from "../../integrations/agent/engine-resolution";
import { parseFlagValue } from "../../output/context";
import { getActiveCanaries, queryRecentCycleMetrics } from "../../storage/repositories/canaries-repository";
import { refreshCanarySet } from "./collapse-detector";
import { akmImprove } from "./improve";
import {
  buildImproveRunId,
  recordTerminatedImproveRun,
  relativeImproveResultPath,
  type TerminationReason,
  writeImproveResultFile,
} from "./improve-result-file";
import { runImproveSession } from "./improve-session";
import { resolveImprovePlan } from "./improve-strategies";

let akmImproveForRun: typeof akmImprove = akmImprove;

/** Swap the CLI's improve work implementation in deterministic subprocess tests. */
export function _setAkmImproveForTests(fake?: typeof akmImprove): void {
  akmImproveForRun = fake ?? akmImprove;
}

// R5 — collapse-detector canary set inspection / explicit refresh. The
// detector NEVER auto-refreshes the canary set (silent re-baselining is how a
// slow collapse hides); this verb is the only refresh path.
//
// Dispatched from the parent improve run() on `scope === "canary"` — NOT a
// citty subCommand: registering subCommands makes citty treat EVERY first
// positional as a subcommand name, breaking `akm improve <type|ref>` outright
// (citty throws "Unknown command memory"), and citty also re-runs the parent
// run() after a matched subcommand.
async function runCanaryInspection(refresh: boolean): Promise<void> {
  const config = loadConfig();
  const cfg = config.improve?.collapseDetector ?? {};

  const result = withStateDb((stateDb) => {
    let refreshOutcome: "refreshed" | "kept-old-set" | undefined;
    if (refresh) {
      const indexDb = openExistingDatabase();
      try {
        // Mint-first, deactivate-after (refreshCanarySet): an empty/unreadable
        // index keeps the old baseline instead of destroying it.
        refreshOutcome = refreshCanarySet(stateDb, indexDb, cfg) === null ? "kept-old-set" : "refreshed";
      } finally {
        closeDatabase(indexDb);
      }
    }
    const canaries = getActiveCanaries(stateDb);
    const canarySetId = canaries[0]?.canary_set_id;
    const recentCycles = canarySetId ? queryRecentCycleMetrics(stateDb, canarySetId, cfg.windowCycles ?? 5) : [];
    return {
      schemaVersion: 1 as const,
      ok: true,
      refreshed: refreshOutcome === "refreshed",
      ...(refreshOutcome === "kept-old-set"
        ? { warning: "refresh skipped: no mintable learning entries in the index — existing canary set kept" }
        : {}),
      canarySetId: canarySetId ?? null,
      canaries: canaries.map((c) => ({ id: c.id, anchorRef: c.anchor_ref, query: c.query })),
      recentCycles: recentCycles.map((r) => ({
        ts: r.ts,
        pass: r.pass,
        meanRecall: r.mean_recall,
        meanNdcg: r.mean_ndcg,
        distinctContentRatio: r.distinct_content_ratio,
        acceptedActions: r.accepted_actions,
        mergeFloorViolations: r.merge_floor_violations,
        alerts: JSON.parse(r.alerts_json) as string[],
      })),
    };
  });
  output("improve-canary", result);
}

export const improveCommand = defineCommand({
  meta: {
    name: "improve",
    description:
      "Analyze existing AKM assets and generate improvement proposals; also consolidates memories when the selected strategy enables consolidate. `akm improve canary [--refresh]` inspects the collapse-detector canary set.",
  },
  args: {
    scope: {
      type: "positional",
      description: "Optional asset type or asset ref to improve",
      required: false,
    },
    task: { type: "string", description: "Add extra guidance for this improvement pass" },
    refresh: {
      type: "boolean",
      description:
        "(canary scope only) Mint a new collapse-detector canary set and deactivate the old one; old rows and their cycle history are retained",
      default: false,
    },
    "dry-run": { type: "boolean", description: "Show planned actions without writing", default: false },
    target: { type: "string", description: "Override the write target for accepted proposals" },
    "auto-accept": {
      type: "string",
      description:
        "Auto-accept proposals at or above this confidence threshold (0-100). Default: disabled. Pass a value 0-100 to enable. 'safe' is an alias for 90. Pass 'false' to be explicit.",
    },
    limit: { type: "string", description: "Maximum number of assets to process (highest utility first)" },
    "timeout-ms": {
      type: "string",
      description: "Wall-clock budget for the entire run in milliseconds (default: 7200000 = 2 hours)",
    },
    "consolidate-recovery": {
      type: "string",
      description:
        "How to handle stale/incomplete consolidation journals: abort (default) or clean (remove stale journal artifacts)",
    },
    "require-feedback-signal": {
      type: "boolean",
      description:
        "Only process assets with recent feedback signals (disables the proactive/high-salience fallback lanes)",
      default: false,
    },
    "json-to-stdout": {
      type: "boolean",
      description:
        "Emit the full JSON result on stdout (legacy behaviour). (0.8.0+: full result is recorded in the improve_runs table of state.db and stdout is empty; use this flag for the prior behaviour, e.g. `akm improve --json-to-stdout | jq`.)",
      default: false,
    },
    "skip-if-locked": {
      type: "boolean",
      description:
        "If another improve run already holds the lock, skip gracefully (exit 0) instead of failing with 'already running' (exit 78). Use for high-frequency scheduled runs so they don't pile up failures while a longer run is in progress.",
      default: false,
    },
    strategy: {
      type: "string",
      description:
        "Named improve strategy from improve.strategies or built-in strategies (default, quick, thorough, memory-focus, graph-refresh). Controls which sub-processes run and which asset types are processed.",
    },
    sync: {
      type: "boolean",
      description:
        "Commit (and optionally push) the git-backed primary stash when the run finishes. Use --no-sync to disable. Default: on for git-backed stashes (per profile config).",
    },
    push: {
      type: "boolean",
      description:
        "Push after the end-of-run sync commit when writable + remote configured. Use --no-push to commit only. Default: per profile config (true).",
    },
  },
  async run({ args }) {
    // "canary" is a reserved scope word (never a valid asset type, and refs
    // contain ":"): dispatch to the detector inspection verb instead of an
    // improve run.
    if (args.scope === "canary") {
      await runWithJsonErrors(() => runCanaryInspection(args.refresh));
      return;
    }
    await runWithJsonErrors(async () => {
      const formatFlagValue = parseFlagValue(process.argv, "--format");
      if (formatFlagValue !== undefined) {
        throw new UsageError(
          `akm improve does not accept --format. That flag controls output formatting for other commands (search, show, etc.).\n` +
            `Did you mean: akm improve (no --format flag)?`,
          "INVALID_FLAG_VALUE",
        );
      }
      const jsonToStdout = args["json-to-stdout"];
      const autoAcceptRaw = args["auto-accept"];
      const autoAccept = parseAutoAcceptFlag(autoAcceptRaw);
      const targetArg = getStringArg(args, "target");
      const taskArg = getStringArg(args, "task");
      const dryRun = args["dry-run"];
      const limitRaw = parsePositiveIntFlag(args.limit ?? undefined);
      const timeoutMs = parsePositiveIntFlag(args["timeout-ms"], "--timeout-ms");
      const consolidateRecoveryRaw = args["consolidate-recovery"];
      const consolidateRecovery =
        consolidateRecoveryRaw === undefined
          ? undefined
          : (consolidateRecoveryRaw.trim().toLowerCase() as "abort" | "clean" | string);
      if (consolidateRecovery !== undefined && consolidateRecovery !== "abort" && consolidateRecovery !== "clean") {
        throw new UsageError(
          `Invalid --consolidate-recovery value: "${consolidateRecoveryRaw}". Must be one of: abort, clean.`,
          "INVALID_FLAG_VALUE",
        );
      }
      const requireFeedbackSignal = args["require-feedback-signal"];
      const skipIfLocked = args["skip-if-locked"];
      const strategyArg = getStringArg(args, "strategy");
      const effectiveConfig = loadConfig();
      const writeTarget = resolveWriteTarget(effectiveConfig, targetArg, { requireWritable: !dryRun });
      // Resolve every enabled model-backed process before logging, signal
      // lifecycle setup, or any filesystem/database side effect.
      const resolvedPlan = resolveImprovePlan(strategyArg, effectiveConfig);
      const selectedStrategyName = resolvedPlan.strategy.name;
      const sensitiveValues = collectEngineCredentialValues(effectiveConfig);
      // Only set the keys the user actually passed (citty leaves the flag
      // undefined unless `--sync`/`--no-sync` / `--push`/`--no-push` appears),
      // so the resolved profile `sync` block wins by default.
      const syncFlag = args.sync;
      const pushFlag = args.push;
      const syncOverride: { enabled?: boolean; push?: boolean } = {};
      if (syncFlag !== undefined) syncOverride.enabled = syncFlag;
      if (pushFlag !== undefined) syncOverride.push = pushFlag;

      if (!dryRun) {
        const improveLogFile = path.join(
          getCacheDir(),
          "logs",
          "improve",
          `${new Date().toISOString().replace(/[:.]/g, "-")}.log`,
        );
        setLogFile(improveLogFile);
      }
      const startedAtMs = Date.now();
      const startedAtIso = new Date(startedAtMs).toISOString();

      // Mint the run-id up front so signal handlers can persist a partial
      // record if the process is killed mid-run. Pre-2026-05-26 the runId
      // was minted at end-of-run, so SIGTERM'd runs (cron timeout) left no
      // row in improve_runs and effectively disappeared from `akm health`.
      const runId = buildImproveRunId();
      const primaryStashDir = writeTarget.source.path;
      const scopeArg = getStringArg(args, "scope");
      const inferredScopeMode = (scopeArg ?? "").includes(":") ? "ref" : scopeArg ? "type" : "all";

      // Signal handler + exception path both flow through this helper so
      // every abnormal termination produces a row with ok:false and a
      // reason in metadata.terminated.
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

      // R8: the signal table / handlers / watchdog / persist-before-exit
      // choreography lives in `runImproveSession`. It registers the
      // SIGTERM/SIGINT/SIGHUP handlers (each persists the terminated-run row
      // BEFORE process.exit so a SIGTERM'd run — e.g. cron timeout — always
      // leaves a row in improve_runs), awaits the work, then removes the
      // handlers on the way out. `onTerminate` persists synchronously
      // (recordTerminatedImproveRun -> bun:sqlite writes are sync), and the
      // 2000ms watchdog inside the session force-exits if that ever hangs.
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
                writeTarget,
                autoAccept,
                ...(runId !== undefined ? { runId } : {}),
                ...(limitRaw !== undefined ? { limit: limitRaw } : {}),
                ...(timeoutMs !== undefined ? { timeoutMs } : {}),
                ...(requireFeedbackSignal ? { requireFeedbackSignal } : {}),
                ...(skipIfLocked ? { skipIfLocked } : {}),
                ...(strategyArg !== undefined ? { strategy: strategyArg } : {}),
                ...(Object.keys(syncOverride).length > 0 ? { sync: syncOverride } : {}),
                consolidateOptions: {
                  target: targetArg,
                  dryRun,
                  autoAccept,
                  task: taskArg,
                  ...(consolidateRecovery !== undefined ? { recoveryMode: consolidateRecovery } : {}),
                },
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
        // akmImprove threw — record the failure before letting runWithJsonErrors
        // emit the standard JSON error envelope. Without this, exceptions in
        // the main loop (LLM provider crash, OOM, etc.) leave no improve_runs
        // row, matching the SIGTERM gap.
        persistTerminated("exception", err instanceof Error ? err.message : String(err));
        throw err;
      } finally {
        clearLogFile();
      }
      const durationMs = Date.now() - startedAtMs;

      if (dryRun || jsonToStdout) {
        // A dry-run never persists its result, so stdout is its only result
        // channel. --json-to-stdout remains the live-run escape hatch.
        output("improve", improveResult);
        process.exit(0);
      }

      // Default mode (0.8.0+): persist the full result as a row in the
      // `improve_runs` table of state.db (migration 003) and emit NOTHING
      // on stdout. The verbose JSON would otherwise scroll earlier progress
      // logs out of the terminal buffer. The existing `[improve] ...`
      // progress log lines on stderr remain the canonical console UX —
      // do NOT add any new console output here.
      //
      // Pre-0.8.0 wrote `<stash>/.akm/runs/<run-id>/improve-result.json`;
      // those files are no longer authored. Query recent runs with:
      //   sqlite3 "$AKM_DATA_DIR/state.db" \
      //     "SELECT id, started_at, ok, dry_run FROM improve_runs \
      //      ORDER BY started_at DESC LIMIT 10"
      // runId + primaryStashDir minted up-top so signal handlers can record
      // partial runs; reuse them here for the success path.
      const resultRef = relativeImproveResultPath(runId);
      runRecorded = true; // Suppress any late signal-handler write — the success path owns the row now.
      if (primaryStashDir) {
        try {
          writeImproveResultFile(primaryStashDir, runId, improveResult, startedAtIso, sensitiveValues);
        } catch (err) {
          // Stderr warning on the failure path is preferable to crashing
          // the run after all the work has completed.
          process.stderr.write(
            `warning: failed to record improve run ${resultRef}: ${err instanceof Error ? err.message : String(err)}\n`,
          );
        }
      } else {
        process.stderr.write(
          `warning: no writable stash directory resolved; improve result not persisted to state.db (use --json-to-stdout to capture)\n`,
        );
      }

      // durationMs reserved for future use (no console emission today).
      void durationMs;
      process.exit(0);
    });
  },
});
