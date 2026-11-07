// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { Proposal, ProposalQueue, WriteResult } from "./types";

export interface ReviewQueue extends ProposalQueue {
  fullCount?: number;
  backlog?: Array<{ source: string; underDay: number; underWeek: number; older: number; unknown: number }>;
}
export interface ReviewProposal extends Proposal {
  createdAt?: string;
  sourceRun?: string;
  decider?: string | null;
  gateDecision?: { outcome: string; reason?: string } | null;
  proposedTarget?: { source: string; root: string } | null;
}
export const ageBands = {
  underDay: "Under 1 day",
  underWeek: "1–7 days",
  older: "7+ days",
  unknown: "No recorded age",
};
export const rejectionChoices = ["Wrong", "Stale", "Duplicate", "Style", "Other"];
/** A concept's canonical parent, not a claim about its physical filesystem path. */
export function conceptLocation(ref: string): string {
  const bundle = ref.indexOf("//"),
    last = ref.lastIndexOf("/");
  return last > bundle + 1 ? ref.slice(0, last) : bundle >= 0 ? ref.slice(0, bundle + 2) : ref;
}
export function rejectionReason(choice: string, details: string): string {
  return [choice, details.trim()].filter(Boolean).join(": ");
}
export function rejectionError(choice: string, details: string): string {
  if (!details.trim() && (!choice || choice === "Other"))
    return "Choose a reason or write details. Details are required for Other.";
  if (rejectionReason(choice, details).length > 2000)
    return "The combined rejection reason must be at most 2000 characters.";
  return "";
}
export function proposalHref(id: string, query: URLSearchParams): string {
  const params = new URLSearchParams(query);
  params.delete("id");
  return `/review${id ? `/${encodeURIComponent(id)}` : ""}${params.size ? `?${params}` : ""}`;
}
/** Only in-app analytics locations can be an analytics return destination. */
export function activityReturn(value: string | null): string | null {
  return value && /^\/activity\/(?:improve|overview)(?:\?|$)/.test(value) ? value : null;
}
export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
export function rows(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(record) : [];
}
export function text(value: unknown, fallback = "Not recorded"): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : fallback;
}
export function commitOutcome(value: unknown): string {
  const commit = record(value);
  return typeof commit.sha === "string"
    ? `Committed ${commit.sha.slice(0, 8)}. Push status not reported.`
    : "No Git commit reported.";
}
/** "1 finding", "2 findings". */
export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}
/** The text cut to `max` characters with an ellipsis when it is longer. */
export function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value;
}

// ── Deciding and moving on ───────────────────────────────────────────────────────────────────────────────────────

/** What a decision attempt came to: nothing written, or written (with the refresh that followed, which may have failed). */
export type DecisionOutcome<T> =
  | { status: "failed"; error: string }
  | { status: "decided"; result: T; refreshError?: string };

/**
 * Run a decision's write, then the refresh of what it changed. A write that fails changed nothing: the caller keeps the
 * proposal and the reviewer's input. A write that succeeded and a refresh that failed is a recorded decision: the caller
 * must not invite the same decision again.
 */
export async function settleDecision<T>(
  write: () => Promise<T>,
  refresh: (result: T) => Promise<void>,
): Promise<DecisionOutcome<T>> {
  let result: T;
  try {
    result = await write();
  } catch (e) {
    return { status: "failed", error: errorMessage(e) };
  }
  try {
    await refresh(result);
    return { status: "decided", result };
  } catch (e) {
    return { status: "decided", result, refreshError: errorMessage(e) };
  }
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The proposal to review after `from` was decided, in the queue's own order. `order` is the ids as shown before the
 * decision, `decided` the ids that left the pending queue, `reloaded` the queue as fetched afterwards (the fetch is
 * limited, so it can hold proposals `order` never showed). First choice is the next proposal after `from` that is
 * still pending; past the end of what was shown, the first proposal the reload added; then, wrapping, the first
 * remaining one of `order`. "" means no proposal remains in this queue.
 */
export function nextAfterDecision(
  order: string[],
  decided: Iterable<string>,
  from: string,
  reloaded: string[],
): string {
  const gone = new Set(decided);
  const still = new Set(reloaded);
  const left = (id: string) => !gone.has(id) && still.has(id);
  const at = order.indexOf(from);
  const after = order.slice(at + 1).find(left);
  if (after) return after;
  const shown = new Set(order);
  const added = reloaded.find((id) => !shown.has(id) && !gone.has(id));
  if (added) return added;
  return order.slice(0, Math.max(at, 0)).find(left) ?? reloaded.find((id) => !gone.has(id)) ?? "";
}

/**
 * `queue` without the decided proposals, its counts moved with them, so rows, counts and progress change in one step
 * before the reload confirms them.
 */
export function withoutDecided(queue: ReviewQueue, decided: Iterable<string>): ReviewQueue {
  const gone = new Set(decided);
  const removed = queue.proposals.filter((p) => gone.has(p.id));
  const bySource = { ...queue.bySource };
  for (const p of removed) bySource[p.source] = Math.max(0, (bySource[p.source] ?? 0) - 1);
  return {
    ...queue,
    proposals: queue.proposals.filter((p) => !gone.has(p.id)),
    totalCount: Math.max(0, queue.totalCount - removed.length),
    ...(queue.fullCount === undefined ? {} : { fullCount: Math.max(0, queue.fullCount - removed.length) }),
    bySource,
  };
}

/**
 * The queue is finished only when no pending proposal matches the filters. A fetch holds at most its limit, so an empty
 * list with a positive `totalCount` is a queue to refill, not a finished one.
 */
export function queueState(queue: Pick<ProposalQueue, "proposals" | "totalCount">): "finished" | "refill" | "open" {
  if (queue.proposals.length > 0) return "open";
  return queue.totalCount > 0 ? "refill" : "finished";
}

/** What a batch left: the ids it decided, the failures with their reasons, and the selection that remains (the failures). */
export interface BatchOutcome {
  done: string[];
  failed: Array<{ id: string; ref?: string; error: string; code?: string }>;
  selected: string[];
}
/** An id the result does not mention was not reported decided, so it stays selected as a failure. */
export function batchOutcome(ids: string[], result: Pick<WriteResult, "results">): BatchOutcome {
  const byId = new Map((result.results ?? []).map((r) => [r.id, r]));
  const done: string[] = [];
  const failed: BatchOutcome["failed"] = [];
  for (const id of ids) {
    const r = byId.get(id);
    if (r?.ok) done.push(id);
    else
      failed.push({
        id,
        ...(r?.ref ? { ref: r.ref } : {}),
        error: r?.error ?? "The result did not report this proposal.",
        ...(r?.code ? { code: r.code } : {}),
      });
  }
  return { done, failed, selected: failed.map((f) => f.id) };
}

/** How long ago, in the largest whole unit ("3 days", "5 hours", "just now"); "Not recorded" without a usable date. */
export function relativeAge(value: unknown, now = Date.now()): string {
  const at = typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (Number.isNaN(at)) return "Not recorded";
  const minutes = Math.max(0, Math.floor((now - at) / 60000));
  const unit = (n: number, name: string) => `${n} ${name}${n === 1 ? "" : "s"}`;
  if (minutes < 1) return "just now";
  if (minutes < 60) return unit(minutes, "minute");
  if (minutes < 1440) return unit(Math.floor(minutes / 60), "hour");
  if (minutes < 43200) return unit(Math.floor(minutes / 1440), "day");
  return unit(Math.floor(minutes / 43200), "month");
}

/** The one-line toast and last-decision text for a decision. */
export function decisionVerb(action: string): string {
  return { accept: "Accepted", reject: "Rejected", revert: "Reverted", reopen: "Reopened" }[action] ?? "Decided";
}

/** What the reviewer decided last in this session, kept so Undo… and Reopen… stay reachable after the queue moves on. */
export interface LastDecision {
  action: string;
  id: string;
  ref: string;
  title: string;
  revertable: boolean;
}
