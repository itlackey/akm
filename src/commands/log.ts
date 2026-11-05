// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Programmatic event listing behind `akm log` (#204).
 *
 * Programmatic surface — the CLI dispatcher in `src/cli.ts` registers the
 * `log` leaf command that delegates here. Returns a JSON envelope shaped by
 * `src/output/shapes.ts` so the output flows through the same shape and
 * text-renderer pipeline as the rest of the CLI (no silent
 * `JSON.stringify` fallback).
 *
 * 0.9.0 CLI overhaul (S3): `akmEventsTail` (and the `log tail` command it
 * backed) was dropped — a foreground polling daemon in a one-shot CLI. The
 * lower-level `tailEvents` poller it wrapped (src/core/events.ts) had no
 * other caller and was removed with it.
 */

import { makeBundleRef, parseBundleRef } from "../core/asset/asset-ref";
import { type AkmConfig, loadConfig } from "../core/config/config";
import { ConfigError, UsageError } from "../core/errors";
import { type EventsContext, readEvents } from "../core/events";
import type { EventEnvelope } from "../core/events-types";
import { parseSinceToIso } from "../core/time";
import { currentConceptId } from "../indexer/lookup/adapter-concept-owner";
import { resolveSourceEntries, type SearchSource } from "../indexer/search/search-source";

export interface EventsListOptions {
  since?: string;
  type?: string;
  ref?: string;
  excludeTags?: string[];
  includeTags?: string[];
  /** D-38: cap the result to the most recent `limit` matching events. Undefined is unlimited. */
  limit?: number;
  /**
   * Filter to events whose `metadata.runId` matches — the replacement for
   * the dropped `akm workflow watch <run-id>`'s run-scoped filter (0.9.0
   * CLI overhaul, S5).
   */
  run?: string;
  /** Test seam — overrides the state database / clock. */
  ctx?: EventsContext;
}

/**
 * Parse `--since` accepting either an opaque row cursor (`@offset:<int>`) for
 * cross-process resumption, or a timestamp / epoch-ms.
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
        `Invalid --since offset: "${since}". Expected @offset:<non-negative integer>.`,
        "INVALID_FLAG_VALUE",
      );
    }
    return { sinceOffset: value };
  }
  return { since: parseSinceToIso(trimmed) };
}

export interface EventsListResult {
  schemaVersion: 1;
  totalCount: number;
  ref?: string;
  type?: string;
  since?: string;
  /** Echoed when --since @offset:N was used. */
  sinceOffset?: number;
  /** Echoed when --limit was passed. */
  limit?: number;
  /** Echoed when --run was passed. */
  run?: string;
  nextOffset: number;
  events: EventEnvelope[];
}

function validateRef(ref: string | undefined): string | undefined {
  if (ref === undefined) return undefined;
  const trimmed = ref.trim();
  if (!trimmed) {
    throw new UsageError("--ref cannot be empty.", "INVALID_FLAG_VALUE");
  }
  const parsed = parseBundleRef(trimmed);
  const config = loadConfig();
  // Deliberately shallow qualification: a bare conceptId is assumed to mean
  // the default bundle, without the full priority-walk `resolveRef` performs —
  // event refs are recorded fully qualified, so the default is the only
  // spelling a short --ref can usefully mean here. An old spelling matches the
  // events re-keyed to the asset's ref; with no bundle it is matched as written.
  return makeBundleRef(parsed.bundle ?? config.defaultBundle, currentConceptId(parsed, logSources(config)));
}

function logSources(config: AkmConfig): SearchSource[] {
  try {
    return resolveSourceEntries(undefined, config);
  } catch (error) {
    if (error instanceof ConfigError) return [];
    throw error;
  }
}

function validateRunId(run: string | undefined): string | undefined {
  if (run === undefined) return undefined;
  const trimmed = run.trim();
  if (!trimmed) {
    throw new UsageError("--run cannot be empty.", "INVALID_FLAG_VALUE");
  }
  return trimmed;
}

export function akmEventsList(options: EventsListOptions = {}): EventsListResult {
  const ref = validateRef(options.ref);
  const run = validateRunId(options.run);
  const parsed = parseSinceFlag(options.since);
  const result = readEvents(
    {
      since: parsed.since,
      sinceOffset: parsed.sinceOffset,
      type: options.type,
      ref,
      runId: run,
      excludeTags: options.excludeTags,
      includeTags: options.includeTags,
      limit: options.limit,
    },
    options.ctx,
  );
  return {
    schemaVersion: 1,
    totalCount: result.events.length,
    ...(ref !== undefined ? { ref } : {}),
    ...(options.type !== undefined ? { type: options.type } : {}),
    ...(parsed.since !== undefined ? { since: parsed.since } : {}),
    ...(parsed.sinceOffset !== undefined ? { sinceOffset: parsed.sinceOffset } : {}),
    ...(options.limit !== undefined ? { limit: options.limit } : {}),
    ...(run !== undefined ? { run } : {}),
    nextOffset: result.nextOffset,
    events: result.events,
  };
}
