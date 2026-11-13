// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** The event stream `activity.events` returns, made into steps a replay plays over the library map. */

import { type Arrangement, isPlaced, type LibraryGraph } from "./graph-model.ts";

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
  /** What akm recorded the event as; the ticker names it for `other` events. */
  eventType: string;
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

/** `activity.events` keeps the newest this many events of a period. */
export const EVENT_LIMIT = 20_000;

/** A search that found nothing: the one definition the lane, the total and the list of queries share. */
export const foundNothing = (step: ReplayStep) => step.kind === "search" && step.results === 0;

/** A hit is part of its search, so it is not an event of its own on the lanes or in the totals. */
const counted = (step: ReplayStep) => step.kind !== "hit";

/**
 * Events per actor in `bins` equal slices of the window. Lanes run from the busiest actor to the quietest, ties by
 * name without regard to case. Every lane, the found-nothing lane included, is drawn on one scale: `max`, the most
 * events any lane has in one slice.
 */
export function replayBins(steps: ReplayStep[], start: number, end: number, bins = 96) {
  const width = Math.max(1, end - start) / bins;
  const at = (t: number) => Math.min(bins - 1, Math.max(0, Math.floor((t - start) / width)));
  const own = steps.filter(counted);
  const counts = new Map<string, number[]>();
  for (const step of own) {
    if (!counts.has(step.actor)) counts.set(step.actor, new Array<number>(bins).fill(0));
    counts.get(step.actor)![at(step.t)]!++;
  }
  const misses = new Array<number>(bins).fill(0);
  for (const step of own) if (foundNothing(step)) misses[at(step.t)]!++;
  const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
  const totals = new Map([...counts].map(([actor, values]) => [actor, sum(values)]));
  const actors = [...counts.keys()].sort(
    (a, b) =>
      totals.get(b)! - totals.get(a)! || a.localeCompare(b, undefined, { sensitivity: "base" }) || (a < b ? -1 : 1),
  );
  const max = Math.max(1, ...misses, ...[...counts.values()].flat());
  return { actors, counts, totals, misses, missTotal: sum(misses), max, width };
}

/** "tallest bar = 12 events per 15 minutes": what the shared scale of the lanes is. */
export const scaleText = (max: number, width: number) =>
  `Tallest bar = ${max} event${max === 1 ? "" : "s"} per ${durationText(width)}`;

/** A length of time as people read it: "15 minutes", "1 h 45 min", "6 hours". */
export function durationText(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${m} min` : `${h} hour${h === 1 ? "" : "s"}`;
}

/** The running totals at a moment: what the replay's figures say once it has played up to `t`. */
export function totalsAt(steps: ReplayStep[], t: number) {
  const totals = {
    searches: 0,
    foundNothing: 0,
    shows: 0,
    positive: 0,
    negative: 0,
    /** Events of a kind without a total of its own (curate, for one). */
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
    } else if (step.kind === "show") totals.shows++;
    else if (step.kind === "feedback") step.signal === "negative" ? totals.negative++ : totals.positive++;
    else if (step.kind === "other") totals.others++;
    if (step.node >= 0 && counted(step)) totals.used.add(step.node);
  }
  const events = totals.searches + totals.shows + totals.positive + totals.negative + totals.others;
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

/** What the ticker says for an event. */
export function describe(step: ReplayStep): string {
  const quoted = step.query ? ` “${step.query}”` : "";
  if (step.kind === "search") {
    if (foundNothing(step)) return `searched${quoted}, found nothing`;
    return `searched${quoted}${step.results === undefined ? "" : `, ${step.results} result${step.results === 1 ? "" : "s"}`}`;
  }
  if (step.kind === "show") return `read ${step.ref ?? "an asset"}`;
  if (step.kind === "feedback") return `${step.signal ?? ""} feedback on ${step.ref ?? "an asset"}`.trim();
  return `${step.eventType}${quoted}${step.ref ? ` on ${step.ref}` : ""}`;
}

/** The events that touched assets the map does not draw: counted in the figures, not lit. */
export function undrawn(steps: ReplayStep[], graph: LibraryGraph, arrange: Arrangement) {
  let events = 0;
  const assets = new Set<string>();
  let noPosition = 0;
  for (const step of steps) {
    if (!counted(step) || !step.ref) continue;
    if (step.node >= 0 && isPlaced(graph, arrange, step.node)) continue;
    events++;
    assets.add(step.ref);
    if (step.node >= 0) noPosition++;
  }
  return { events, assets: assets.size, noPosition };
}
export function undrawnText(u: ReturnType<typeof undrawn>, arrange: Arrangement): string {
  if (!u.events) return "";
  const why = [
    u.noPosition ? `${u.noPosition} on assets with no position ${arrange === "meaning" ? "by meaning" : "here"}` : "",
    u.events - u.noPosition ? `${u.events - u.noPosition} on assets that are not in the library map` : "",
  ].filter(Boolean);
  return `${u.events} event${u.events === 1 ? "" : "s"} in this period touched ${u.assets} asset${u.assets === 1 ? "" : "s"} that ${u.assets === 1 ? "is" : "are"} not drawn (${why.join("; ")}). They are counted in the figures and the lanes.`;
}

/** The renderer's state for each asset: not on this arrangement is hidden, used so far is ringed (emphasised), the rest normal in the quietest colour. */
export function replayState(graph: LibraryGraph, arrange: Arrangement, used: ArrayLike<number>): Uint8Array {
  const state = new Uint8Array(graph.count);
  for (let i = 0; i < graph.count; i++) state[i] = !isPlaced(graph, arrange, i) ? 3 : used[i] ? 2 : 1;
  return state;
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

// ---- Pulses ----

/** Pulse diameters in CSS px (the renderer draws them that size, capped at 32). */
export const PULSE_PX = { read: 14, hit: 12, feedback: 18 };
export const PULSE_SECONDS = 1.2;
/** The most pulses in flight at once. */
export const MAX_PULSES = 600;
/** The tokens a pulse is coloured with, by kind (see tokens.css). */
export const PULSE_TOKENS = {
  read: "--pulse-read",
  hit: "--pulse-hit",
  positive: "--pulse-up",
  negative: "--pulse-down",
} as const;
export type PulseKind = keyof typeof PULSE_TOKENS;
/** The pulse an event sends to its asset, or null for events that have none (searches, curate). */
export function pulseOf(step: ReplayStep): { kind: PulseKind; size: number } | null {
  if (step.kind === "show") return { kind: "read", size: PULSE_PX.read };
  if (step.kind === "hit") return { kind: "hit", size: PULSE_PX.hit };
  if (step.kind === "feedback")
    return { kind: step.signal === "negative" ? "negative" : "positive", size: PULSE_PX.feedback };
  return null;
}

/** How far outside the drawn points the pulses start, as a multiple of their extent. */
export const RING_MARGIN = 1.15;
/** Pulses arc this fraction of the ring's radius above their path. */
export const ARC_FRACTION = 0.12;
/** The ring the pulses start from: round the drawn points (not hidden ones), just outside them, at the top of the cloud. */
export function emitterRing(pos: ArrayLike<number>, state: ArrayLike<number>) {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < state.length; i++) {
    if (state[i] === 3) continue;
    for (let a = 0; a < 3; a++) {
      lo[a] = Math.min(lo[a]!, pos[i * 3 + a]!);
      hi[a] = Math.max(hi[a]!, pos[i * 3 + a]!);
    }
  }
  if (lo[0] === Infinity) return { centre: [0, 0, 0], radius: 0, arc: 0 };
  const centre = [(lo[0]! + hi[0]!) / 2, hi[1]!, (lo[2]! + hi[2]!) / 2];
  const radius = (Math.hypot(hi[0]! - lo[0]!, hi[2]! - lo[2]!) / 2) * RING_MARGIN;
  return { centre, radius, arc: radius * ARC_FRACTION };
}
/** Emitter `at` of `of` on the ring. */
export function emitterAt(ring: ReturnType<typeof emitterRing>, at: number, of: number): number[] {
  const angle = (at / Math.max(1, of)) * Math.PI * 2;
  return [
    ring.centre[0]! + Math.cos(angle) * ring.radius,
    ring.centre[1]!,
    ring.centre[2]! + Math.sin(angle) * ring.radius,
  ];
}

/** The scrubber's step: one minute. */
export const SCRUB_STEP = 60_000;

/**
 * The time a scrubber value means. A range input only reaches `start` plus whole steps, so when the window is not a
 * whole number of steps its last step falls short of `end`; the last step is the end of the window.
 */
export const scrubTime = (value: number, start: number, end: number) => (value > end - SCRUB_STEP ? end : value);
