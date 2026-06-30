// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Shared auto-accept gate for all improve pipeline phases.
 *
 * Each phase (reflect, extract, distill, consolidate) produces proposals.
 * High-confidence proposals can be promoted immediately rather than waiting
 * for manual review. This module provides a single, tested abstraction so
 * every phase uses the same gate logic, emits the same event shape, and
 * deviates only where explicitly justified (e.g. consolidate's higher
 * per-process confidence floor for destructive memory ops).
 *
 * Usage pattern — build one config per phase before the phase loop, then:
 *
 *   const result = await runAutoAcceptGate(candidates, cfg);
 *   // result.promoted / .skipped / .failed are available for logging/metrics
 *
 * The gate is intentionally a pure function of its inputs plus the
 * injectable `promoteFn` — making it straightforward to unit-test without
 * touching the filesystem.
 */

import type { AkmConfig } from "../../core/config/config";
import { loadConfig } from "../../core/config/config";
import { appendEvent, type EventsContext } from "../../core/events";
import { getPhaseThreshold, withStateDb } from "../../core/state-db";
import { info, warn } from "../../core/warn";
import type { Proposal } from "../proposal/validators/proposals";
import { getProposal, promoteProposal, recordGateDecision } from "../proposal/validators/proposals";

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AutoAcceptGateConfig {
  /** Human-readable phase label used in log messages and event metadata. */
  phase: string;
  /**
   * Global threshold from `options.autoAccept` (integer 0-100).
   * `undefined` disables the gate entirely — every candidate lands in `skipped`.
   */
  globalThreshold: number | undefined;
  /**
   * WS-4: Per-phase threshold from state.db (integer 0-100).
   * When set, overrides `globalThreshold` for this phase (still floored by
   * `minimumThreshold`). Set by `makeGateConfig` when it reads the persisted
   * value from the state database.
   */
  phaseThreshold?: number;
  /**
   * Per-process minimum confidence floor (integer 0-100).
   * The effective threshold is `Math.max(resolvedThreshold, minimumThreshold ?? 0)`.
   * Use this to prevent a permissive global setting from auto-accepting
   * high-risk ops (e.g. consolidate destructive memory operations need ≥95).
   */
  minimumThreshold?: number;
  /** Gate is a complete no-op when true. */
  dryRun: boolean;
  /** Resolved primary stash root. Gate is a no-op when undefined. */
  stashDir: string | undefined;
  /** Loaded config or a lazy loader — called at most once per gate invocation. */
  config: AkmConfig | (() => AkmConfig);
  /** Events context for appending the "promoted" event on each acceptance. */
  eventsCtx: EventsContext | undefined;
  /**
   * WS-4 exploration budget: when set, at most this many candidates per run
   * are promoted regardless of confidence (logged eligibilitySource="exploration",
   * NOT counted toward auto-tune calibration). Prevents the gate converging to
   * pure exploitation and shutting down novelty / Gap-3/4 throughput.
   *
   * Computed from `config.improve.exploration.budgetFraction × candidates.length`
   * by `makeGateConfig`; callers may also set it directly for testing.
   */
  explorationBudgetCount?: number;
}

export interface ProposalCandidate {
  /** Proposal ID passed to `promoteProposal`. */
  proposalId: string;
  /**
   * Confidence value in [0, 1].
   * `undefined` means the source did not emit a score — the candidate is
   * unconditionally placed in `skipped`, never attempted for promotion.
   */
  confidence: number | undefined;
}

export interface AutoAcceptGateResult {
  /** Proposal IDs that were successfully promoted. */
  promoted: string[];
  /** Proposal IDs skipped (no confidence, or confidence below threshold). */
  skipped: string[];
  /** Proposal IDs where `promoteProposal` threw — warning already emitted. */
  failed: string[];
  /**
   * Proposals skipped because a previous unchanged gate attempt already stamped
   * `gateDecision.outcome=auto-rejected`. These are not new validation attempts.
   */
  suppressed: string[];
  /**
   * Why each failed proposal was rejected, bucketed by reason (e.g. a
   * `validateProposal` finding kind like `description-quality`, or
   * `promote-error` for non-validation throws). Turns the previously-blind
   * "passed confidence but failed validation" leak into a measured signal
   * (surfaced via the gate decision + health `autoAccept.failedByReason`).
   */
  failedByReason: Record<string, number>;
  /** Failed promotion attempts grouped by proposal source, when available. */
  failedBySource: Record<string, number>;
}

/**
 * Derive a stable, low-cardinality reason bucket from an auto-accept promotion
 * error. `promoteProposal` throws a `validateProposal` report formatted as
 * `[kind] message` lines; we extract the first finding kind. Non-validation
 * throws collapse to `promote-error`.
 */
function classifyPromoteFailure(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const finding = /\[([a-z][a-z0-9-]*)\]/i.exec(message);
  if (finding) return `validation:${finding[1]}`;
  if (/not pending/i.test(message)) return "not-pending";
  if (/unknown asset type/i.test(message)) return "unknown-type";
  return "promote-error";
}

// ---------------------------------------------------------------------------
// Gate implementation
// ---------------------------------------------------------------------------

/**
 * Attempt to auto-accept each candidate proposal whose confidence meets the
 * effective threshold. Safe to call unconditionally — returns all-empty when
 * the gate is disabled or the run is a dry-run.
 *
 * @param candidates  Proposals to evaluate, each with an optional confidence.
 * @param cfg         Gate configuration (phase label, thresholds, context).
 * @param promoteFn   Injectable override for `promoteProposal` (test seam).
 */
export async function runAutoAcceptGate(
  candidates: ProposalCandidate[],
  cfg: AutoAcceptGateConfig,
  promoteFn: typeof promoteProposal = promoteProposal,
): Promise<AutoAcceptGateResult> {
  const result: AutoAcceptGateResult = {
    promoted: [],
    skipped: [],
    failed: [],
    suppressed: [],
    failedByReason: {},
    failedBySource: {},
  };

  // --- Guard: gate is disabled or context is incomplete ---
  if (cfg.dryRun || cfg.globalThreshold === undefined || !cfg.stashDir) {
    result.skipped = candidates.map((c) => c.proposalId);
    return result;
  }

  // WS-4: per-phase threshold from state.db overrides the global threshold.
  // The per-phase value is populated by makeGateConfig when a stateDbPath is
  // available; callers that don't pass it get the global threshold unchanged.
  const resolvedThreshold = cfg.phaseThreshold ?? cfg.globalThreshold;
  const effectiveThreshold = Math.max(resolvedThreshold, cfg.minimumThreshold ?? 0) / 100;

  // WS-4: Exploration budget — promote at most N candidates regardless of
  // confidence to prevent the gate converging to pure exploitation.
  // Exploration candidates are chosen from the LOWEST-confidence eligible set
  // (i.e. those that would be deferred) so the budget truly samples the low-
  // confidence tail and is meaningfully distinct from normal auto-accept.
  // Promoted exploration proposals are logged with eligibilitySource="exploration".
  const explorationBudget = cfg.explorationBudgetCount ?? 0;
  let explorationRemaining = explorationBudget;

  const resolvedConfig: AkmConfig = typeof cfg.config === "function" ? cfg.config() : cfg.config;
  const gateLabel = `improve:${cfg.phase}`;

  // #577: stamp the gate's verdict onto each proposal so `akm proposal show`
  // can explain why a proposal is pending (e.g. "deferred: below-threshold,
  // 0.72 < 0.90"). Best-effort — a recording failure must never abort the gate.
  const stamp = (proposalId: string, decision: Parameters<typeof recordGateDecision>[2]): void => {
    try {
      recordGateDecision(cfg.stashDir as string, proposalId, decision);
    } catch (err) {
      warn(
        `[improve] ${cfg.phase} failed to record gate decision for ${proposalId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  };

  for (const candidate of candidates) {
    const { proposalId, confidence } = candidate;
    let currentProposal: Proposal | undefined;
    try {
      currentProposal = cfg.stashDir ? getProposal(cfg.stashDir, proposalId) : undefined;
    } catch {
      currentProposal = undefined;
    }
    const currentContentHash = currentProposal ? await sha256Hex(currentProposal.payload.content) : undefined;

    // Determine if this candidate is exploration-eligible: below-threshold
    // (would normally be deferred) but with a valid confidence score and budget
    // remaining. No-confidence candidates are never exploration-promoted.
    const belowThreshold = confidence === undefined || confidence < effectiveThreshold;
    const isExploration = belowThreshold && confidence !== undefined && explorationRemaining > 0;

    if (belowThreshold && !isExploration) {
      stamp(proposalId, {
        outcome: "deferred",
        reason: confidence === undefined ? "no-confidence" : "below-threshold",
        ...(confidence !== undefined ? { confidence } : {}),
        thresholds: { autoAccept: effectiveThreshold },
        gate: gateLabel,
      });
      result.skipped.push(proposalId);
      continue;
    }

    // Either above-threshold (normal auto-accept) or exploration-budget promoted.
    if (isExploration) explorationRemaining -= 1;
    const promoteReason = isExploration ? "exploration-budget" : "above-threshold";

    if (
      currentProposal?.gateDecision?.outcome === "auto-rejected" &&
      currentProposal.gateDecision.contentHash !== undefined &&
      currentProposal.gateDecision.contentHash === currentContentHash
    ) {
      result.suppressed.push(proposalId);
      continue;
    }

    try {
      const promotion = await promoteFn(cfg.stashDir, resolvedConfig, proposalId, {}, undefined);
      stamp(promotion.proposal.id, {
        outcome: "auto-accepted",
        reason: promoteReason,
        confidence,
        thresholds: { autoAccept: effectiveThreshold },
        ...(currentContentHash !== undefined ? { contentHash: currentContentHash } : {}),
        gate: gateLabel,
      });
      // Resolve the eligibilitySource: exploration-promoted proposals get
      // eligibilitySource="exploration" (WS-4); normal auto-accepts carry
      // whatever the proposal was tagged with at selection time.
      const resolvedEligibilitySource: string | undefined = isExploration
        ? "exploration"
        : promotion.proposal.eligibilitySource;
      appendEvent(
        {
          eventType: "promoted",
          ref: promotion.ref,
          metadata: {
            proposalId: promotion.proposal.id,
            source: promotion.proposal.source,
            ...(promotion.proposal.sourceRun !== undefined ? { sourceRun: promotion.proposal.sourceRun } : {}),
            assetPath: promotion.assetPath,
            autoAccept: true,
            confidence,
            threshold: effectiveThreshold,
            phase: cfg.phase,
            // Attribution tagging: carry the eligibility lane from the proposal
            // record onto the auto-accept promoted event so the lane survives to
            // accept time even when promotion happens in a later run.
            ...(resolvedEligibilitySource !== undefined ? { eligibilitySource: resolvedEligibilitySource } : {}),
            // WS-4: mark exploration promotions so health/telemetry can
            // distinguish them from calibration-signal promotions.
            ...(isExploration ? { explorationBudget: true } : {}),
          },
        },
        cfg.eventsCtx ?? {},
      );
      if (isExploration) {
        info(
          `[improve] exploration-accepted ${promotion.ref} (${cfg.phase}; confidence=${(confidence as number).toFixed(2)}; budgetRemaining=${explorationRemaining})`,
        );
      } else {
        info(
          `[improve] auto-accepted ${promotion.ref} (${cfg.phase}; confidence=${(confidence as number).toFixed(2)} >= threshold=${effectiveThreshold.toFixed(2)})`,
        );
      }
      result.promoted.push(proposalId);
    } catch (err) {
      const reason = classifyPromoteFailure(err);
      warn(
        `[improve] ${cfg.phase} auto-accept failed for ${proposalId} (${reason}): ${err instanceof Error ? err.message : String(err)}`,
      );
      result.failed.push(proposalId);
      result.failedByReason[reason] = (result.failedByReason[reason] ?? 0) + 1;
      // Record WHY on the proposal so `akm proposal show` explains the rejection
      // and the leak is no longer blind. Best-effort.
      stamp(proposalId, {
        outcome: "auto-rejected",
        reason,
        confidence,
        thresholds: { autoAccept: effectiveThreshold },
        ...(currentContentHash !== undefined ? { contentHash: currentContentHash } : {}),
        gate: gateLabel,
      });
      // If exploration budget was consumed but promotion failed, restore the slot
      // so the budget isn't exhausted on errors.
      if (isExploration) explorationRemaining += 1;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Confidence resolvers
// ---------------------------------------------------------------------------

/**
 * Read the confidence value for an extract proposal.
 * Extract stores confidence at `payload.frontmatter.confidence` (set by
 * extract.ts when the LLM response is parsed), not at the top-level field.
 */
export function resolveExtractConfidence(proposal: {
  payload: { frontmatter?: unknown };
  confidence?: number;
}): number | undefined {
  const fm = proposal.payload.frontmatter as Record<string, unknown> | undefined;
  const fmConf = fm?.confidence;
  if (typeof fmConf === "number") return fmConf;
  // Fall back to top-level in case a future extract version normalises the path
  if (typeof proposal.confidence === "number") return proposal.confidence;
  return undefined;
}

// ---------------------------------------------------------------------------
// Config builder helpers
// ---------------------------------------------------------------------------

/**
 * Build a gate config for a phase, inheriting global settings from the
 * improve options. Callers supply only the phase-specific overrides.
 *
 * WS-4 additions:
 * - When `shared.stateDbPath` is provided, reads the persisted per-phase
 *   threshold from `improve_gate_thresholds` (Migration 012). The phase
 *   value overrides `globalThreshold` but is still floored by
 *   `minimumThreshold`. Falls back to `globalThreshold` when no row exists.
 * - Computes `explorationBudgetCount` from
 *   `config.improve.exploration.budgetFraction × candidateCount` when the
 *   exploration budget is enabled. Defaults to 0 (no exploration).
 */
export function makeGateConfig(
  phase: string,
  shared: {
    globalThreshold: number | undefined;
    dryRun: boolean;
    stashDir: string | undefined;
    config: AkmConfig | (() => AkmConfig);
    eventsCtx: EventsContext | undefined;
    /** WS-4: path to state.db for reading per-phase threshold. */
    stateDbPath?: string;
    /**
     * WS-4: number of candidates this gate will evaluate (used to compute the
     * exploration budget count from the configured fraction).
     */
    candidateCount?: number;
  },
  overrides: { minimumThreshold?: number } = {},
): AutoAcceptGateConfig {
  // WS-4: read per-phase threshold from state.db when available.
  let phaseThreshold: number | undefined;
  if (shared.stateDbPath && shared.globalThreshold !== undefined) {
    try {
      phaseThreshold = withStateDb((db) => getPhaseThreshold(db, phase) ?? undefined, {
        path: shared.stateDbPath,
      });
    } catch {
      // DB unavailable — fall back to globalThreshold silently.
    }
  }

  // WS-4: compute exploration budget count from config fraction × candidateCount.
  let explorationBudgetCount: number | undefined;
  const resolvedConfig: AkmConfig = typeof shared.config === "function" ? shared.config() : shared.config;
  const explorationCfg = resolvedConfig.improve?.exploration;
  if (explorationCfg?.enabled && shared.candidateCount !== undefined && shared.candidateCount > 0) {
    const fraction = Math.min(1, Math.max(0, explorationCfg.budgetFraction ?? 0.05));
    explorationBudgetCount = Math.max(0, Math.floor(fraction * shared.candidateCount));
  }

  return {
    phase,
    globalThreshold: shared.globalThreshold,
    ...(phaseThreshold !== undefined ? { phaseThreshold } : {}),
    dryRun: shared.dryRun,
    stashDir: shared.stashDir,
    config: shared.config,
    eventsCtx: shared.eventsCtx,
    ...(explorationBudgetCount !== undefined && explorationBudgetCount > 0 ? { explorationBudgetCount } : {}),
    ...overrides,
  };
}

export { loadConfig };
