// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Deterministic proposal-drain engine (Proposal-Queue Triage, Phase 1).
 *
 * Drains the *standing pending backlog* of proposals using a deterministic,
 * no-LLM policy keyed on generator (proposal `source`) and diff size. This is
 * the engine behind `akm proposal drain` and (later) the `triage` improve
 * pre-pass.
 *
 * Design (see docs/technical/proposal-triage-implementation-plan.md):
 *   - Reuses `listProposals` (no source filter — generator filtering is
 *     in-memory) and the `akmProposalAccept` / `akmProposalReject` wrappers from
 *     `proposal.ts` so the standard `promoted` / `rejected` events are emitted.
 *     It deliberately does NOT use `runAutoAcceptGate`, which is confidence-gated.
 *   - Backlog-only: `excludeIds` removes this-run's fresh proposals so triage
 *     never re-adjudicates the per-run auto-accept gate's decisions (decision #2).
 *   - Hard guardrails enforced in code: a `maxAccepts` ceiling checked *before*
 *     the promote loop (remainder → `skippedByCap`); `maxDiffLines` defers large
 *     accepts; `applyMode: "queue"` (the safe default) never promotes (stage
 *     only); `rejectEmpty` rejects empty / near-empty diffs.
 *   - The judgment tier is Phase 3. This engine accepts a `judgment` runner but
 *     leaves deferred items in the `deferred[]` list unprocessed.
 *
 * The promote / reject functions are injectable (mirrors
 * `improve-auto-accept.ts`) so tests can run the full engine without touching
 * the filesystem.
 */

import type { EventsContext } from "../core/events";
import { appendEvent } from "../core/events";
import { listProposals, type Proposal } from "../core/proposals";
import { info, warn } from "../core/warn";
import type { RunnerSpec } from "../integrations/agent/runner";
import { akmProposalAccept, akmProposalReject } from "./proposal";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single accept rule within a {@link DrainPolicy}. */
export interface DrainAcceptRule {
  /** Generator (proposal `source`) this rule matches, e.g. "extract". */
  generator: string;
  /** Accept only when the proposed content is <= this many lines. */
  maxDiffLines?: number;
  /** Accept only when the proposed content has >= this many body lines. */
  minContentLines?: number;
}

/** A deterministic triage policy: which generators auto-accept / defer. */
export interface DrainPolicy {
  name: string;
  /** Generators (with optional size bounds) whose proposals auto-accept. */
  accept: DrainAcceptRule[];
  /** Reject proposals whose diff is empty / near-empty. */
  rejectEmpty: boolean;
  /**
   * Generators whose mid-band / ambiguous items are deferred to the judgment
   * tier (Phase 3). For Phase 1 these simply land in `deferred[]` unprocessed.
   */
  defer: string[];
}

export type DrainDeferReason = "mid-band" | "possible-dup" | "possible-contradiction";

export interface DrainOptions {
  stashDir: string;
  policy: DrainPolicy;
  /** "queue" (default, safe) stages only and never promotes; "promote" accepts. */
  applyMode: "queue" | "promote";
  /** Hard per-run accept ceiling, enforced before the promote loop. */
  maxAccepts: number;
  /** When true, performs zero writes (no accept / reject). */
  dryRun: boolean;
  /** Fresh-this-run proposal ids to exclude (decision #2). */
  excludeIds?: Set<string>;
  /**
   * Optional global diff-line bound. Accepts whose content exceeds this are
   * deferred ("mid-band"), never promoted. Applied in addition to any per-rule
   * `maxDiffLines`.
   */
  maxDiffLines?: number;
  /** Judgment tier (Phase 3). Accepted but unused in Phase 1. */
  judgment?: RunnerSpec | null;
  eventsCtx?: EventsContext;
}

export interface DrainResult {
  /** Proposal ids promoted (accepted) this run. Empty in queue / dry-run mode. */
  promoted: string[];
  /** Proposal ids rejected (empty diffs) this run. Empty in dry-run mode. */
  rejected: string[];
  /** Proposals left for the judgment tier, with the reason they were deferred. */
  deferred: Array<{ id: string; reason: DrainDeferReason }>;
  /** Accept candidates dropped because the `maxAccepts` ceiling was reached. */
  skippedByCap: string[];
}

// Injectable test seams (mirrors improve-auto-accept.ts's promoteFn override).
export type PromoteFn = typeof akmProposalAccept;
export type RejectFn = typeof akmProposalReject;

// ---------------------------------------------------------------------------
// Content helpers
// ---------------------------------------------------------------------------

/** Strip a leading YAML frontmatter block (`---\n...\n---`) from content. */
function stripFrontmatter(content: string): string {
  if (!content.startsWith("---")) return content;
  const end = content.indexOf("\n---", 3);
  if (end === -1) return content;
  const after = content.indexOf("\n", end + 1);
  return after === -1 ? "" : content.slice(after + 1);
}

/** Number of non-empty body lines (frontmatter excluded). */
export function contentBodyLineCount(content: string): number {
  return stripFrontmatter(content)
    .split("\n")
    .filter((line) => line.trim().length > 0).length;
}

/** Total line count of the proposed content (matches the bulk-accept measure). */
export function contentLineCount(content: string): number {
  return content.split("\n").length;
}

/** An empty / near-empty diff has no meaningful body content. */
export function isEmptyDiff(proposal: Proposal): boolean {
  const content = proposal.payload.content ?? "";
  if (content.trim().length === 0) return true;
  return contentBodyLineCount(content) === 0;
}

/**
 * Decide a deterministic verdict for a single backlog proposal under `policy`.
 * Returns `null` when no rule applies (the proposal is left pending untouched).
 */
export function classifyProposal(
  proposal: Proposal,
  policy: DrainPolicy,
  maxDiffLines?: number,
):
  | { verdict: "accept" }
  | { verdict: "reject"; reason: string }
  | { verdict: "defer"; reason: DrainDeferReason }
  | null {
  const content = proposal.payload.content ?? "";

  // Empty / near-empty diffs reject first (the reject-empty floor).
  if (policy.rejectEmpty && isEmptyDiff(proposal)) {
    return { verdict: "reject", reason: "empty diff" };
  }

  const rule = policy.accept.find((r) => r.generator === proposal.source);
  if (rule) {
    const lines = contentLineCount(content);
    const body = contentBodyLineCount(content);
    // Per-rule and global diff bounds defer large accepts (no silent rewrites).
    const effectiveMax = Math.min(
      rule.maxDiffLines ?? Number.POSITIVE_INFINITY,
      maxDiffLines ?? Number.POSITIVE_INFINITY,
    );
    if (lines > effectiveMax) {
      return { verdict: "defer", reason: "mid-band" };
    }
    if (rule.minContentLines !== undefined && body < rule.minContentLines) {
      // Too little content to confidently auto-accept — leave for judgment.
      return { verdict: "defer", reason: "mid-band" };
    }
    return { verdict: "accept" };
  }

  if (policy.defer.includes(proposal.source)) {
    return { verdict: "defer", reason: deferReasonForSource(proposal.source) };
  }

  // No matching rule — leave pending, untouched.
  return null;
}

function deferReasonForSource(source: string): DrainDeferReason {
  if (source === "distill") return "possible-dup";
  if (source === "consolidate") return "mid-band";
  return "mid-band";
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

/**
 * Drain the standing pending backlog under a deterministic policy.
 *
 * @param opts       Drain options (policy, applyMode, ceilings, dry-run).
 * @param promoteFn  Injectable override for `akmProposalAccept` (test seam).
 * @param rejectFn   Injectable override for `akmProposalReject` (test seam).
 */
export async function drainProposals(
  opts: DrainOptions,
  promoteFn: PromoteFn = akmProposalAccept,
  rejectFn: RejectFn = akmProposalReject,
): Promise<DrainResult> {
  const result: DrainResult = { promoted: [], rejected: [], deferred: [], skippedByCap: [] };

  const exclude = opts.excludeIds ?? new Set<string>();
  const pending = listProposals(opts.stashDir, { status: "pending" }).filter((p) => !exclude.has(p.id));

  // First, classify every proposal deterministically.
  const acceptIds: string[] = [];
  const rejectTargets: Array<{ id: string; reason: string }> = [];

  for (const proposal of pending) {
    const decision = classifyProposal(proposal, opts.policy, opts.maxDiffLines);
    if (decision === null) continue;
    if (decision.verdict === "accept") {
      acceptIds.push(proposal.id);
    } else if (decision.verdict === "reject") {
      rejectTargets.push({ id: proposal.id, reason: decision.reason });
    } else {
      result.deferred.push({ id: proposal.id, reason: decision.reason });
    }
  }

  // --- Reject empties (independent of the accept ceiling / applyMode) ---
  for (const target of rejectTargets) {
    if (opts.dryRun) {
      result.rejected.push(target.id);
      continue;
    }
    try {
      rejectFn({ stashDir: opts.stashDir, id: target.id, reason: target.reason });
      result.rejected.push(target.id);
    } catch (err) {
      warn(`[triage] reject failed for ${target.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // --- Accept ceiling: enforced BEFORE the promote loop ---
  const withinCap = acceptIds.slice(0, Math.max(0, opts.maxAccepts));
  result.skippedByCap = acceptIds.slice(Math.max(0, opts.maxAccepts));
  if (result.skippedByCap.length > 0) {
    info(
      `[triage] accept ceiling reached: ${withinCap.length} promoted, ${result.skippedByCap.length} skipped by cap (maxAccepts=${opts.maxAccepts})`,
    );
  }

  // --- Promotion gate: applyMode "queue" never promotes (stage only) ---
  if (opts.applyMode === "promote" && !opts.dryRun) {
    info(`[triage] auto-promote active: ${withinCap.length} accepts allowed this run`);
    for (const id of withinCap) {
      try {
        await promoteFn({ stashDir: opts.stashDir, id });
        result.promoted.push(id);
      } catch (err) {
        warn(`[triage] promote failed for ${id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } else if (opts.applyMode === "promote" && opts.dryRun) {
    // Dry-run promote: report what would be promoted without writing.
    result.promoted.push(...withinCap);
  }
  // applyMode "queue": leave accept candidates pending (staged). No promotion.

  emitDrainEvents(opts, result);

  return result;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

function emitDrainEvents(opts: DrainOptions, result: DrainResult): void {
  const deferredByReason: Record<string, number> = {};
  for (const d of result.deferred) {
    deferredByReason[d.reason] = (deferredByReason[d.reason] ?? 0) + 1;
  }

  appendEvent(
    {
      eventType: "triage_drained",
      metadata: {
        promoted: result.promoted.length,
        rejected: result.rejected.length,
        deferredByReason,
        skippedByCap: result.skippedByCap.length,
        policy: opts.policy.name,
        applyMode: opts.applyMode,
        ...(opts.dryRun ? { dryRun: true } : {}),
      },
    },
    opts.eventsCtx ?? {},
  );

  // Surface "enabled, but no judgment runner" so a backlog of deferred items
  // never silently looks like full success (Phase 3 will consume these).
  if (result.deferred.length > 0 && !opts.judgment) {
    appendEvent(
      {
        eventType: "triage_deferred",
        metadata: {
          deferred: result.deferred.length,
          deferredByReason,
          reason: "no judgment runner configured",
        },
      },
      opts.eventsCtx ?? {},
    );
  }
}
