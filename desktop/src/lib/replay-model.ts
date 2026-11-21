// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** The event stream `activity.events` returns, made into steps a replay plays over the library mind map. */

export interface UsageEventRow {
  id: number;
  at: string;
  eventType: string;
  ref?: string;
  query?: string;
  signal?: "positive" | "negative";
  source: string;
  /** akm says whether the person made the event, as opposed to an agent, improve or a task. */
  byPerson: boolean;
  resultCount?: number;
  agent?: { harness: string; session?: string };
}

export type ReplayStep = {
  t: number;
  kind: "search" | "curate" | "hit" | "show" | "feedback" | "other";
  /** Whether the person made the event; the others are an agent's, improve's or a task's. */
  byPerson: boolean;
  /** The asset on the map, or -1 when the event names none or names one not on the map. */
  node: number;
  query?: string;
  results?: number;
  signal?: "positive" | "negative";
  ref?: string;
  /** What akm recorded the event as: the log says "curated" or "searched", and names it for `other` events. */
  eventType: string;
};

export function replaySteps(events: UsageEventRow[], index: Map<string, number>): ReplayStep[] {
  return events
    .map((event): ReplayStep => {
      const node = event.ref ? (index.get(event.ref) ?? -1) : -1;
      // A search or a curate is one row for the query and one per result: the results are hits, part of it.
      const kind =
        event.eventType === "search" || event.eventType === "curate"
          ? event.ref
            ? "hit"
            : event.eventType
          : event.eventType === "show"
            ? "show"
            : event.eventType === "feedback"
              ? "feedback"
              : "other";
      return {
        t: Date.parse(event.at),
        kind,
        node,
        byPerson: event.byPerson,
        eventType: event.eventType,
        ...(event.query ? { query: event.query } : {}),
        ...(event.resultCount !== undefined ? { results: event.resultCount } : {}),
        ...(event.signal ? { signal: event.signal } : {}),
        ...(event.ref ? { ref: event.ref } : {}),
      };
    })
    .filter((step) => Number.isFinite(step.t))
    .sort((a, b) => a.t - b.t);
}

/** The steps the person made, or every step including agents', improve's and tasks'. */
export const stepsOf = (steps: ReplayStep[], everyone: boolean) => (everyone ? steps : steps.filter((s) => s.byPerson));

/** `activity.events` keeps the newest this many events of a period. */
export const EVENT_LIMIT = 20_000;

/** A search that found nothing: the one definition the timeline, the total and the list of queries share. */
export const foundNothing = (step: ReplayStep) => step.kind === "search" && step.results === 0;

/** A hit is part of its search, so it is not an event of its own in the totals. */
const counted = (step: ReplayStep) => step.kind !== "hit";

/** The kinds the timeline stacks, bottom first, with the colour of each. */
export const KINDS = [
  { id: "read", label: "Reads", token: "--use-2" },
  { id: "search", label: "Searches", token: "--accent" },
  { id: "miss", label: "Searches that found nothing", token: "--fail" },
  { id: "curate", label: "Curates", token: "--use-1" },
  { id: "feedback", label: "Feedback", token: "--ok" },
  { id: "other", label: "Other events", token: "--border-strong" },
] as const;
export type KindId = (typeof KINDS)[number]["id"];
const kindOf = (step: ReplayStep): KindId | null =>
  step.kind === "show"
    ? "read"
    : step.kind === "search"
      ? foundNothing(step)
        ? "miss"
        : "search"
      : step.kind === "curate"
        ? "curate"
        : step.kind === "feedback"
          ? "feedback"
          : step.kind === "other"
            ? "other"
            : null;

/** Events per kind in `bins` equal slices of the window, for the stacked timeline; `max` is the tallest slice. */
export function kindBins(steps: ReplayStep[], start: number, end: number, bins = 96) {
  const width = Math.max(1, end - start) / bins;
  const counts = Array.from(
    { length: bins },
    () => Object.fromEntries(KINDS.map((k) => [k.id, 0])) as Record<KindId, number>,
  );
  for (const step of steps) {
    const kind = kindOf(step);
    if (!kind) continue;
    counts[Math.min(bins - 1, Math.max(0, Math.floor((step.t - start) / width)))]![kind]++;
  }
  const max = Math.max(1, ...counts.map((c) => KINDS.reduce((sum, k) => sum + c[k.id], 0)));
  return { counts, max, width };
}

/** The running totals at a moment: what the replay's figures say once it has played up to `t`. */
export function totalsAt(steps: ReplayStep[], t: number) {
  const totals = {
    searches: 0,
    curates: 0,
    foundNothing: 0,
    shows: 0,
    positive: 0,
    negative: 0,
    /** Events of a kind without a total of its own. */
    others: 0,
    used: new Set<number>(),
  };
  const misses = new Map<string, number>();
  for (const step of steps) {
    if (step.t > t) break;
    if (step.kind === "search") {
      totals.searches++;
      if (foundNothing(step)) {
        totals.foundNothing++;
        const query = step.query ?? NO_QUERY;
        misses.set(query, (misses.get(query) ?? 0) + 1);
      }
    } else if (step.kind === "curate") totals.curates++;
    else if (step.kind === "show") totals.shows++;
    else if (step.kind === "feedback") step.signal === "negative" ? totals.negative++ : totals.positive++;
    else if (step.kind === "other") totals.others++;
    if (step.node >= 0 && counted(step)) totals.used.add(step.node);
  }
  const events = totals.searches + totals.curates + totals.shows + totals.positive + totals.negative + totals.others;
  return { ...totals, events, misses: [...misses].sort((a, b) => b[1] - a[1]) };
}
const NO_QUERY = "(no query recorded)";

/** The assets used so far (not hits), most events first, ties by ref: "Used in this period". */
export function usedList(steps: ReplayStep[], t: number, limit = 10) {
  const counts = new Map<number, { node: number; ref: string; count: number }>();
  for (const step of steps) {
    if (step.t > t) break;
    if (step.node < 0 || !counted(step)) continue;
    const row = counts.get(step.node) ?? { node: step.node, ref: step.ref ?? "", count: 0 };
    row.count++;
    counts.set(step.node, row);
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || (a.ref < b.ref ? -1 : 1)).slice(0, limit);
}

/** The colour tokens of Replay's pulses, one per event kind: a read, a search hit, positive and negative feedback. */
export const PULSES = [
  { id: "read", label: "Read", token: "--pulse-read" },
  { id: "hit", label: "Returned by a search", token: "--pulse-hit" },
  { id: "up", label: "Positive feedback", token: "--pulse-up" },
  { id: "down", label: "Negative feedback", token: "--pulse-down" },
] as const;
export type PulseId = (typeof PULSES)[number]["id"];
/** The pulse an event makes on its asset, or null for an event that has none (a curate or another kind of event). */
const pulseOf = (step: ReplayStep): PulseId | null =>
  step.kind === "show"
    ? "read"
    : step.kind === "hit" && step.eventType === "search"
      ? "hit"
      : step.kind === "feedback"
        ? step.signal === "negative"
          ? "down"
          : "up"
        : null;

/**
 * The assets events touched in the `windowMs` up to `t`, each with the pulse of its latest event there, for the
 * moment the replay is at. An event that names no asset on the map, or has no pulse, adds none.
 */
export function pulsesAt(steps: ReplayStep[], t: number, windowMs: number): Array<{ node: number; pulse: PulseId }> {
  const latest = new Map<number, PulseId>();
  for (const step of steps) {
    if (step.t > t) break;
    if (step.t <= t - windowMs || step.node < 0) continue;
    const pulse = pulseOf(step);
    if (pulse) latest.set(step.node, pulse);
  }
  return [...latest].map(([node, pulse]) => ({ node, pulse }));
}

/**
 * Events up to `t` that touched an asset with no place on the 3D map: one `onMap` says is not a point, and one akm no
 * longer lists (its ref is not in the graph). A hit is part of its search and is not counted, as in the totals.
 */
export function unplacedEvents(steps: ReplayStep[], t: number, onMap: (node: number) => boolean) {
  let notOnMap = 0;
  let notListed = 0;
  for (const step of steps) {
    if (step.t > t) break;
    if (!step.ref || !counted(step)) continue;
    if (step.node < 0) notListed++;
    else if (!onMap(step.node)) notOnMap++;
  }
  return { notOnMap, notListed };
}

/** What the ticker says for an event. */
export function describe(step: ReplayStep): string {
  const quoted = step.query ? ` “${step.query}”` : "";
  if (step.kind === "search" || step.kind === "curate") {
    const verb = step.kind === "curate" ? "curated" : "searched";
    if (step.results === 0) return `${verb}${quoted}, found nothing`;
    return `${verb}${quoted}${step.results === undefined ? "" : `, ${step.results} result${step.results === 1 ? "" : "s"}`}`;
  }
  if (step.kind === "show") return `read ${step.ref ?? "an asset"}`;
  if (step.kind === "feedback") return `${step.signal ?? ""} feedback on ${step.ref ?? "an asset"}`.trim();
  return `${step.eventType}${quoted}${step.ref ? ` on ${step.ref}` : ""}`;
}

// ---- The clock ----

/** Every period plays in this long at Normal speed, whatever its length. */
export const REPLAY_SECONDS = 60;
export const SPEEDS = [
  { value: 1, label: "Normal" },
  { value: 4, label: "Fast (4×)" },
  { value: 16, label: "Fastest (16×)" },
];
/** Where the clock is `dtMs` of real time after `clock`, played at `speed` over the window. */
export const advance = (clock: number, dtMs: number, start: number, end: number, speed: number) =>
  Math.min(end, clock + (dtMs * speed * (end - start)) / (REPLAY_SECONDS * 1000));
/** "Plays the whole period in about 1 minute": how long Play takes at this speed. */
export function playText(speed: number): string {
  const seconds = Math.round(REPLAY_SECONDS / speed);
  return `Plays the whole period in about ${seconds >= 60 ? `${Math.round(seconds / 60)} minute${seconds >= 120 ? "s" : ""}` : `${seconds} seconds`}`;
}

// ---- Time on screen ----

const DAY = 86_400_000;
interface Zone {
  locale?: string;
  timeZone?: string;
}
const timeText = (t: number, z: Zone) =>
  new Date(t).toLocaleTimeString(z.locale, { hour: "2-digit", minute: "2-digit", timeZone: z.timeZone });
const dateTimeText = (t: number, z: Zone) =>
  new Date(t).toLocaleString(z.locale, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: z.timeZone,
  });
/** A moment in the ticker: the time, and the date too when the period is longer than a day. */
export const stampText = (t: number, spanMs: number, z: Zone = {}) =>
  spanMs > DAY ? dateTimeText(t, z) : timeText(t, z);
/** The timeline's axis: date and time at the start, the middle and the end of the window. */
export const axisLabels = (start: number, end: number, z: Zone = {}) =>
  [start, start + (end - start) / 2, end].map((t) => dateTimeText(t, z));

/** What to say when `activity.events` kept only the latest events: where the replay therefore starts. */
export function truncationNote(truncated: boolean, firstAt: number | undefined, z: Zone = {}): string {
  if (!truncated) return "";
  const from =
    firstAt === undefined ? "" : `, so the replay starts at ${dateTimeText(firstAt, z)}, later than the period`;
  return `This period held more than ${EVENT_LIMIT.toLocaleString("en-US")} events; the replay keeps the latest ${EVENT_LIMIT.toLocaleString("en-US")}${from}.`;
}

/** The scrubber's step: one minute. */
export const SCRUB_STEP = 60_000;

/**
 * The time a scrubber value means. A range input only reaches `start` plus whole steps, so when the window is not a
 * whole number of steps its last step falls short of `end`; the last step is the end of the window.
 */
export const scrubTime = (value: number, start: number, end: number) => (value > end - SCRUB_STEP ? end : value);
