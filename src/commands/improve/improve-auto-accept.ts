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

import type { AkmConfig } from "../../core/config";
import { loadConfig } from "../../core/config";
import { appendEvent, type EventsContext } from "../../core/events";
import { promoteProposal } from "../../core/proposals";
import { info, warn } from "../../core/warn";

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
   * Per-process minimum confidence floor (integer 0-100).
   * The effective threshold is `Math.max(globalThreshold, minimumThreshold ?? 0)`.
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
  const result: AutoAcceptGateResult = { promoted: [], skipped: [], failed: [] };

  // --- Guard: gate is disabled or context is incomplete ---
  if (cfg.dryRun || cfg.globalThreshold === undefined || !cfg.stashDir) {
    result.skipped = candidates.map((c) => c.proposalId);
    return result;
  }

  const effectiveThreshold = Math.max(cfg.globalThreshold, cfg.minimumThreshold ?? 0) / 100;

  const resolvedConfig: AkmConfig = typeof cfg.config === "function" ? cfg.config() : cfg.config;

  for (const candidate of candidates) {
    const { proposalId, confidence } = candidate;

    if (confidence === undefined || confidence < effectiveThreshold) {
      result.skipped.push(proposalId);
      continue;
    }

    try {
      const promotion = await promoteFn(cfg.stashDir, resolvedConfig, proposalId, {}, undefined);
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
          },
        },
        cfg.eventsCtx ?? {},
      );
      info(
        `[improve] auto-accepted ${promotion.ref} (${cfg.phase}; confidence=${confidence.toFixed(2)} >= threshold=${effectiveThreshold.toFixed(2)})`,
      );
      result.promoted.push(proposalId);
    } catch (err) {
      warn(
        `[improve] ${cfg.phase} auto-accept failed for ${proposalId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      result.failed.push(proposalId);
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
 */
export function makeGateConfig(
  phase: string,
  shared: {
    globalThreshold: number | undefined;
    dryRun: boolean;
    stashDir: string | undefined;
    config: AkmConfig | (() => AkmConfig);
    eventsCtx: EventsContext | undefined;
  },
  overrides: { minimumThreshold?: number } = {},
): AutoAcceptGateConfig {
  return {
    phase,
    globalThreshold: shared.globalThreshold,
    dryRun: shared.dryRun,
    stashDir: shared.stashDir,
    config: shared.config,
    eventsCtx: shared.eventsCtx,
    ...overrides,
  };
}

export { loadConfig };
