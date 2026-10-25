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

// The provider array is DERIVED from the unified HARNESS_REGISTRY: every harness
// with a `sessionLogProvider` factory on its descriptor, and this is the only
// place providers are instantiated. Adding a session-log harness is therefore
// one registry entry, never an edit here.
//
// Ordered by canonical id so the pre-derivation provider order
// ([claude, opencode] — visible in e.g. `extract --auto` result order)
// is preserved deterministically, independent of HARNESS_REGISTRY declaration
// order (which is pinned for JSON-schema enum stability).
const HARNESSES: SessionLogHarness[] = [...SESSION_LOG_HARNESSES]
  .sort((a, b) => a.id.localeCompare(b.id))
  .map((h) => h.sessionLogProvider());

// Every derived provider's `name` must exactly identify the registry harness that
// produced it. `SessionLogHarness.name` is a runtime string with no static link to
// the `AkmHarness`, so a typo'd or stale `name` would only surface as a silent
// lookup miss much later (health scans, `extract --auto` attribution) rather than
// here at load time.
for (const provider of HARNESSES) {
  if (!getHarness(provider.name)?.sessionLogProvider) {
    throw new Error(
      `[akm] session-log provider "${provider.name}" is not registered as a session-log harness in HARNESS_REGISTRY (src/integrations/harnesses). Add it there.`,
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
