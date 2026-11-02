// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Pure derivations the dashboard shares: how a proposal's outcome is classified, a binomial "usual range" for a rate,
 * and the p-chart limits for a weekly proportion. No I/O, so each is tested on its own.
 */

import type { Proposal } from "../proposal/proposal-types";
import { binomialQuantile, dayRange, isoWeekStart } from "./stats";

export type OutcomeClass = "judge" | "you" | "unknown" | "rejected" | "reverted" | "pending";

/** Who made the decision. One recorded before `decidedBy` existed is "unknown" unless the gate auto-accepted it. */
export function deciderOf(proposal: Proposal): "judge" | "you" | "unknown" {
  const by = proposal.review?.decidedBy;
  if (by === "triage") return "judge";
  if (by === "human") return "you";
  return proposal.gateDecision?.outcome === "auto-accepted" ? "judge" : "unknown";
}

/** Who decided an accepted proposal, or what became of it. */
export function classifyOutcome(proposal: Proposal): OutcomeClass {
  if (proposal.status === "pending") return "pending";
  if (proposal.status === "rejected") return "rejected";
  if (proposal.status === "reverted") return "reverted";
  return deciderOf(proposal);
}

/**
 * When the proposal's current decision was made. A revert overwrites `review` with the revert time, so a reverted
 * proposal is dated by its accept: the change took effect then, and the revert is a separate event (`updatedAt`).
 */
export function decidedAt(proposal: Proposal): string {
  if (proposal.status === "reverted" && proposal.acceptedAt) return proposal.acceptedAt;
  return proposal.review?.decidedAt ?? proposal.updatedAt;
}

export type UsualState = "within" | "above" | "below" | "low-data";

export interface Usual {
  /** The share across the baseline, as a fraction. */
  rate: number | null;
  /** The range a share is usually in at the current sample size, as fractions; null when there is too little data. */
  low: number | null;
  high: number | null;
  state: UsualState;
}

const MIN_BASELINE = 30;
const MIN_CURRENT = 10;

/**
 * Judge `x` of `n` now against a baseline of `baselineX` of `baselineN`. The usual range is the central 95% of what a
 * Binomial(n, baseline rate) produces, so a small current sample gets a wide range. Too little data on either side is
 * "low-data", never a verdict.
 */
export function againstUsual(x: number, n: number, baselineX: number, baselineN: number): Usual {
  if (baselineN < MIN_BASELINE || n < MIN_CURRENT)
    return { rate: baselineN > 0 ? baselineX / baselineN : null, low: null, high: null, state: "low-data" };
  const rate = baselineX / baselineN;
  const low = binomialQuantile(n, rate, 0.025) / n;
  const high = binomialQuantile(n, rate, 0.975) / n;
  const share = x / n;
  return { rate, low, high, state: share > high ? "above" : share < low ? "below" : "within" };
}

export interface PChartPoint {
  week: string;
  x: number;
  n: number;
  rate: number | null;
  lower: number | null;
  upper: number | null;
  /** True when the week is outside its own limits. */
  signal: boolean;
}

/**
 * Weekly proportions with p-chart control limits (centre ± 3 standard errors at each week's own n). A week with no
 * observations has no rate and no limits. The centre is the pooled share over every week.
 */
export function pChart(weeks: Array<{ week: string; x: number; n: number }>): {
  centre: number | null;
  points: PChartPoint[];
} {
  const totalN = weeks.reduce((sum, w) => sum + w.n, 0);
  const centre = totalN > 0 ? weeks.reduce((sum, w) => sum + w.x, 0) / totalN : null;
  return {
    centre,
    points: weeks.map((w) => {
      if (centre === null || w.n === 0) return { ...w, rate: null, lower: null, upper: null, signal: false };
      const rate = w.x / w.n;
      const margin = 3 * Math.sqrt((centre * (1 - centre)) / w.n);
      const lower = Math.max(0, centre - margin);
      const upper = Math.min(1, centre + margin);
      return { ...w, rate, lower, upper, signal: rate < lower || rate > upper };
    }),
  };
}

/** Every ISO week start (Monday) from the week of `from` to the week of `to`, oldest first. */
export function weekRange(from: string, to: string): string[] {
  const weeks: string[] = [];
  for (const day of dayRange(isoWeekStart(from), to)) if (day === isoWeekStart(day)) weeks.push(day);
  return weeks;
}

export const weekOf = (iso: string): string => isoWeekStart(iso.slice(0, 10));
