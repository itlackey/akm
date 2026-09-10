// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import path from "node:path";
import { defineCommand } from "citty";
import { getParsedInvocation } from "../../cli/invocation";
import { getStringArg, parsePositiveIntFlag } from "../../cli/parse-args";
import { GLOBAL_OUTPUT_ARGS, output, runWithJsonErrors } from "../../cli/shared";
import { isFullRefInput, parseRefInput } from "../../core/asset/resolve-ref";
import type { LlmConnectionConfig } from "../../core/config/config";
import { loadConfig } from "../../core/config/config";
import { ConfigError, UsageError } from "../../core/errors";
import { resolveMutationTarget } from "../../core/mutation-target";
import { getCacheDir } from "../../core/paths";
import { redactSensitiveText } from "../../core/redaction";
import { clearLogFile, setLogFile, warn } from "../../core/warn";
import { resolveWriteTarget } from "../../core/write-source";
import { collectEngineCredentialValues } from "../../integrations/agent/engine-resolution";
import { probeLlmEndpoint } from "../../llm/client";
import { akmImprove } from "./improve";
import { runImproveReportQuery } from "./improve-report";
import {
  buildImproveRunId,
  recordImproveRunResult,
  recordTerminatedImproveRun,
  type TerminationReason,
} from "./improve-result-file";
import { runImproveSession } from "./improve-session";
import {
  type EngineUnavailableProcessName,
  type ResolvedImprovePlan,
  type ResolvedImproveProcess,
  resolveImprovePlan,
} from "./improve-strategies";
import { formatUsageReportTable } from "./improve-usage-report";

let akmImproveForRun: typeof akmImprove = akmImprove;

/** Swap the CLI's improve work implementation in deterministic subprocess tests. */
export function _setAkmImproveForTests(fake?: typeof akmImprove): void {
  akmImproveForRun = fake ?? akmImprove;
}

/**
 * Handle the `--auto-accept` flag retired in 0.9.0, returning the scope the run
 * should actually use.
 *
 * citty is non-strict, so the removed flag is silently absorbed rather than
 * rejected — which is the dangerous case. The SPACE-separated spelling
 * (`--auto-accept 90`) leaves `90` sitting in the positional slot, where it is
 * read as the asset-type scope: the run then matches nothing and exits 0, so a
 * 0.8-era crontab goes dark with no error at all. Warn about the flag, and drop
 * the poisoned positional so the run behaves as an unscoped improve instead.
 */
function resolveScopeAfterRetiredAutoAccept(scopeArg: string | undefined): string | undefined {
  const invocation = getParsedInvocation();
  const autoAcceptRaw = invocation.getFlagValue("--auto-accept");
  if (autoAcceptRaw === undefined && !invocation.hasFlag("--auto-accept")) return scopeArg;
  warn(
    "[improve] --auto-accept was removed in 0.9 and is ignored; proposals always queue for review. " +
      "Replacement: `akm improve && akm proposal drain --promote --yes`, or a `triage` block with " +
      'applyMode: "promote" in your strategy. It becomes a hard error in 0.10.',
  );
  if (scopeArg !== undefined && scopeArg === autoAcceptRaw) {
    warn(`[improve] ignoring "${scopeArg}" as a scope — it is the removed --auto-accept flag's value.`);
    return undefined;
  }
  return scopeArg;
}

/**
 * `akm improve canary` was removed in 0.9 (moved to
 * `scripts/refresh-canary-set.ts`). Without this check "canary" falls through
 * to the generic scope positional, where resolveImproveScope treats any bare
 * word as a type filter that matches zero entries — so an unmigrated caller
 * silently acquires the improve lock and exits 0 having done nothing, instead
 * of getting an error.
 */
function rejectRetiredCanaryScope(scopeArg: string | undefined): void {
  if (scopeArg !== "canary") return;
  throw new UsageError(
    '"akm improve canary" was removed in 0.9. Use `bun scripts/refresh-canary-set.ts [--refresh]` instead.',
    "INVALID_FLAG_VALUE",
  );
}

/**
 * `--target` was renamed to `--bundle` on `improve` in 0.9 (S8). citty is
 * non-strict, so the retired spelling is silently absorbed rather than
 * rejected — accepted proposals then write into the default bundle instead
 * of the one the caller named, with exit 0 and no error. Reject it
 * explicitly instead.
 */
function rejectRetiredImproveTargetFlag(): void {
  if (!getParsedInvocation().hasFlag("--target")) return;
  throw new UsageError(
    "`akm improve --target` was renamed to `--bundle` in 0.9. Use `--bundle <name>` instead.",
    "INVALID_FLAG_VALUE",
  );
}

/**
 * `--require-engines` (#957): abort before any lock, log, or index side
 * effect when the resolved plan already knows a process the active strategy
 * would enable cannot run. Without this flag improve degrades gracefully —
 * it skips the affected processes and reports them in `skippedProcesses` —
 * which is right for an interactive run but wrong for a scheduled one that
 * would rather fail loudly than burn its budget re-indexing and then skip
 * everything. Names the unresolved credential reference per process (not
 * just the process name) so an operator whose own shell passes config
 * validation can see exactly what the scheduler's environment is missing.
 */
function assertRequiredEnginesAvailable(plan: ResolvedImprovePlan): void {
  if (plan.engineUnavailable.length === 0) return;
  const lines = plan.engineUnavailable.map((item) => `  - ${item.process} (${item.configKey}): ${item.reason}`);
  throw new ConfigError(
    `--require-engines: ${plan.engineUnavailable.length} improve process${plan.engineUnavailable.length === 1 ? "" : "es"} cannot run because ${plan.engineUnavailable.length === 1 ? "its" : "their"} engine is unavailable:\n${lines.join("\n")}`,
    "LLM_NOT_CONFIGURED",
  );
}

/** One resolved LLM connection `--require-engines` needs to prove reachable. */
interface RequiredEngineTarget {
  process: EngineUnavailableProcessName;
  engine: string;
  connection: LlmConnectionConfig;
}

/**
 * Every distinct `kind: "llm"` connection the active strategy's plan would
 * actually dispatch against — the main per-process runners plus triage's own
 * judgment engine, which is resolved separately (#957).
 */
function collectRequiredEngineTargets(plan: ResolvedImprovePlan): RequiredEngineTarget[] {
  const targets: RequiredEngineTarget[] = [];
  for (const [processName, process] of Object.entries(plan.processes) as [
    EngineUnavailableProcessName,
    ResolvedImproveProcess,
  ][]) {
    if (process.runner) {
      targets.push({ process: processName, engine: process.runner.engine, connection: process.runner.connection });
    }
  }
  if (plan.triageJudgment?.kind === "llm") {
    targets.push({
      process: "triage.judgment",
      engine: plan.triageJudgment.engine,
      connection: plan.triageJudgment.connection,
    });
  }
  return targets;
}

/**
 * `--require-engines` field re-test (#957): the static check above only
 * proves an engine is configured and credentialed — it cannot see a dead
 * endpoint. A field run against an unreachable engine sat silent for
 * minutes instead of hitting the documented exit-78 path. Reuse the SAME
 * bounded reachability probe `akm health`'s `default-llm-engine` /
 * `configured-engines` checks already run (`probeLlmEndpoint`, a single
 * `/models` GET bounded by its own default timeout) once per distinct
 * endpoint, so a dead engine is caught here instead of during dispatch.
 */
async function assertRequiredEnginesReachable(
  plan: ResolvedImprovePlan,
  probeReachable: typeof probeLlmEndpoint = probeLlmEndpoint,
): Promise<void> {
  const targets = collectRequiredEngineTargets(plan);
  if (targets.length === 0) return;
  const probesByEndpoint = new Map<string, ReturnType<typeof probeReachable>>();
  const probed = await Promise.all(
    targets.map(async (target) => {
      const endpointKey = target.connection.endpoint.replace(/\/+$/, "");
      let pending = probesByEndpoint.get(endpointKey);
      if (!pending) {
        pending = probeReachable(target.connection);
        probesByEndpoint.set(endpointKey, pending);
      }
      return { ...target, reach: await pending };
    }),
  );
  const unreachable = probed.filter((item) => !item.reach.reachable);
  if (unreachable.length === 0) return;
  const lines = unreachable.map(
    (item) =>
      `  - ${item.process} (engine "${item.engine}", ${item.connection.endpoint}): ${item.reach.error ?? "did not respond"}`,
  );
  throw new ConfigError(
    `--require-engines: ${unreachable.length} improve process${unreachable.length === 1 ? "" : "es"} cannot run because ${unreachable.length === 1 ? "its" : "their"} engine endpoint is not reachable:\n${lines.join("\n")}`,
    "LLM_NOT_CONFIGURED",
  );
}

/**
 * `akm improve report` (#944): a scope value that dispatches to the per-run
 * LLM usage/routing report instead of a real improve run — "report" is not,
 * and will never be, a real asset type (`DEFAULT_ALLOWED_TYPES` in
 * improve-strategies.ts), so this already matched zero assets before this
 * flag existed, matching the precedent `rejectRetiredCanaryScope` set for
 * intercepting a special scope word ahead of any lock/log/index side effect.
 */
function runImproveReportCli(args: { run?: string; since?: string }): void {
  const runIdArg = getStringArg(args, "run");
  const sinceArg = getStringArg(args, "since");
  const result = runImproveReportQuery({ runId: runIdArg, since: sinceArg });
  output("improve-report", { ok: true, ...result });
}

/**
 * `--run`/`--since` only mean anything with the "report" scope, which
 * intercepts before this point in the `run` handler below. citty is
 * non-strict, so passing either with a real scope (or no scope at all) used
 * to be silently ignored — the flag's value was read nowhere else, and the
 * run proceeded as an ordinary improve run with no error, discarding the
 * operator's intent. Reject explicitly instead, matching the precedent
 * `rejectRetiredCanaryScope`/`rejectRetiredImproveTargetFlag` set for other
 * flag misuse on this command.
 */
function rejectReportOnlyFlags(args: { run?: string; since?: string }): void {
  const flag =
    getStringArg(args, "run") !== undefined
      ? "--run"
      : getStringArg(args, "since") !== undefined
        ? "--since"
        : undefined;
  if (flag === undefined) return;
  throw new UsageError(
    `\`${flag}\` only applies to \`akm improve report\`. Use \`akm improve report ${flag} <value>\` instead.`,
    "INVALID_FLAG_VALUE",
  );
}

export const improveCommand = defineCommand({
  meta: {
    name: "improve",
    description:
      "Analyze existing AKM assets and generate improvement proposals; also consolidates memories when the selected strategy enables consolidate.",
  },
  // Raw defineCommand, so the global output flags are declared here explicitly.
  // Without them citty treats `--format` as a boolean and its space-separated
  // value falls through to the `scope` positional.
  args: {
    ...GLOBAL_OUTPUT_ARGS,
    scope: {
      type: "positional",
      description: "Optional asset type or asset ref to improve",
      required: false,
    },
    task: { type: "string", description: "Add extra guidance for this improvement pass" },
    "dry-run": { type: "boolean", description: "Show planned actions without writing", default: false },
    plan: {
      type: "boolean",
      description:
        "Alias for --dry-run (#947). Sets the exact same internal flag; use it when previewing resolved process -> engine -> model routing (plan.processes) rather than checking what would write.",
      default: false,
    },
    bundle: { type: "string", description: "Override the write target for accepted proposals" },
    limit: { type: "string", description: "Maximum number of assets to process (highest utility first)" },
    "timeout-ms": {
      type: "string",
      description: "Wall-clock budget for the entire run in milliseconds (default: 7200000 = 2 hours)",
    },
    "require-feedback-signal": {
      type: "boolean",
      description:
        "Only process assets with recent feedback signals (disables the proactive/high-salience fallback lanes)",
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
        "If another improve run already holds the lock, skip gracefully (exit 0) instead of failing with 'already running' (exit 78). Use for high-frequency scheduled runs so they don't pile up failures while a longer run is in progress.",
      default: false,
    },
    "require-engines": {
      type: "boolean",
      description:
        "Abort before any indexing, lock, or log side effect (exit 78) if the active strategy would enable a process whose engine or credential cannot be resolved in this process's environment, OR whose endpoint fails a bounded reachability probe (the same probe akm health runs). Without this flag, improve degrades gracefully instead: it skips the affected processes and reports them in the result's skippedProcesses. Recommended alongside --skip-if-locked for scheduled runs.",
      default: false,
    },
    run: {
      type: "string",
      description:
        'Only with the "report" scope (`akm improve report --run <id>`): show the LLM usage/routing report for one specific improve_runs row instead of the most recent run. Mutually exclusive with --since.',
    },
    since: {
      type: "string",
      description:
        'Only with the "report" scope (`akm improve report --since <window>`): aggregate the LLM usage/routing report over every real run started since <window> (a duration like "24h"/"7d", or an ISO timestamp) instead of showing one run. Mutually exclusive with --run.',
    },
    strategy: {
      type: "string",
      description:
        "Named improve strategy from improve.strategies or built-in strategies (catchup, consolidate, default, graph-refresh, proactive-maintenance, quick, reflect-distill, thorough). Controls which sub-processes run and which asset types are processed.",
    },
    sync: {
      type: "boolean",
      description:
        "Commit (and optionally push) the git-backed primary bundle when the run finishes. Use --no-sync to disable. Default: on for git-backed bundles (per profile config).",
    },
    push: {
      type: "boolean",
      description:
        "Push after the end-of-run sync commit when writable + remote configured. Use --no-push to commit only. Default: per profile config (true).",
    },
  },
  async run({ args }) {
    await runWithJsonErrors(async () => {
      // #944 — dispatch before any lock/log/index side effect, same
      // interception point as rejectRetiredCanaryScope below.
      if (getStringArg(args, "scope") === "report") {
        runImproveReportCli(args);
        return;
      }
      rejectReportOnlyFlags(args);
      rejectRetiredImproveTargetFlag();
      // D7 — `--format` used to be rejected here outright. It is a global flag on
      // a command that does emit an envelope through `output()` (always on
      // `--dry-run`, otherwise with `--json-to-stdout`), so rejecting it made
      // improve a fourth inconsistent format behaviour rather than a documented
      // exemption. It now applies to that envelope; progress output stays on
      // stderr regardless.
      const jsonToStdout = args["json-to-stdout"];
      const targetArg = getStringArg(args, "bundle");
      const taskArg = getStringArg(args, "task");
      // #947 — `--plan` is a zero-logic discoverability alias for `--dry-run`;
      // it must never fork the computation, only set the same flag.
      const dryRun = args["dry-run"] || args.plan;
      const limitRaw = parsePositiveIntFlag(args.limit ?? undefined);
      const timeoutMs = parsePositiveIntFlag(args["timeout-ms"], "--timeout-ms");
      const requireFeedbackSignal = args["require-feedback-signal"];
      const skipIfLocked = args["skip-if-locked"];
      const strategyArg = getStringArg(args, "strategy");
      const effectiveConfig = loadConfig();
      const scopeArg = resolveScopeAfterRetiredAutoAccept(getStringArg(args, "scope"));
      rejectRetiredCanaryScope(scopeArg);
      const scopeRef = scopeArg && isFullRefInput(scopeArg) ? parseRefInput(scopeArg) : undefined;
      const writeTarget = dryRun
        ? undefined
        : scopeRef
          ? resolveMutationTarget(effectiveConfig, scopeRef, targetArg).target
          : resolveWriteTarget(effectiveConfig, targetArg);
      // Resolve every enabled model-backed process before logging, signal
      // lifecycle setup, or any filesystem/database side effect.
      // #800/#957 round 3 — `--dry-run`/`--plan` never dispatches, so the
      // "no improve process can run" guard must not throw when every process
      // is disabled purely by an unreachable credential; a live run keeps
      // throwing (allowAllDisabled unset).
      const resolvedPlan = resolveImprovePlan(strategyArg, effectiveConfig, { allowAllDisabled: Boolean(dryRun) });
      if (args["require-engines"]) {
        assertRequiredEnginesAvailable(resolvedPlan);
        await assertRequiredEnginesReachable(resolvedPlan);
      }
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
      const primaryStashDir = writeTarget?.source.path;
      const inferredScopeMode = scopeRef ? "ref" : scopeArg ? "type" : "all";

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
                ...(writeTarget ? { writeTarget } : {}),
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
                  task: taskArg,
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
      if (dryRun) {
        // A dry-run never persists its result, so stdout is its only result
        // channel. F4: was `process.exit(0)`, which terminates synchronously
        // and skips pending cleanup (e.g. the `finally { clearLogFile(); }`
        // above already ran, but any citty/runWithJsonErrors-level cleanup
        // on the way out would not). Exit code is 0 either way — `return`
        // alone is sufficient since success is the default `process.exitCode`.
        output("improve", improveResult);
        return;
      }

      // Default mode (0.8.0+): persist the full result as a row in the
      // `improve_runs` table of state.db (migration 003) and emit NOTHING
      // on stdout. The verbose JSON would otherwise scroll earlier progress
      // logs out of the terminal buffer. The existing `[improve] ...`
      // progress log lines on stderr remain the canonical console UX — the
      // usage-report table below (#944) follows that same convention
      // (stderr, `[improve]`-prefixed), it is not new stdout noise.
      //
      // Pre-0.8.0 wrote `<stash>/.akm/runs/<run-id>/improve-result.json`;
      // those files are no longer authored. Query recent runs with:
      //   sqlite3 "$AKM_DATA_DIR/state.db" \
      //     "SELECT id, started_at, ok, dry_run FROM improve_runs \
      //      ORDER BY started_at DESC LIMIT 10"
      // runId + primaryStashDir minted up-top so signal handlers can record
      // partial runs; reuse them here for the success path.
      runRecorded = true; // Suppress any late signal-handler write — the success path owns the row now.
      if (primaryStashDir) {
        try {
          recordImproveRunResult(primaryStashDir, runId, improveResult, startedAtIso, sensitiveValues);
        } catch (err) {
          // Stderr warning on the failure path is preferable to crashing
          // the run after all the work has completed.
          process.stderr.write(
            `warning: failed to record improve run ${runId}: ${err instanceof Error ? err.message : String(err)}\n`,
          );
        }
      } else {
        process.stderr.write(
          `warning: no writable bundle directory resolved; improve result not persisted to state.db (use --json-to-stdout to capture)\n`,
        );
      }

      // #944 — same table `akm improve report` renders, appended to every
      // real (non-dry-run) run so an operator sees the routing/cost split
      // without a separate command. Omitted when the run made no LLM calls
      // and skipped no enabled process (nothing to report).
      if (improveResult.usageReport) {
        process.stderr.write(`${formatUsageReportTable(improveResult.usageReport)}\n`);
      }

      if (jsonToStdout) output("improve", improveResult);

      // F4: was `process.exit(0)` — the run has already been fully recorded
      // above (recordImproveRunResult / the warning path), so nothing here
      // depends on an immediate synchronous exit. This is the last statement
      // in the handler, so a plain fall-through is equivalent.
    });
  },
});
