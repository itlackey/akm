// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `GET /api/improve/impact`: what improve proposed and changed in the environment, week by week, and what went wrong.
 * One response feeds every section of the page; each section is computed on its own so one failing store degrades one
 * card. Nothing here writes.
 */

import { readStateEvents } from "../../storage/repositories/events-repository";
import { listIndexCompletedEvents } from "../../storage/repositories/metrics-repository";
import { listStateProposals } from "../../storage/repositories/proposals-repository";
import { akmMetrics } from "../metrics/metrics-cli";
import type { MetricsUsageRow } from "../metrics/types";
import { isRetireProposal, type Proposal } from "../proposal/proposal-types";
import { classifyOutcome, decidedAt, deciderOf, weekOf, weekRange } from "./derive";
import { section, tryStashDir, withReadonlyStateDb } from "./readers";

const DAY = 86_400_000;
const FLAG_DAYS = 14;
const COMPARE_DAYS = 28;

type Counts = Record<"judge" | "you" | "unknown" | "rejected" | "reverted", number>;
const blank = (): Counts => ({ judge: 0, you: 0, unknown: 0, rejected: 0, reverted: 0 });

function outcomesByProcess(proposals: Proposal[], weeks: string[]) {
  const byProcess = new Map<string, Map<string, Counts>>();
  for (const proposal of proposals) {
    const outcome = classifyOutcome(proposal);
    if (outcome === "pending") continue;
    const week = weekOf(decidedAt(proposal));
    if (!weeks.includes(week)) continue;
    const process = byProcess.get(proposal.source) ?? new Map<string, Counts>();
    const counts = process.get(week) ?? blank();
    counts[outcome as keyof Counts] += 1;
    process.set(week, counts);
    byProcess.set(proposal.source, process);
  }
  return [...byProcess]
    .map(([source, perWeek]) => ({
      source,
      weeks: weeks.map((week) => ({ week, ...(perWeek.get(week) ?? blank()) })),
    }))
    .sort((a, b) => a.source.localeCompare(b.source));
}

/** Waiting for review at the end of each week: made by then and not yet decided by then. */
function reviewFlow(proposals: Proposal[], weeks: string[]) {
  // One pass buckets each proposal's week once; "waiting" needs the end of each week, so it compares strings.
  const created = new Map<string, number>();
  const decided = new Map<string, number>();
  for (const p of proposals) {
    const madeIn = weekOf(p.createdAt);
    created.set(madeIn, (created.get(madeIn) ?? 0) + 1);
    if (p.status !== "pending") {
      const decidedIn = weekOf(decidedAt(p));
      decided.set(decidedIn, (decided.get(decidedIn) ?? 0) + 1);
    }
  }
  return weeks.map((week) => {
    const end = new Date(Date.parse(`${week}T00:00:00Z`) + 7 * DAY).toISOString();
    const waiting = proposals.filter(
      (p) => p.createdAt < end && (p.status === "pending" || decidedAt(p) >= end),
    ).length;
    return { week, created: created.get(week) ?? 0, decided: decided.get(week) ?? 0, waiting };
  });
}

/** Usage rows grouped by asset ref, so a per-asset lookup does not rescan every row. */
function rowsByRef(rows: MetricsUsageRow[]): Map<string, MetricsUsageRow[]> {
  const byRef = new Map<string, MetricsUsageRow[]>();
  for (const row of rows) {
    if (!row.ref) continue;
    const list = byRef.get(row.ref);
    if (list) list.push(row);
    else byRef.set(row.ref, [row]);
  }
  return byRef;
}

function harmLog(
  proposals: Proposal[],
  usage: MetricsUsageRow[],
  reopened: Array<{ ts: string; ref?: string }>,
  sinceIso: string,
) {
  const items: Array<{ kind: string; ref: string; at: string; detail: string; proposalId?: string }> = [];
  for (const p of proposals) {
    if (p.status === "reverted" && p.updatedAt >= sinceIso)
      items.push({
        kind: "reverted",
        ref: p.ref,
        at: p.updatedAt,
        detail: `${p.source} change undone`,
        proposalId: p.id,
      });
    if (p.status === "accepted" && isRetireProposal(p) && p.retirement?.continuityRisk && decidedAt(p) >= sinceIso)
      items.push({
        kind: "risky-retirement",
        ref: p.retirement.retiredRef,
        at: decidedAt(p),
        detail: "retired with a continuity risk flagged",
        proposalId: p.id,
      });
  }
  for (const event of reopened) {
    if (event.ts >= sinceIso && event.ref)
      items.push({ kind: "reopened", ref: event.ref, at: event.ts, detail: "a rejection was reopened" });
  }
  // A flag after a change: negative feedback on an asset within two weeks after improve changed it.
  const negative = rowsByRef(usage.filter((row) => row.eventType === "feedback" && row.signal === "negative"));
  for (const p of proposals) {
    if (p.status !== "accepted" && p.status !== "reverted") continue;
    const at = decidedAt(p);
    if (at < sinceIso) continue;
    const end = new Date(Date.parse(at) + FLAG_DAYS * DAY).toISOString();
    const flags = (negative.get(p.ref) ?? []).filter((row) => row.at > at && row.at <= end);
    for (const flag of flags)
      items.push({
        kind: "flag-after-change",
        ref: p.ref,
        at: flag.at,
        detail: flag.reason ? `negative feedback: ${flag.reason}` : "negative feedback after a change",
        proposalId: p.id,
      });
  }
  return items.sort((a, b) => b.at.localeCompare(a.at));
}

/** Before and after counts of how an asset was found and rated, around the day improve changed it. */
function changedAssets(proposals: Proposal[], usage: MetricsUsageRow[], now: number) {
  const byRef = rowsByRef(usage);
  return proposals
    .filter((p) => (p.status === "accepted" || p.status === "reverted") && !isRetireProposal(p))
    .sort((a, b) => decidedAt(b).localeCompare(decidedAt(a)))
    .slice(0, 50)
    .map((p) => {
      const at = Date.parse(decidedAt(p));
      const count = (from: number, to: number) => {
        const fromIso = new Date(from).toISOString();
        const toIso = new Date(to).toISOString();
        const mine = (byRef.get(p.ref) ?? []).filter((row) => row.at >= fromIso && row.at < toIso);
        return {
          hits: mine.filter((row) => row.eventType === "search" || row.eventType === "show").length,
          negative: mine.filter((row) => row.signal === "negative").length,
          positive: mine.filter((row) => row.signal === "positive").length,
        };
      };
      const afterDays = Math.min(COMPARE_DAYS, Math.floor((now - at) / DAY));
      return {
        proposalId: p.id,
        ref: p.ref,
        source: p.source,
        outcome: classifyOutcome(p),
        decidedAt: decidedAt(p),
        before: count(at - COMPARE_DAYS * DAY, at),
        after: count(at, at + COMPARE_DAYS * DAY),
        afterDays,
        // Fewer than four weeks since the change: the "after" side is still filling.
        complete: afterDays >= COMPARE_DAYS,
      };
    });
}

function judgeAndYou(proposals: Proposal[]) {
  const table: Record<string, { accepted: number; rejected: number; reverted: number }> = {};
  for (const p of proposals) {
    const outcome = classifyOutcome(p);
    if (outcome === "pending") continue;
    const who = deciderOf(p);
    const row = table[who] ?? { accepted: 0, rejected: 0, reverted: 0 };
    table[who] = row;
    if (outcome === "rejected") row.rejected += 1;
    else if (outcome === "reverted") row.reverted += 1;
    else row.accepted += 1;
  }
  return table;
}

export async function improveImpact(query: URLSearchParams) {
  const since = query.get("since") === "all" ? "365d" : "90d";
  const now = Date.now();
  const sinceIso = new Date(now - (since === "365d" ? 365 : 90) * DAY).toISOString();
  const errors: Record<string, string> = {};
  const metrics = await section(errors, "metrics", () =>
    akmMetrics({ since, indexSnapshot: false, includeRows: true }),
  );
  const usage = metrics?.rows?.usage ?? [];
  const stashDir = tryStashDir();
  const state = withReadonlyStateDb(
    (db) => ({
      proposals: stashDir ? listStateProposals(db, { stashDir, withContent: false }) : [],
      reopened: readStateEvents(db, { type: "proposal_reopened", since: sinceIso }).events,
      library: listIndexCompletedEvents(db, sinceIso, new Date(now + DAY).toISOString()),
    }),
    null,
  );
  if (!state) return { available: false as const, since, errors };
  const weeks = weekRange(sinceIso.slice(0, 10), new Date(now).toISOString().slice(0, 10));
  const proposals = state.proposals;

  const outcomes = await section(errors, "outcomes", () => outcomesByProcess(proposals, weeks));
  const flow = await section(errors, "reviewFlow", () => reviewFlow(proposals, weeks));
  const library = await section(errors, "library", () => {
    const lastPerWeek = new Map<string, number>();
    for (const event of state.library) {
      try {
        const total = (JSON.parse(event.metadata_json) as { totalEntries?: unknown }).totalEntries;
        if (typeof total === "number") lastPerWeek.set(weekOf(event.ts), total);
      } catch {
        // A row that is not JSON has no size to read.
      }
    }
    return weeks.map((week) => ({ week, entries: lastPerWeek.get(week) ?? null }));
  });
  const harm = await section(errors, "harm", () => harmLog(proposals, usage, state.reopened, sinceIso));
  const cost = await section(errors, "cost", () => {
    const byWeek = new Map<
      string,
      { calls: number; tokens: number; usageCalls: number; byProcess: Record<string, number> }
    >();
    for (const row of metrics?.rows?.llm ?? []) {
      const week = weekOf(row.day);
      const entry = byWeek.get(week) ?? { calls: 0, tokens: 0, usageCalls: 0, byProcess: {} };
      entry.calls += row.calls;
      entry.tokens += row.totalTokens;
      entry.usageCalls += row.usageCalls;
      const process = row.process ?? "other";
      entry.byProcess[process] = (entry.byProcess[process] ?? 0) + row.calls;
      byWeek.set(week, entry);
    }
    return weeks.map((week) => ({
      week,
      ...(byWeek.get(week) ?? { calls: 0, tokens: 0, usageCalls: 0, byProcess: {} }),
    }));
  });
  const changed = await section(errors, "changedAssets", () => changedAssets(proposals, usage, now));
  const judge = await section(errors, "judgeAndYou", () => judgeAndYou(proposals));

  const decided = proposals.filter((p) => p.status !== "pending" && decidedAt(p) >= sinceIso);
  const kept = decided.filter((p) => p.status === "accepted").length;
  const reverted = decided.filter((p) => p.status === "reverted").length;
  const flags = (harm ?? []).filter((item) => item.kind === "flag-after-change").length;
  const calls = (cost ?? []).reduce((sum, w) => sum + w.calls, 0);
  const tokens = (cost ?? []).reduce((sum, w) => sum + w.tokens, 0);
  const usageCalls = (cost ?? []).reduce((sum, w) => sum + w.usageCalls, 0);
  return {
    available: true as const,
    since,
    weeks,
    summary: {
      kept,
      reverted,
      flags,
      tokens,
      tokenCoverage: calls > 0 ? usageCalls / calls : null,
      checked: decided.length,
    },
    outcomes,
    reviewFlow: flow,
    library,
    harm,
    cost,
    changedAssets: changed,
    judgeAndYou: judge,
    ...(Object.keys(errors).length > 0 ? { errors } : {}),
  };
}
