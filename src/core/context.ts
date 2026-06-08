// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Data-path context (C2 — env-threading parameter object).
 *
 * Several read paths (`akmHealth`, the events stream, probes) historically
 * resolved `<dataDir>/state.db` from `process.env.XDG_DATA_HOME` LIVE at call
 * time, by calling `getStateDbPathInDataDir()` / `getDataDir()` deep in the
 * call tree. That is the root cause of the #553/#554/#499 flaky timeouts:
 * parallel test files mutate `XDG_DATA_HOME` in `beforeEach`, and an async
 * yield lets file B's reassignment redirect file A's DB open/migrate to a
 * wrong or just-deleted tmpdir — surfacing as a hang, not an assertion.
 *
 * The fix is the parameter-object pattern: resolve the data paths ONCE at the
 * command boundary into a `DataContext`, then thread that object down to the
 * leaves so they never re-read the environment. Production callers resolve the
 * context from `process.env` at process start (no parallel mutation there);
 * tests pass an explicit context and never race on the global.
 *
 * This type intentionally lives in `src/core` (no services layer).
 */

import path from "node:path";
import { getDataDir } from "./paths";

export interface DataContext {
  /** The resolved akm data directory (durable, non-regenerable state). */
  dataDir: string;
  /** `<dataDir>/state.db` — the events / task-history / proposals database. */
  stateDbPath: string;
}

/**
 * Resolve a {@link DataContext} ONCE from the given environment. Call this at a
 * command boundary and thread the result down; leaves must not re-read env.
 *
 * `env` defaults to `process.env` for production callers. Tests should pass an
 * explicit `dataDir` (preferred) or a pinned `env` so the resolved paths never
 * race with another test file's `process.env.XDG_DATA_HOME` mutation.
 */
export function resolveDataContext(opts: { dataDir?: string; env?: NodeJS.ProcessEnv } = {}): DataContext {
  const dataDir = opts.dataDir ?? getDataDir(opts.env ?? process.env);
  return {
    dataDir,
    stateDbPath: path.join(dataDir, "state.db"),
  };
}
