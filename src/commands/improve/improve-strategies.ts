// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import catchup from "../../assets/improve-strategies/catchup.json" with { type: "json" };
import consolidate from "../../assets/improve-strategies/consolidate.json" with { type: "json" };
import defaultStrategy from "../../assets/improve-strategies/default.json" with { type: "json" };
import graphRefresh from "../../assets/improve-strategies/graph-refresh.json" with { type: "json" };
import proactiveMaintenance from "../../assets/improve-strategies/proactive-maintenance.json" with { type: "json" };
import quick from "../../assets/improve-strategies/quick.json" with { type: "json" };
import reflectDistill from "../../assets/improve-strategies/reflect-distill.json" with { type: "json" };
import thorough from "../../assets/improve-strategies/thorough.json" with { type: "json" };
import { parseRefInput } from "../../core/asset/resolve-ref";
import type { AkmConfig, ImproveProcessConfig, ImproveProfileConfig } from "../../core/config/config";
import { ImproveProfileConfigSchema } from "../../core/config/config-schema";
import { deepMergeConfig } from "../../core/config/deep-merge";
import {
  BUILTIN_IMPROVE_STRATEGY_NAMES,
  IMPROVE_PROCESS_ENGINE_CAPABILITIES,
} from "../../core/config/engine-semantics";
import { ConfigError } from "../../core/errors";
import type { LoweringNotice } from "../../execution/resolved-request";
import { describeLlmCredentialAvailability } from "../../integrations/agent/engine-resolution";
import type { RunnerSpec } from "../../integrations/agent/runner";
import { applyAutonomyGate, type GatedLane } from "./autonomy-gate";
import { resolveImproveExecution, resolveImproveLlmExecution } from "./execution";

/** 0.9 public name for the improve preset configuration. */
export type ImproveStrategyConfig = ImproveProfileConfig;

export interface SelectedStrategy {
  name: string;
  config: ImproveStrategyConfig;
}

export const DEFAULT_ALLOWED_TYPES: Record<"reflect" | "distill" | "consolidate", string[]> = {
  reflect: ["agent", "command", "knowledge", "lesson", "memory", "skill", "workflow"],
  distill: ["memory"],
  consolidate: ["memory"],
};

/** Resolve process enablement from the selected strategy, the sole improve authority. */
export function resolveProcessEnabled(
  processName: keyof NonNullable<ImproveProfileConfig["processes"]> | string,
  strategy: ImproveProfileConfig,
): boolean {
  const processes = strategy.processes as Record<string, { enabled?: boolean } | undefined> | undefined;
  return processes?.[processName]?.enabled === true;
}

export function shouldSkipRef(
  ref: string,
  processName: "reflect" | "distill" | "consolidate",
  strategy: ImproveProfileConfig,
): { skip: boolean; reason: string } {
  const process = strategy.processes?.[processName];
  if (process?.enabled === false) return { skip: true, reason: "process-disabled" };

  const parsed = parseRefInput(ref);
  const allowed = process?.allowedTypes ?? DEFAULT_ALLOWED_TYPES[processName];
  if (!allowed.includes(parsed.type)) return { skip: true, reason: "type-filter" };
  return { skip: false, reason: "" };
}

export function isStrategyFilteredForAllPasses(ref: string, strategy: ImproveProfileConfig): boolean {
  return shouldSkipRef(ref, "reflect", strategy).skip && shouldSkipRef(ref, "distill", strategy).skip;
}

const BUILTIN_STRATEGIES: Record<string, Record<string, unknown>> = {
  default: defaultStrategy,
  quick,
  thorough,
  "graph-refresh": graphRefresh,
  consolidate,
  catchup,
  "reflect-distill": reflectDistill,
  "proactive-maintenance": proactiveMaintenance,
};

if (BUILTIN_IMPROVE_STRATEGY_NAMES.some((name) => !(name in BUILTIN_STRATEGIES))) {
  throw new Error("Built-in improve strategy names are out of sync with their assets");
}

export function resolveImproveStrategy(name: string | undefined, config: AkmConfig): SelectedStrategy {
  const selectedName = name ?? config.defaults?.improveStrategy ?? "default";
  const userStrategies = config.improve?.strategies ?? {};
  if (!(selectedName in BUILTIN_STRATEGIES) && !userStrategies[selectedName]) {
    const valid = [...new Set([...Object.keys(BUILTIN_STRATEGIES), ...Object.keys(userStrategies)])].sort();
    throw new ConfigError(
      `Improve strategy "${selectedName}" not found. Valid strategies: ${valid.join(", ")}.`,
      "UNKNOWN_IMPROVE_STRATEGY",
    );
  }
  const selectedStrategy = BUILTIN_STRATEGIES[selectedName] ?? {};
  const baseStrategy = deepMergeConfig(BUILTIN_STRATEGIES.default ?? {}, selectedStrategy);
  const resolved = deepMergeConfig(
    baseStrategy as Record<string, unknown>,
    (userStrategies[selectedName] ?? {}) as Record<string, unknown>,
  );
  return { name: selectedName, config: ImproveProfileConfigSchema.parse(resolved) };
}

export type ImproveLlmRunner = Extract<RunnerSpec, { kind: "llm" }>;
export type ImproveProcessName = keyof typeof IMPROVE_PROCESS_ENGINE_CAPABILITIES;

export interface ResolvedImproveProcess {
  enabled: boolean;
  config: Readonly<ImproveProcessConfig>;
  runner: ImproveLlmRunner | null;
  notices?: readonly Readonly<LoweringNotice>[];
}

/**
 * `"triage.judgment"` names the triage sub-process's own LLM/SDK-fallback
 * judgment engine, which is resolved separately from the main
 * {@link IMPROVE_PROCESS_ENGINE_CAPABILITIES} loop and has no entry of its own
 * in that table (#957).
 */
export type EngineUnavailableProcessName = ImproveProcessName | "triage.judgment";

export interface EngineUnavailableProcess {
  process: EngineUnavailableProcessName;
  configKey: string;
  reason: string;
  /**
   * Structurally resolved routing metadata for the credential-unavailable case only
   * (a working engine whose secret isn't reachable here) — never set for the
   * no-engine-configured case, where these values were never resolved. `runner`
   * stays `null` on the process itself so dispatch can never see a credential-less
   * runner; a dry-run preview reads these instead when it needs to show what
   * resolution decided without materializing the credential (#800/#957).
   */
  engine?: string;
  model?: string;
  contextLength?: number;
}

/** Complete immutable process behavior for one improve invocation. */
export interface ResolvedImprovePlan {
  /** Immutable config snapshot used to re-enter canonical named-engine lowering. */
  config: Readonly<AkmConfig>;
  strategy: Readonly<SelectedStrategy>;
  processes: Readonly<Record<ImproveProcessName, ResolvedImproveProcess>>;
  triageJudgment: RunnerSpec | null;
  triageJudgmentNotices?: readonly Readonly<LoweringNotice>[];
  /**
   * D8 — lanes the autonomy gate downgraded for this run. Empty when
   * `experimental.improveAutonomy` is set. The run reports each one so a gated
   * lane is never a silent no-op.
   */
  autonomyGated: readonly GatedLane[];
  engineUnavailable: readonly EngineUnavailableProcess[];
}

/**
 * One row of the resolved process -> engine -> model routing table (#947).
 * Sourced entirely from data {@link resolveImprovePlan} already computes
 * before any dispatch — this is a pure projection, not new resolution. The
 * `eligibleRefs` count (reflect/distill/consolidate only) is folded in by the
 * caller (`buildResultExecutionPlan`, improve.ts), which is the only site
 * with the run's effective ref list in scope.
 */
export interface ProcessRoutingRow {
  process: EngineUnavailableProcessName;
  enabled: boolean;
  /** Resolved engine name, when this process resolved a runner. */
  engine?: string;
  /** Resolved model, for an llm-kind runner only. */
  model?: string;
  /** Kind of the resolved runner. Always "llm" for the main process table; the triage.judgment row can be "llm" | "agent" | "sdk". */
  engineKind?: RunnerSpec["kind"];
  /** This process's own lowering notices (not the run's deduped flat pool). */
  notices: readonly Readonly<LoweringNotice>[];
  /** Set when the strategy enabled this process but its engine/credential could not be resolved. */
  unavailable?: { configKey: string; reason: string };
  /** Count of this run's effective refs the process would act on (`shouldSkipRef`). reflect/distill/consolidate only. */
  eligibleRefs?: number;
}

/**
 * Project a resolved improve plan into one routing row per
 * {@link IMPROVE_PROCESS_ENGINE_CAPABILITIES} name, plus a `"triage.judgment"`
 * pseudo-row when the strategy configures a judgment engine. Pure — no I/O,
 * no re-resolution. Shared by `improve --dry-run`'s `plan.processes` (#947)
 * and `akm health`'s post-run reporting (#944); health's own
 * `active-improve-strategy` check keeps its existing `engines` shape.
 */
export function projectResolvedProcessRouting(plan: ResolvedImprovePlan): ProcessRoutingRow[] {
  const unavailableByProcess = new Map(plan.engineUnavailable.map((item) => [item.process, item]));
  const rows: ProcessRoutingRow[] = [];
  for (const processName of Object.keys(IMPROVE_PROCESS_ENGINE_CAPABILITIES) as ImproveProcessName[]) {
    const process = plan.processes[processName];
    const unavailable = unavailableByProcess.get(processName);
    rows.push({
      process: processName,
      enabled: process.enabled,
      ...(process.runner
        ? { engine: process.runner.engine, model: process.runner.connection.model, engineKind: process.runner.kind }
        : // #800/#957 round 3 — a credential-unavailable process never carries a
          // runner, but its structurally resolved engine/model is still worth
          // showing in the routing table (dry-run preview, health probe).
          unavailable?.engine
          ? {
              engine: unavailable.engine,
              ...(unavailable.model ? { model: unavailable.model } : {}),
              engineKind: "llm",
            }
          : {}),
      notices: process.notices ?? [],
      ...(unavailable ? { unavailable: { configKey: unavailable.configKey, reason: unavailable.reason } } : {}),
    });
  }
  if (plan.strategy.config.processes?.triage?.judgment?.enabled === true) {
    const judgmentUnavailable = unavailableByProcess.get("triage.judgment");
    rows.push({
      process: "triage.judgment",
      enabled: plan.triageJudgment !== null,
      ...(plan.triageJudgment
        ? {
            engine: plan.triageJudgment.engine,
            engineKind: plan.triageJudgment.kind,
            ...(plan.triageJudgment.kind === "llm" ? { model: plan.triageJudgment.connection.model } : {}),
          }
        : {}),
      notices: plan.triageJudgmentNotices ?? [],
      ...(judgmentUnavailable
        ? { unavailable: { configKey: judgmentUnavailable.configKey, reason: judgmentUnavailable.reason } }
        : {}),
    });
  }
  return rows;
}

function cloneAndFreeze<T>(value: T): Readonly<T> {
  const clone = structuredClone(value);
  const freeze = (item: unknown): void => {
    if (typeof item !== "object" || item === null || Object.isFrozen(item)) return;
    for (const child of Object.values(item)) freeze(child);
    Object.freeze(item);
  };
  freeze(clone);
  return clone;
}

/** Resolve every enabled process structurally before improve emits signals or performs I/O. */
export function resolveImprovePlan(
  name: string | undefined,
  config: AkmConfig,
  options: {
    repairValidationFailures?: boolean;
    env?: NodeJS.ProcessEnv;
    /**
     * Skip the "no improve process can run" throw below when every process
     * ends up disabled purely because its (otherwise-resolved) engine's
     * credential is unavailable in this environment, and return the plan
     * (with `engineUnavailable` populated) instead of throwing. A strategy
     * where at least one process never resolved an engine at all still
     * throws even with this set — that is the guard's original, pre-#957
     * condition (a genuinely unconfigured install), not the "credential
     * exists but isn't reachable from here" case this option exists for.
     * Callers that only inspect the plan structurally —
     * `runActiveImproveStrategyProbe` (#957) — need the credential-only case
     * to be inspectable rather than thrown, so the same total-no-op
     * detection the real run uses can also drive the health check's `fail`
     * status. Callers that act on the plan (`improve-cli.ts`, `improve.ts`)
     * leave this unset so a totally unusable strategy still aborts as it
     * always has.
     */
    allowAllDisabled?: boolean;
  } = {},
): ResolvedImprovePlan {
  const selected = resolveImproveStrategy(name, config);
  // D8 — gate autonomy BEFORE the plan is built, so every downstream consumer
  // (process enablement, LLM preflight, triage judgment) sees one already-safe
  // strategy rather than each having to re-ask whether autonomy is allowed.
  const { config: gatedStrategyConfig, gated } = applyAutonomyGate(selected.config, config);
  const strategy: SelectedStrategy = { name: selected.name, config: gatedStrategyConfig };
  return { ...buildImprovePlan(strategy, config, options), autonomyGated: gated };
}

/** Describe why a resolved-but-uncredentialed runner belongs in `engineUnavailable` (#957). */
function credentialUnavailableReason(engineName: string, status: { reason: string }): string {
  return `requires a credential that is not available in this process's environment (engine "${engineName}": ${status.reason})`;
}

function buildImprovePlan(
  strategy: SelectedStrategy,
  config: AkmConfig,
  options: { repairValidationFailures?: boolean; env?: NodeJS.ProcessEnv; allowAllDisabled?: boolean },
): Omit<ResolvedImprovePlan, "autonomyGated"> {
  const env = options.env ?? process.env;
  const processes = {} as Record<ImproveProcessName, ResolvedImproveProcess>;
  const engineUnavailable: EngineUnavailableProcess[] = [];
  // #957 round 2 — distinguishes "credential unavailable" (a working engine
  // whose secret isn't in this environment) from "no engine selected at all"
  // among the pushes below, so `allowAllDisabled` can bypass the ConfigError
  // only for the former. The latter is the guard's original, pre-#957
  // condition and must keep hard-aborting for every caller, including a
  // health probe with `allowAllDisabled` set — a totally unconfigured
  // install is not the credential-in-the-wrong-environment case this option
  // exists for.
  let anyEngineNotConfigured = false;
  for (const processName of Object.keys(IMPROVE_PROCESS_ENGINE_CAPABILITIES) as ImproveProcessName[]) {
    const sourceProcessConfig = strategy.config.processes?.[processName] ?? {};
    const enabled = sourceProcessConfig.enabled === true;
    let runner: ImproveLlmRunner | null = null;
    let notices: readonly Readonly<LoweringNotice>[] = [];
    if (IMPROVE_PROCESS_ENGINE_CAPABILITIES[processName] !== "llm" || !enabled) {
      processes[processName] = Object.freeze({ enabled, config: cloneAndFreeze(sourceProcessConfig), runner });
      continue;
    }
    // Validation itself is structural and always runs. Only its optional repair
    // step needs a model, so disabling repair must not create an LLM preflight.
    const skipsRepairEngine = processName === "validation" && options.repairValidationFailures === false;
    // #957: a resolved-but-uncredentialed runner is folded into the same
    // "no engine" branch below — set here so the shared push/continue block
    // can tell the two apart in its reason text.
    let credentialUnavailableMessage: string | undefined;
    // #800/#957 round 3 — the structurally resolved engine/model/contextLength
    // for the credential-unavailable case only, so a dry-run preview can read
    // what resolution decided (e.g. the consolidation chunk-size estimate)
    // without the runner ever carrying a credential-less connection forward.
    let credentialUnavailableRouting: { engine: string; model?: string; contextLength?: number } | undefined;
    if (!skipsRepairEngine) {
      const resolved = resolveImproveLlmExecution({
        config,
        profile: strategy.config,
        process: sourceProcessConfig,
        processName,
      });
      runner = resolved?.runner ?? null;
      notices = resolved?.notices ?? [];
      if (runner) {
        const credentialStatus = describeLlmCredentialAvailability(runner, env);
        if (!credentialStatus.available) {
          credentialUnavailableMessage = credentialUnavailableReason(runner.engine, credentialStatus);
          credentialUnavailableRouting = {
            engine: runner.engine,
            ...(runner.connection.model !== undefined ? { model: runner.connection.model } : {}),
            ...(runner.connection.contextLength !== undefined
              ? { contextLength: runner.connection.contextLength }
              : {}),
          };
          runner = null;
          notices = [];
        }
      }
    }
    if (!runner && !skipsRepairEngine) {
      const configKey = `improve.strategies.${strategy.name}.processes.${processName}.engine`;
      if (!credentialUnavailableMessage) anyEngineNotConfigured = true;
      engineUnavailable.push({
        process: processName,
        configKey,
        reason:
          credentialUnavailableMessage ??
          `requires an LLM engine that is not configured. Set defaults.llmEngine or ${configKey}`,
        ...credentialUnavailableRouting,
      });
      processes[processName] = Object.freeze({
        enabled: false,
        config: cloneAndFreeze({ ...sourceProcessConfig, enabled: false }),
        runner: null,
      });
      continue;
    }
    if (runner) runner = cloneAndFreeze(runner) as ImproveLlmRunner;
    processes[processName] = Object.freeze({
      enabled,
      config: cloneAndFreeze(sourceProcessConfig),
      runner,
      ...(notices.length > 0 ? { notices: cloneAndFreeze(notices) } : {}),
    });
  }

  if (
    engineUnavailable.length > 0 &&
    !Object.values(processes).some((process) => process.enabled) &&
    (!options.allowAllDisabled || anyEngineNotConfigured)
  ) {
    const names = engineUnavailable.map((item) => `"${item.process}"`).join(", ");
    throw new ConfigError(
      `No improve process can run: ${names} ${engineUnavailable.length === 1 ? "requires" : "require"} an LLM engine that is not configured. Set defaults.llmEngine, or the per-process engine key named for each.`,
      "LLM_NOT_CONFIGURED",
    );
  }

  const triage = strategy.config.processes?.triage;
  const judgmentEnabled = triage?.judgment?.enabled === true;
  const triageJudgmentResolution =
    processes.triage.enabled && judgmentEnabled
      ? resolveImproveExecution({
          config,
          profile: strategy.config,
          process: triage,
          current: triage.judgment,
          processName: "triage-judgment",
        })
      : null;
  let triageJudgment = triageJudgmentResolution?.runner ?? null;
  const effectiveJudgmentLlm = triage?.judgment?.llm ?? triage?.llm ?? strategy.config.llm;
  if (triageJudgment && triageJudgment.kind !== "llm" && effectiveJudgmentLlm) {
    throw new ConfigError(
      `Triage judgment engine "${triageJudgment.engine ?? "unknown"}" is an agent engine and cannot receive llm overrides.`,
      "INVALID_CONFIG_FILE",
    );
  }
  if (processes.triage.enabled && judgmentEnabled && !triageJudgment) {
    throw new ConfigError(
      `Enabled improve triage judgment requires an engine. Set defaults.llmEngine or improve.strategies.${strategy.name}.processes.triage.judgment.engine.`,
      "LLM_NOT_CONFIGURED",
    );
  }
  // #957: same credential-unavailable treatment as the main per-process loop
  // above — a triage judgment engine that resolves structurally but whose
  // credential (or, for an SDK judgment, its LLM fallback credential) is
  // unavailable in this process's environment is folded into
  // `engineUnavailable` under the reserved `"triage.judgment"` process name
  // instead of silently reaching dispatch with a doomed credential.
  if (triageJudgment) {
    const judgmentCredentialFields =
      triageJudgment.kind === "llm"
        ? {
            credential: triageJudgment.credential,
            apiKeyFile: triageJudgment.apiKeyFile,
            apiKeySecretRef: triageJudgment.apiKeySecretRef,
          }
        : triageJudgment.kind === "sdk"
          ? {
              credential: triageJudgment.fallbackCredential,
              apiKeyFile: triageJudgment.fallbackApiKeyFile,
              apiKeySecretRef: triageJudgment.fallbackApiKeySecretRef,
            }
          : undefined;
    if (judgmentCredentialFields) {
      const credentialStatus = describeLlmCredentialAvailability(judgmentCredentialFields, env);
      if (!credentialStatus.available) {
        engineUnavailable.push({
          process: "triage.judgment",
          configKey: `improve.strategies.${strategy.name}.processes.triage.judgment.engine`,
          reason: credentialUnavailableReason(triageJudgment.engine, credentialStatus),
        });
        triageJudgment = null;
      }
    }
  }
  const frozenProcesses = Object.freeze(processes);
  const frozenStrategy: SelectedStrategy = Object.freeze({
    name: strategy.name,
    config: cloneAndFreeze({
      ...strategy.config,
      processes: Object.fromEntries(
        Object.entries(frozenProcesses).map(([name, process]) => [name, process.config]),
      ) as NonNullable<ImproveProfileConfig["processes"]>,
    }),
  });
  return Object.freeze({
    config: cloneAndFreeze(config),
    strategy: frozenStrategy,
    processes: frozenProcesses,
    triageJudgment: triageJudgment ? cloneAndFreeze(triageJudgment) : null,
    ...(triageJudgmentResolution?.notices.length
      ? { triageJudgmentNotices: cloneAndFreeze(triageJudgmentResolution.notices) }
      : {}),
    engineUnavailable: Object.freeze(engineUnavailable),
  });
}
