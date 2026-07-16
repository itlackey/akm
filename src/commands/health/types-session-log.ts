// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Session-log advisory shape (chunk-9 WI-9.5d per-domain split of `./types`).
 * Sourced from `integrations/session-logs` execution-log candidates and
 * surfaced as informational entries on `AkmHealthResult.sessionLogAdvisories`.
 */

export interface SessionLogAdvisory {
  topic: string;
  frequency: number;
  source: string;
  isFailurePattern: boolean;
}
