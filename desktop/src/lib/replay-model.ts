// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** The event stream `activity.events` returns, made into steps a replay plays over the library map. */

export interface UsageEventRow {
  id: number;
  at: string;
  eventType: string;
  ref?: string;
  query?: string;
  signal?: "positive" | "negative";
  source: string;
  resultCount?: number;
  agent?: { harness: string; session?: string };
}

export type ReplayStep = {
  t: number;
  kind: "search" | "hit" | "show" | "feedback" | "other";
  /** The asset on the map, or -1 when the event names none or names one not on the map. */
  node: number;
  actor: string;
  query?: string;
  results?: number;
  signal?: "positive" | "negative";
  ref?: string;
};

const SOURCES: Record<string, string> = {
  user: "No agent recorded",
  improve: "Improve",
  task: "Scheduled tasks",
  audit: "Audit",
  unknown: "Unknown source",
};

/**
 * Who made an event: the agent harness when akm recorded one, else the event's source. A person and an agent akm could
 * not recognise both record `user` and no agent, so that row says so rather than guessing.
 */
export const actorOf = (event: UsageEventRow) => event.agent?.harness ?? SOURCES[event.source] ?? event.source;

export function replaySteps(events: UsageEventRow[], index: Map<string, number>): ReplayStep[] {
  return events
    .map((event): ReplayStep => {
      const node = event.ref ? (index.get(event.ref) ?? -1) : -1;
      const kind =
        event.eventType === "search"
          ? event.ref
            ? "hit"
            : "search"
          : event.eventType === "show"
            ? "show"
            : event.eventType === "feedback"
              ? "feedback"
              : "other";
      return {
        t: Date.parse(event.at),
        kind,
        node,
        actor: actorOf(event),
        ...(event.query ? { query: event.query } : {}),
        ...(event.resultCount !== undefined ? { results: event.resultCount } : {}),
        ...(event.signal ? { signal: event.signal } : {}),
        ...(event.ref ? { ref: event.ref } : {}),
      };
    })
    .filter((step) => Number.isFinite(step.t))
    .sort((a, b) => a.t - b.t);
}

/** Events per actor in `bins` equal slices of the window, and the searches in each slice that found nothing. */
export function replayBins(steps: ReplayStep[], start: number, end: number, bins = 96) {
  const width = Math.max(1, end - start) / bins;
  const at = (t: number) => Math.min(bins - 1, Math.max(0, Math.floor((t - start) / width)));
  const actors = [...new Set(steps.map((step) => step.actor))].sort();
  const counts = new Map(actors.map((actor) => [actor, new Array<number>(bins).fill(0)]));
  const misses = new Array<number>(bins).fill(0);
  for (const step of steps) {
    if (step.kind === "hit") continue;
    counts.get(step.actor)![at(step.t)]!++;
    if (step.kind === "search" && step.results === 0) misses[at(step.t)]!++;
  }
  return { actors, counts, misses, width };
}

/** The running totals at a moment: what the replay's figures say once it has played up to `t`. */
export function totalsAt(steps: ReplayStep[], t: number) {
  const totals = { searches: 0, foundNothing: 0, shows: 0, positive: 0, negative: 0, used: new Set<number>() };
  const misses = new Map<string, number>();
  for (const step of steps) {
    if (step.t > t) break;
    if (step.kind === "search") {
      totals.searches++;
      if (step.results === 0 && step.query) {
        totals.foundNothing++;
        misses.set(step.query, (misses.get(step.query) ?? 0) + 1);
      }
    } else if (step.kind === "show") totals.shows++;
    else if (step.kind === "feedback") step.signal === "negative" ? totals.negative++ : totals.positive++;
    if (step.node >= 0 && step.kind !== "hit") totals.used.add(step.node);
  }
  return { ...totals, misses: [...misses].sort((a, b) => b[1] - a[1]) };
}

/** The scrubber's step: one minute. */
export const SCRUB_STEP = 60_000;

/**
 * The time a scrubber value means. A range input only reaches `start` plus whole steps, so when the window is not a
 * whole number of steps its last step falls short of `end`; the last step is the end of the window.
 */
export const scrubTime = (value: number, start: number, end: number) => (value > end - SCRUB_STEP ? end : value);
