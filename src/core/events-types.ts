// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Leaf types for the append-only events stream (see `core/events.ts`).
 *
 * Split out of `core/events.ts` so that `storage/repositories/events-repository.ts`
 * (which `core/events.ts` imports the value-level `insertEvent`/`readStateEvents`
 * from) does not need a type-only import back into `core/events.ts` — that
 * back-edge is a static-graph cycle even though it is type-only (chunk 9
 * WI-9.8 KILL 1 sever). `core/events.ts` re-exports `EventEnvelope` from here
 * so existing import sites are unaffected.
 */

export interface EventEnvelope {
  schemaVersion: 1;
  id: number;
  ts: string;
  eventType: string;
  ref?: string;
  metadata?: Record<string, unknown>;
}
