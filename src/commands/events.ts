/**
 * `akm events list` and `akm events tail` (#204).
 *
 * Programmatic surface — the CLI dispatcher in `src/cli.ts` registers two
 * verbs that delegate here. Both return JSON envelopes shaped by
 * `src/output/shapes.ts` so the output flows through the same shape and
 * text-renderer pipeline as the rest of the CLI (no silent
 * `JSON.stringify` fallback).
 */

import { parseAssetRef } from "../core/asset-ref";
import { UsageError } from "../core/errors";
import { type EventEnvelope, type EventsContext, readEvents, type TailOptions, tailEvents } from "../core/events";

export interface EventsListOptions {
  since?: string;
  type?: string;
  ref?: string;
  /** Test seam — overrides events.jsonl path / clock. */
  ctx?: EventsContext;
}

/**
 * Parse `--since` accepting either a byte-offset cursor (`@offset:<int>`) for
 * cross-process resumption, or a timestamp / epoch-ms (the existing form).
 * Returns one of `{ sinceOffset }` or `{ since }`.
 */
function parseSinceFlag(since: string | undefined): {
  since?: string;
  sinceOffset?: number;
} {
  if (since === undefined) return {};
  const trimmed = since.trim();
  if (!trimmed) {
    throw new UsageError("--since cannot be empty.", "INVALID_FLAG_VALUE");
  }
  if (trimmed.startsWith("@offset:")) {
    const raw = trimmed.slice("@offset:".length);
    const value = Number.parseInt(raw, 10);
    if (Number.isNaN(value) || value < 0) {
      throw new UsageError(
        `Invalid --since byte offset: "${since}". Expected @offset:<non-negative integer>.`,
        "INVALID_FLAG_VALUE",
      );
    }
    return { sinceOffset: value };
  }
  return { since: normalizeSince(trimmed) };
}

export interface EventsListResult {
  schemaVersion: 1;
  totalCount: number;
  ref?: string;
  type?: string;
  since?: string;
  /** Echoed when --since @offset:N was used. */
  sinceOffset?: number;
  nextOffset: number;
  events: EventEnvelope[];
}

function validateRef(ref: string | undefined): string | undefined {
  if (ref === undefined) return undefined;
  const trimmed = ref.trim();
  if (!trimmed) {
    throw new UsageError("--ref cannot be empty.", "INVALID_FLAG_VALUE");
  }
  parseAssetRef(trimmed);
  return trimmed;
}

function normalizeSince(since: string | undefined): string | undefined {
  if (since === undefined) return undefined;
  const trimmed = since.trim();
  if (!trimmed) {
    throw new UsageError("--since cannot be empty.", "INVALID_FLAG_VALUE");
  }
  // Accept ISO timestamp (preferred), epoch ms, or plain date.
  if (/^\d+$/.test(trimmed)) {
    const ms = Number.parseInt(trimmed, 10);
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) {
      throw new UsageError(`Invalid --since value: ${since}`, "INVALID_FLAG_VALUE");
    }
    return d.toISOString();
  }
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    throw new UsageError(
      `Invalid --since value: ${since}. Expected ISO timestamp (e.g. 2026-04-01T00:00:00Z) or epoch ms.`,
      "INVALID_FLAG_VALUE",
    );
  }
  return parsed.toISOString();
}

export function akmEventsList(options: EventsListOptions = {}): EventsListResult {
  const ref = validateRef(options.ref);
  const parsed = parseSinceFlag(options.since);
  const result = readEvents(
    { since: parsed.since, sinceOffset: parsed.sinceOffset, type: options.type, ref },
    options.ctx,
  );
  return {
    schemaVersion: 1,
    totalCount: result.events.length,
    ...(ref !== undefined ? { ref } : {}),
    ...(options.type !== undefined ? { type: options.type } : {}),
    ...(parsed.since !== undefined ? { since: parsed.since } : {}),
    ...(parsed.sinceOffset !== undefined ? { sinceOffset: parsed.sinceOffset } : {}),
    nextOffset: result.nextOffset,
    events: result.events,
  };
}

export interface EventsTailOptions extends EventsListOptions {
  intervalMs?: number;
  maxDurationMs?: number;
  maxEvents?: number;
  signal?: AbortSignal;
  onEvent?: (event: EventEnvelope) => void;
}

export interface EventsTailResult extends EventsListResult {
  reason: "signal" | "maxEvents" | "maxDuration";
}

/** Trailer line discriminator for streaming jsonl output (#204). */
export interface EventsTailTrailer {
  _kind: "trailer";
  schemaVersion: 1;
  nextOffset: number;
  totalCount: number;
  reason: "signal" | "maxEvents" | "maxDuration";
}

export async function akmEventsTail(options: EventsTailOptions = {}): Promise<EventsTailResult> {
  const ref = validateRef(options.ref);
  const parsed = parseSinceFlag(options.since);
  const tailOptions: TailOptions = {
    since: parsed.since,
    sinceOffset: parsed.sinceOffset,
    type: options.type,
    ref,
    intervalMs: options.intervalMs,
    maxDurationMs: options.maxDurationMs,
    maxEvents: options.maxEvents,
    signal: options.signal,
    onEvent: options.onEvent,
  };
  const result = await tailEvents(tailOptions, options.ctx);
  return {
    schemaVersion: 1,
    totalCount: result.events.length,
    ...(ref !== undefined ? { ref } : {}),
    ...(options.type !== undefined ? { type: options.type } : {}),
    ...(parsed.since !== undefined ? { since: parsed.since } : {}),
    ...(parsed.sinceOffset !== undefined ? { sinceOffset: parsed.sinceOffset } : {}),
    nextOffset: result.nextOffset,
    events: result.events,
    reason: result.reason,
  };
}
