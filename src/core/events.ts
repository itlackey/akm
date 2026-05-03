/**
 * Append-only events stream — `events.jsonl` (#204).
 *
 * Every mutating CLI verb funnels through `appendEvent` so external
 * observers (sync, replication, audit, dashboards) can react to stash
 * changes by tailing a single file. The file is plain newline-delimited
 * JSON; each line is a self-contained event envelope.
 *
 * The helper is the only thing in akm that writes to events.jsonl. It
 * accepts injectable `now()` and `path` so tests can pin time and use a
 * tmpdir without any global mutation.
 *
 * Format (each line):
 *   { "schemaVersion": 1, "id": <number>, "ts": "<ISO>",
 *     "eventType": "<verb>", "ref"?: "<asset-ref>", ... }
 *
 * - `id` is a monotonic integer per file. We use the file's pre-write
 *   byte length as a durable cursor for `--since` (stable across processes
 *   because every appender holds an O_APPEND write). Callers can also pass
 *   a string ISO timestamp to `--since` and we filter by `ts >= since`.
 * - `ts` is ISO-8601 (UTC, millisecond precision).
 *
 * The event `id` is derived at read time (line index) — the file itself
 * is the source of truth, so the writer never has to coordinate with a
 * counter. Tail consumers can persist a byte offset (durable cursor).
 */

import fs from "node:fs";
import path from "node:path";
import { getCacheDir } from "./paths";

/**
 * Stable, machine-readable event types. New types may be added freely.
 *
 * NOTE: `index` and `setup` verbs are intentionally NOT emitted in #204 and
 * are tracked as a follow-up. They were considered for inclusion but `akmIndex`
 * has multiple exit paths and `setup` is a multi-step interactive flow; wiring
 * them required a larger refactor than this issue scoped. Reintroduce them as
 * literal members here when those emit sites land.
 */
export type EventType =
  | "add"
  | "remove"
  | "update"
  | "remember"
  | "import"
  | "save"
  | "feedback"
  // Proposal substrate (#225). `promoted` and `rejected` are emitted by the
  // `akm proposal accept` / `akm proposal reject` flows. The `*_invoked`
  // events are emitted by the `akm reflect` (#226), `akm propose`, and
  // `akm distill` (#228) command flows.
  | "promoted"
  | "rejected"
  | "reflect_invoked"
  | "propose_invoked"
  | "distill_invoked"
  | "workflow_started"
  | "workflow_step_completed"
  | "workflow_finished"
  | string;

export interface AppendEventInput {
  eventType: EventType;
  /** Asset ref like `memory:alpha`. Optional for stash-wide events. */
  ref?: string;
  /** Free-form structured payload. Must be JSON-serialisable. */
  metadata?: Record<string, unknown>;
}

export interface EventEnvelope {
  schemaVersion: 1;
  id: number;
  ts: string;
  eventType: string;
  ref?: string;
  metadata?: Record<string, unknown>;
}

export interface EventsContext {
  /** Returns ms since epoch. Defaults to `Date.now`. */
  now?: () => number;
  /** Override the events.jsonl path. Defaults to `<cacheDir>/events.jsonl`. */
  filePath?: string;
}

/**
 * Default events.jsonl location: `<cacheDir>/events.jsonl`.
 *
 * Env-isolation caveat: `getCacheDir()` reads `XDG_CACHE_HOME` at the time of
 * each call. Two cooperating processes (e.g. one writing events, one tailing)
 * MUST inherit the same `XDG_CACHE_HOME` or they will read/write different
 * `events.jsonl` files. This is the same env-isolation behaviour as the rest
 * of akm — config, indexes, and caches all key off XDG paths — so set
 * `XDG_CACHE_HOME` consistently across processes that share the events bus.
 */
export function getEventsPath(): string {
  return path.join(getCacheDir(), "events.jsonl");
}

function resolvePath(ctx?: EventsContext): string {
  return ctx?.filePath ?? getEventsPath();
}

function resolveNow(ctx?: EventsContext): () => number {
  return ctx?.now ?? Date.now;
}

/**
 * Append a single event. Best-effort: a write failure is logged once to
 * stderr but never propagates — observability must not break mutation.
 *
 * The id field is intentionally omitted on write (the line index is the
 * id; the reader assigns it). Keeping it off the wire avoids a coordination
 * step between concurrent appenders.
 */
export function appendEvent(input: AppendEventInput, ctx?: EventsContext): void {
  const filePath = resolvePath(ctx);
  const now = resolveNow(ctx);
  const ts = new Date(now()).toISOString();

  const envelope: Omit<EventEnvelope, "id"> = {
    schemaVersion: 1,
    ts,
    eventType: input.eventType,
    ...(input.ref !== undefined ? { ref: input.ref } : {}),
    ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
  };

  const line = `${JSON.stringify(envelope)}\n`;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    // O_APPEND guarantees atomic appends ≤ PIPE_BUF (4 KiB on Linux); our
    // events are well under that ceiling, so concurrent processes can write
    // safely without locking. `appendFileSync` opens with `'a'` which sets
    // O_APPEND.
    fs.appendFileSync(filePath, line, { encoding: "utf8" });
  } catch (err) {
    // Best-effort: events stream failures must not break the mutating verb.
    // Surface once to stderr so operators can diagnose.
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`akm: events.jsonl append failed (${message})\n`);
  }
}

// ─── Reading ────────────────────────────────────────────────────────────────

export interface ReadEventsOptions {
  /** ISO timestamp lower bound (`ts >= since`). */
  since?: string;
  /** Byte-offset lower bound (`offset > sinceOffset`) — durable cursor. */
  sinceOffset?: number;
  /** Filter to a single event type. */
  type?: string;
  /** Filter to a single asset ref. */
  ref?: string;
}

export interface ReadEventsResult {
  events: EventEnvelope[];
  /** End-of-file byte offset (use as the next `sinceOffset`). */
  nextOffset: number;
}

/**
 * Read all events matching the filter. Returns a `nextOffset` that callers
 * can persist between processes for monotonic resumption — `sinceOffset`
 * is the durable cursor referenced in the acceptance criteria.
 */
export function readEvents(options: ReadEventsOptions = {}, ctx?: EventsContext): ReadEventsResult {
  const filePath = resolvePath(ctx);
  if (!fs.existsSync(filePath)) {
    return { events: [], nextOffset: 0 };
  }
  const stat = fs.statSync(filePath);
  const startOffset = options.sinceOffset && options.sinceOffset > 0 ? options.sinceOffset : 0;
  if (startOffset >= stat.size) {
    return { events: [], nextOffset: stat.size };
  }
  const fd = fs.openSync(filePath, "r");
  try {
    const length = stat.size - startOffset;
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, startOffset);
    const text = buf.toString("utf8");
    const events = parseEventLines(text, options, startOffset);
    return { events, nextOffset: stat.size };
  } finally {
    fs.closeSync(fd);
  }
}

function parseEventLines(text: string, options: ReadEventsOptions, startOffset: number): EventEnvelope[] {
  // Each line that ends with \n is a complete event. A trailing partial
  // line (no terminating \n) is ignored — the next read will pick it up
  // once it is fully written.
  const out: EventEnvelope[] = [];
  let lineStart = 0;
  // The envelope id is the 1-based line index across the whole file. We
  // approximate that here as the line index from the start of the read
  // window plus a synthetic offset — for callers using `--since`, the
  // absolute id is less useful than the byte cursor anyway. To keep ids
  // monotonic across reads we use absolute byte position as a stable
  // surrogate identifier.
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) !== 10 /* \n */) continue;
    const line = text.slice(lineStart, i);
    const absStart = startOffset + lineStart;
    lineStart = i + 1;
    if (!line.trim()) continue;
    let parsed: Record<string, unknown> | undefined;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      // Skip malformed lines — better than crashing the read pipeline.
      continue;
    }
    const envelope: EventEnvelope = {
      schemaVersion: 1,
      id: absStart,
      ts: typeof parsed.ts === "string" ? parsed.ts : "",
      eventType: typeof parsed.eventType === "string" ? parsed.eventType : "unknown",
      ...(typeof parsed.ref === "string" ? { ref: parsed.ref } : {}),
      ...(parsed.metadata !== undefined ? { metadata: parsed.metadata as Record<string, unknown> } : {}),
    };
    if (!matchesFilter(envelope, options)) continue;
    out.push(envelope);
  }
  return out;
}

function matchesFilter(envelope: EventEnvelope, options: ReadEventsOptions): boolean {
  if (options.type && envelope.eventType !== options.type) return false;
  if (options.ref && envelope.ref !== options.ref) return false;
  if (options.since && envelope.ts && envelope.ts < options.since) return false;
  return true;
}

// ─── Tailing ─────────────────────────────────────────────────────────────────

export interface TailOptions extends ReadEventsOptions {
  /** Polling interval in ms (default: 75). */
  intervalMs?: number;
  /** Stop after this many ms (test seam). */
  maxDurationMs?: number;
  /** Stop after observing this many events (test seam). */
  maxEvents?: number;
  /**
   * Abort signal — when triggered, the loop resolves with whatever events
   * have been observed so far.
   */
  signal?: AbortSignal;
  /** Called once per emitted event. */
  onEvent?: (event: EventEnvelope) => void;
}

export interface TailResult {
  events: EventEnvelope[];
  nextOffset: number;
  reason: "signal" | "maxEvents" | "maxDuration";
}

/**
 * Follow events.jsonl. Polls at `intervalMs` (default 75ms) and emits
 * every new event to `onEvent`. Resolves when `signal` aborts, when
 * `maxEvents` events have been observed, or when `maxDurationMs` elapses.
 *
 * The polling cursor is byte-offset based, so concurrent writers cannot
 * cause skips: between two reads we always pick up everything appended
 * since the last `nextOffset`.
 */
export async function tailEvents(options: TailOptions = {}, ctx?: EventsContext): Promise<TailResult> {
  const intervalMs = options.intervalMs ?? 75;
  const collected: EventEnvelope[] = [];
  let cursor = options.sinceOffset ?? 0;

  // Seed the cursor: if the caller passed --since (timestamp) but no
  // sinceOffset, do an initial filtered read so they see history before
  // we start polling. This matches the documented behaviour of `tail
  // --since`: emit existing events that match, then follow.
  if (options.sinceOffset === undefined) {
    const initial = readEvents({ since: options.since, type: options.type, ref: options.ref }, ctx);
    for (const event of initial.events) {
      collected.push(event);
      options.onEvent?.(event);
      if (options.maxEvents !== undefined && collected.length >= options.maxEvents) {
        return { events: collected, nextOffset: initial.nextOffset, reason: "maxEvents" };
      }
    }
    cursor = initial.nextOffset;
  }

  const startedAt = Date.now();
  return new Promise<TailResult>((resolve) => {
    let resolved = false;
    let timer: ReturnType<typeof setInterval> | undefined;

    function finish(reason: TailResult["reason"]): void {
      if (resolved) return;
      resolved = true;
      if (timer) clearInterval(timer);
      resolve({ events: collected, nextOffset: cursor, reason });
    }

    function tick(): void {
      try {
        const result = readEvents({ sinceOffset: cursor, type: options.type, ref: options.ref }, ctx);
        cursor = result.nextOffset;
        for (const event of result.events) {
          // Apply --since filter inside the polling loop too — the cursor is
          // byte-offset so it can hand us events the user filtered out.
          if (options.since && event.ts && event.ts < options.since) continue;
          collected.push(event);
          options.onEvent?.(event);
          if (options.maxEvents !== undefined && collected.length >= options.maxEvents) {
            finish("maxEvents");
            return;
          }
        }
      } catch {
        // Non-fatal: stay in the loop.
      }
      if (options.maxDurationMs !== undefined && Date.now() - startedAt >= options.maxDurationMs) {
        finish("maxDuration");
      }
    }

    if (options.signal) {
      if (options.signal.aborted) {
        finish("signal");
        return;
      }
      options.signal.addEventListener("abort", () => finish("signal"), { once: true });
    }

    timer = setInterval(tick, intervalMs);
    // Run one tick immediately so callers don't have to wait an interval
    // for events written in the same tick as the tail starts.
    tick();
  });
}
