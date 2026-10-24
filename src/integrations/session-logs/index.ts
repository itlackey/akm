// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { getHarness, SESSION_LOG_HARNESSES } from "../harnesses";
import type {
  InlineRefMention,
  SessionData,
  SessionEvent,
  SessionLogHarness,
  SessionRef,
  SessionSummary,
} from "./types";

export { extractInlineRefMentions } from "./inline-refs";
export type { InlineRefMention, SessionData, SessionEvent, SessionLogHarness, SessionRef, SessionSummary };

// #562/P2 (plan §"Kill registry drift"): the provider array is DERIVED from
// the unified HARNESS_REGISTRY — every harness with `capabilities.sessionLogs`
// must supply a `sessionLogProvider` factory on its descriptor, and this is
// the only place providers are instantiated. Adding a session-log harness is
// therefore one registry entry, never an edit here.
//
// Ordered by canonical id so the pre-derivation provider order
// ([claude, opencode] — visible in e.g. `extract --auto` result order)
// is preserved deterministically, independent of HARNESS_REGISTRY declaration
// order (which is pinned for JSON-schema enum stability).
//
// WI-9.7 (H1): `SESSION_LOG_HARNESSES` is `HARNESS_REGISTRY` narrowed by the
// `isSessionLogHarness` type-predicate (see `../harnesses/types.ts`), so every
// element's `capabilities.sessionLogs` is the literal `true` and
// `sessionLogProvider` is a required (non-optional) field — a harness
// declaring `sessionLogs: true` without a provider is now a compile error at
// its `HARNESS_REGISTRY` entry, not a throw here. The load-time throw this
// used to guard (`h.sessionLogProvider?.()` returning undefined) is gone;
// `h.sessionLogProvider()` cannot be called with no provider to invoke.
const HARNESSES: SessionLogHarness[] = [...SESSION_LOG_HARNESSES]
  .sort((a, b) => a.id.localeCompare(b.id))
  .map((h) => h.sessionLogProvider());

// Every derived provider's `name` must exactly identify a registry harness whose
// `sessionLogs` capability is set. This is NOT expressible as a compile-time
// type constraint: `SessionLogHarness.name` is a runtime string with no
// static link to the `AkmHarness` that produced it, so a typo'd or
// stale `name` (e.g. copy-pasted from another provider, or renamed on one
// side only) would only ever surface as a wrong/silent lookup miss much later
// (health scans, `extract --auto` attribution) rather than here at load time.
// Kept as a runtime guard for that reason.
for (const provider of HARNESSES) {
  const harness = getHarness(provider.name);
  if (!harness?.capabilities.sessionLogs) {
    throw new Error(
      `[akm] session-log provider "${provider.name}" is not registered as a sessionLogs harness in HARNESS_REGISTRY (src/integrations/harnesses). Add it there.`,
    );
  }
}

/**
 * Returns all available session log harnesses for the current machine.
 * Add new harnesses to HARNESSES to support additional agent runtimes.
 */
export function getAvailableHarnesses(): SessionLogHarness[] {
  return HARNESSES.filter((harness) => harness.isAvailable());
}

export function normalizeSessionTopic(text: string): string | undefined {
  const normalized = text.replace(/\s+/g, " ").trim().toLowerCase();
  if (normalized.length < 10) return undefined;
  return normalized.slice(0, 60);
}
