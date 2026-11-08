// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { makeBundleRef, parseBundleRef } from "../../core/asset/asset-ref";
import { rethrowIfTestIsolationError } from "../../core/errors";
import { appendEvent, readEvents } from "../../core/events";
import { withStateDbTelemetry } from "../../core/state-db";
import { TELEMETRY_BUSY_TIMEOUT_MS, withIndexDb } from "../../storage/repositories/index-db";
import {
  findEntryIdByRef,
  getEntryById,
  getEntryIdByFilePath,
  getItemRefById,
} from "../../storage/repositories/index-entries-repository";
import { usageEventAttributionMetadata } from "../search/search-attribution";
import { insertUsageEvent, type UsageEventSource } from "./usage-events";

/** Count prior show events in the current one-hour loop-detection window. */
export function recentShowCount(ref: string): number {
  try {
    return readEvents({
      type: "show",
      ref,
      since: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    }).events.length;
  } catch {
    return 0;
  }
}

/** Compare search/display selectors by their durable parent asset identity. */
function traceParentRef(ref: string): string {
  try {
    const parsed = parseBundleRef(ref);
    return makeBundleRef(parsed.bundle, parsed.conceptId);
  } catch {
    // Registry result refs are not local bundle refs and cannot have a local
    // selector. Keep their existing exact comparison behavior.
    return ref;
  }
}

function appendShowTrace(ref: string, type: string, name: string): void {
  appendEvent({ eventType: "show", ref, metadata: { type, name } });
  try {
    const { events: recentSearches } = readEvents({
      type: "search",
      since: new Date(Date.now() - 60_000).toISOString(),
    });
    const cutoffMs = Date.now() - 60_000;
    const matchingSearch = [...recentSearches].reverse().find((event) => {
      if (!event.ts || new Date(event.ts).getTime() < cutoffMs) return false;
      const refs = (event.metadata?.resultRefs as string[] | undefined) ?? [];
      return refs.some((candidate) => traceParentRef(candidate) === ref);
    });
    if (!matchingSearch) return;
    const resultRefs = (matchingSearch.metadata?.resultRefs as string[] | undefined) ?? [];
    appendEvent({
      eventType: "select",
      ref,
      metadata: {
        query: matchingSearch.metadata?.query as string | undefined,
        searchTs: matchingSearch.ts,
        searchId: matchingSearch.metadata?.searchId as string | undefined,
        source: matchingSearch.metadata?.source as string | undefined,
        rankPosition: resultRefs.findIndex((candidate) => traceParentRef(candidate) === ref),
      },
    });
  } catch {
    // Selection attribution is best-effort.
  }
}

function insertShowUsage(
  entryId: number | undefined,
  entryRef: string,
  derivedFrom: unknown,
  eventSource: UsageEventSource,
  project?: string,
): void {
  withStateDbTelemetry((stateDb) => {
    insertUsageEvent(stateDb, {
      event_type: "show",
      entry_ref: entryRef,
      entry_id: entryId,
      metadata: usageEventAttributionMetadata(
        derivedFrom ? { memoryInference: { exposure: "direct" } } : undefined,
        entryRef,
        "full",
        project,
      ),
      source: eventSource,
    });
  }, TELEMETRY_BUSY_TIMEOUT_MS);
}

/** Record a successful show using the already-rendered response identity. */
export function recordShowUsage(
  ref: string,
  type: string,
  name: string,
  eventSource: UsageEventSource = "user",
  filePath?: string,
  project?: string,
): void {
  const parsed = parseBundleRef(ref);
  const eventRef = makeBundleRef(parsed.bundle, parsed.conceptId);
  appendShowTrace(eventRef, type, name);
  try {
    withIndexDb(
      (db) => {
        const entryId = filePath ? getEntryIdByFilePath(db, filePath) : findEntryIdByRef(db, eventRef);
        if (entryId === undefined) return;
        const entryRef = getItemRefById(db, entryId);
        if (!entryRef) return;
        insertShowUsage(entryId, entryRef, getEntryById(db, entryId)?.entry.derivedFrom, eventSource, project);
      },
      { busyTimeoutMs: TELEMETRY_BUSY_TIMEOUT_MS },
    );
  } catch (error) {
    rethrowIfTestIsolationError(error);
  }
}

/**
 * Record a nested execution-source read only after dispatch has crossed
 * preflight. The caller holds the source's durable `bundle//conceptId` ref, so
 * no index connection is opened.
 */
export function recordIndexedShowUsage(
  ref: string,
  type: string,
  name: string,
  eventSource: UsageEventSource = "user",
): void {
  appendShowTrace(ref, type, name);
  try {
    insertShowUsage(undefined, ref, undefined, eventSource);
  } catch (error) {
    rethrowIfTestIsolationError(error);
  }
}
