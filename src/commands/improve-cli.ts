// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import path from "node:path";
import { defineCommand } from "citty";
import { getStringArg, parseAutoAcceptFlag, parseNonNegativeIntFlag, parsePositiveIntFlag } from "../cli/parse-args";
import { output, runWithJsonErrors } from "../cli/shared";
import { loadConfig } from "../core/config";
import { UsageError } from "../core/errors";
import { getCacheDir } from "../core/paths";
import { clearLogFile, setLogFile } from "../core/warn";
import { resolveSourceEntries } from "../indexer/search-source";
import { getHyphenatedArg, getHyphenatedBoolean, parseFlagValue } from "../output/context";
import { akmImprove } from "./improve";
import {
  buildImproveRunId,
  recordTerminatedImproveRun,
  relativeImproveResultPath,
  type TerminationReason,
  writeImproveResultFile,
} from "./improve-result-file";

export const improveCommand = defineCommand({
  meta: {
    name: "improve",
    description:
      "Analyze existing AKM assets and generate improvement proposals; also consolidates memories when profiles.improve.default.processes.consolidate.enabled is true",
  },
  args: {
    scope: {
      type: "positional",
      description: "Optional asset type or asset ref to improve",
      required: false,
    },
    task: { type: "string", description: "Add extra guidance for this improvement pass" },
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
      description: "Only process assets with recent feedback signals (disables retrieval fallback)",
      default: false,
    },
    "min-retrieval-count": {
      type: "string",
      description:
        "Minimum retrieval count for zero-feedback fallback eligibility (default: 1, set 0 to include all assets regardless of retrieval history)",
    },
    "json-to-stdout": {
      type: "boolean",
      description:
        "Emit the full JSON result on stdout (legacy behaviour). (0.8.0+: full result is recorded in the improve_runs table of state.db and stdout is empty; use this flag for the prior behaviour, e.g. `akm improve --json-to-stdout | jq`.)",
      default: false,
    },
    profile: {
      type: "string",
      description:
        "Named improve profile from profiles.improve or built-in profiles (default, quick, thorough, memory-focus, graph-refresh). Controls which sub-processes run and which asset types are processed.",
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
    await runWithJsonErrors(async () => {
      const formatFlagValue = parseFlagValue(process.argv, "--format");
      if (formatFlagValue !== undefined) {
        throw new UsageError(
          `akm improve does not accept --format. That flag controls output formatting for other commands (search, show, etc.).\n` +
            `Did you mean: akm improve (no --format flag)?`,
          "INVALID_FLAG_VALUE",
        );
      }
      const jsonToStdout = getHyphenatedBoolean(args, "json-to-stdout");
      const autoAcceptRaw = getHyphenatedArg<string>(args, "auto-accept");
      const autoAccept = parseAutoAcceptFlag(autoAcceptRaw);
      const targetArg = getStringArg(args, "target");
      const taskArg = getStringArg(args, "task");
      const dryRun = getHyphenatedBoolean(args, "dry-run");
      const limitRaw = parsePositiveIntFlag(args.limit ?? undefined);
      const timeoutMs = parsePositiveIntFlag(getHyphenatedArg<string>(args, "timeout-ms"), "--timeout-ms");
      const consolidateRecoveryRaw = getHyphenatedArg<string>(args, "consolidate-recovery");
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
      const minRetrievalCountRaw = getHyphenatedArg<string>(args, "min-retrieval-count");
      const minRetrievalCount = parseNonNegativeIntFlag(minRetrievalCountRaw, "--min-retrieval-count");
      const requireFeedbackSignal = getHyphenatedBoolean(args, "require-feedback-signal");
      const profileArg = getStringArg(args, "profile");
      // Only set the keys the user actually passed (citty leaves the flag
      // undefined unless `--sync`/`--no-sync` / `--push`/`--no-push` appears),
      // so the resolved profile `sync` block wins by default.
      const syncFlag = getHyphenatedArg<boolean>(args, "sync");
      const pushFlag = getHyphenatedArg<boolean>(args, "push");
      const syncOverride: { enabled?: boolean; push?: boolean } = {};
      if (syncFlag !== undefined) syncOverride.enabled = syncFlag;
      if (pushFlag !== undefined) syncOverride.push = pushFlag;

      const improveLogFile = path.join(
        getCacheDir(),
        "logs",
        "improve",
        `${new Date().toISOString().replace(/[:.]/g, "-")}.log`,
      );
      setLogFile(improveLogFile);
      const startedAtMs = Date.now();
      const startedAtIso = new Date(startedAtMs).toISOString();

      // Mint the run-id up front so signal handlers can persist a partial
      // record if the process is killed mid-run. Pre-2026-05-26 the runId
      // was minted at end-of-run, so SIGTERM'd runs (cron timeout) left no
      // row in improve_runs and effectively disappeared from `akm health`.
      const runId = buildImproveRunId();
      const primaryStashDir = resolveSourceEntries(undefined, loadConfig())[0]?.path;
      const scopeArg = getStringArg(args, "scope");
      const inferredScopeMode = (scopeArg ?? "").includes(":") ? "ref" : scopeArg ? "type" : "all";

      // Signal handler + exception path both flow through this helper so
      // every abnormal termination produces a row with ok:false and a
      // reason in metadata.terminated.
      let runRecorded = false;
      const persistTerminated = (reason: TerminationReason, errorMessage?: string): void => {
        if (runRecorded) return;
        if (!primaryStashDir) return;
        runRecorded = true;
        try {
          recordTerminatedImproveRun(primaryStashDir, runId, startedAtIso, reason, {
            scopeMode: inferredScopeMode,
            scopeValue: scopeArg ?? null,
            dryRun: Boolean(dryRun),
            profile: profileArg ?? null,
            ...(errorMessage ? { errorMessage } : {}),
          });
        } catch (err) {
          process.stderr.write(
            `warning: failed to persist terminated improve run ${runId}: ${err instanceof Error ? err.message : String(err)}\n`,
          );
        }
      };

      const sigtermHandler = () => {
        persistTerminated("SIGTERM");
        process.stderr.write(`[improve] received SIGTERM; recorded terminated run ${runId}\n`);
        process.exit(143);
      };
      const sigintHandler = () => {
        persistTerminated("SIGINT");
        process.stderr.write(`[improve] received SIGINT; recorded terminated run ${runId}\n`);
        process.exit(130);
      };
      const sighupHandler = () => {
        persistTerminated("SIGHUP");
        process.exit(129);
      };
      process.once("SIGTERM", sigtermHandler);
      process.once("SIGINT", sigintHandler);
      process.once("SIGHUP", sighupHandler);

      let improveResult: Awaited<ReturnType<typeof akmImprove>>;
      try {
        improveResult = await akmImprove({
          scope: scopeArg,
          task: taskArg,
          dryRun,
          target: targetArg,
          autoAccept,
          ...(limitRaw !== undefined ? { limit: limitRaw } : {}),
          ...(timeoutMs !== undefined ? { timeoutMs } : {}),
          ...(minRetrievalCount !== undefined ? { minRetrievalCount } : {}),
          ...(requireFeedbackSignal ? { requireFeedbackSignal } : {}),
          ...(profileArg !== undefined ? { profile: profileArg } : {}),
          ...(Object.keys(syncOverride).length > 0 ? { sync: syncOverride } : {}),
          consolidateOptions: {
            target: targetArg,
            dryRun,
            autoAccept,
            task: taskArg,
            ...(consolidateRecovery !== undefined ? { recoveryMode: consolidateRecovery } : {}),
          },
        });
      } catch (err) {
        // akmImprove threw — record the failure before letting runWithJsonErrors
        // emit the standard JSON error envelope. Without this, exceptions in
        // the main loop (LLM provider crash, OOM, etc.) leave no improve_runs
        // row, matching the SIGTERM gap.
        persistTerminated("exception", err instanceof Error ? err.message : String(err));
        throw err;
      } finally {
        process.removeListener("SIGTERM", sigtermHandler);
        process.removeListener("SIGINT", sigintHandler);
        process.removeListener("SIGHUP", sighupHandler);
        clearLogFile();
      }
      const durationMs = Date.now() - startedAtMs;

      if (jsonToStdout) {
        // Legacy / escape-hatch mode: full JSON on stdout, no file write.
        // Kept for scripts/agents that already pipe to jq.
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
          writeImproveResultFile(primaryStashDir, runId, improveResult);
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
