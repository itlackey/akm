/**
 * Bench tmp-root redirection (#276).
 *
 * Every bench tmp directory — per-(task, arm, seed) workspace, per-task
 * fixture stash, per-fixture evolveStash + preStash, plus the scratch dirs
 * spun up inside unit tests — lives under `${AKM_CACHE_DIR}/bench/`, NOT
 * `os.tmpdir()`.
 *
 * Why: during long bench/workflow runs, orphan tmp dirs from crashed agents
 * accumulate. When they pile up under `/tmp` the OS-level partition fills,
 * which breaks shells, browsers, npm caches, and the rest of the system.
 * Pinning bench tmp to the akm cache dir means a single
 * `rm -rf "$(akm config get cache.dir)/bench"` purges all bench scratch
 * without disturbing anything else.
 *
 * The bench cleanup machinery (`tests/bench/cleanup.ts`) also reaps
 * `${AKM_CACHE_DIR}/bench/*` entries older than 6 hours on the first
 * `registerCleanup` call to catch orphans from prior crashed runs.
 *
 * NOTE: this helper deliberately does NOT import `os.tmpdir()`. The
 * invariant test (`tests/bench/no-os-tmpdir-invariant.test.ts`) asserts
 * zero `os.tmpdir` references across `tests/bench/*.ts`.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { getCacheDir } from "../../src/core/paths";

/** Bench-tmp root: `${AKM_CACHE_DIR}/bench/`. Created lazily. */
export function benchTmpRoot(): string {
  const root = path.join(getCacheDir(), "bench");
  fs.mkdirSync(root, { recursive: true });
  return root;
}

/**
 * Create a fresh tmp directory under `benchTmpRoot()`.
 *
 * Drop-in replacement for `fs.mkdtempSync(path.join(os.tmpdir(), prefix))`.
 * The returned absolute path is unique per call.
 */
export function benchMkdtemp(prefix: string): string {
  return fs.mkdtempSync(path.join(benchTmpRoot(), prefix));
}
