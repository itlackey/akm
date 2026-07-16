// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Shared per-harness helpers (§4.6 dedup, WI-9.3).
 *
 * Home for the small helpers every per-harness module used to inline:
 * `caps()` (×10 byte-identical copies across the harness barrels) and
 * `homeDir()` (×2 across the config importers).
 *
 * This module is a dependency SINK by design: it must not import from
 * `./types`, `./index.ts`, or any per-harness barrel — those files sit
 * inside the harness/agent import cycle the cycle ratchet is dismantling,
 * and an edge back into that knot would enlist this file as a new cycle
 * participant. `HarnessCapabilities` therefore LIVES here; `./types`
 * re-exports it so existing import sites keep working unchanged.
 */

/**
 * Capability flags describing which of akm's six integration surfaces a
 * harness participates in. A subsystem filters `HARNESS_REGISTRY` by the
 * relevant flag instead of maintaining its own list.
 */
export interface HarnessCapabilities {
  /** Has readable native session logs (`akm extract`, session-logs index). */
  readonly sessionLogs: boolean;
  /** Can be spawned as an agent CLI / SDK (`akm propose`, reflect, tasks). */
  readonly agentDispatch: boolean;
  /** Participates in PATH/env detection during `akm setup`. */
  readonly detection: boolean;
  /** Can import an existing harness LLM/config into akm config. */
  readonly configImport: boolean;
  /** Reports a runtime identity string for workflow run attribution. */
  readonly runtimeIdentity: boolean;
}

/**
 * Build a complete {@link HarnessCapabilities} record from the flags a
 * harness actually declares — every omitted surface defaults to `false`.
 */
export function caps(c: Partial<HarnessCapabilities>): HarnessCapabilities {
  return {
    sessionLogs: false,
    agentDispatch: false,
    detection: false,
    configImport: false,
    runtimeIdentity: false,
    ...c,
  };
}

/** Home directory used for filesystem-only harness config detection. */
export function homeDir(): string {
  return process.env.HOME ?? process.env.USERPROFILE ?? "";
}
