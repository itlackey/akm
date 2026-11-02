// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** Values shared by the visual-harness server, its seed and the Playwright specs. */

/** The instant every visual run believes it is: a Wednesday. */
export const FIXED_NOW = "2026-06-17T14:20:00Z";

/**
 * One server per dataset, so a state that needs different data (a fresh sandbox, a quiet one,
 * the long-content fixture) is served rather than faked. `loaded` is the full seed.
 */
export const PROFILES = { loaded: 9391, empty: 9392, "low-data": 9393, "long-content": 9394 } as const;
export type Profile = keyof typeof PROFILES;
export const VISUAL_TOKEN = "visual-token";

/** The long-content fixture: a 63-char name makes an 80-char ref (`stash//knowledge/` is 17), and the query is 120 chars. */
export const LONG_NAME = "quarterly-incident-response-and-escalation-runbook-for-platform";
export const LONG_QUERY =
  "how do we escalate a failing deploy to the on-call platform engineer when the usual channel is down and the pager is sil";
