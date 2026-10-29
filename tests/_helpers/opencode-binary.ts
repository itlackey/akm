// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The real OpenCode binary akm's own runtime runs, for the integration tests that
 * need it. It is fetched once, through akm's own fetch path
 * (`ensureRuntimeBinary`), into a cache the test runs share, and each test's
 * sandboxed akm cache links to it, so the first run in a sandbox finds it where
 * akm looks and fetches nothing. The shared cache is
 * `$AKM_TEST_OPENCODE_CACHE`, else `<repo>/node_modules/.cache/akm-test-opencode`.
 */

import fs from "node:fs";
import path from "node:path";
import {
  ensureRuntimeBinary,
  OPENCODE_RUNTIME_VERSION,
} from "../../src/integrations/harnesses/opencode/runtime/binary";
import { withEnv } from "./sandbox";

const SHARED_CACHE =
  process.env.AKM_TEST_OPENCODE_CACHE ?? path.resolve(import.meta.dir, "../../node_modules/.cache/akm-test-opencode");

/**
 * Fetch the binary into the shared cache if it is not there. Resolves to why it cannot be had (the registry is not
 * reachable, say), or undefined when it is there.
 */
export async function fetchSharedOpencode(): Promise<string | undefined> {
  try {
    await withEnv({ AKM_CACHE_DIR: SHARED_CACHE }, () => ensureRuntimeBinary());
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** Put the shared binary where akm looks for it under the akm cache `cacheDir`. */
export function linkSharedOpencode(cacheDir: string): void {
  const link = path.join(cacheDir, "opencode", OPENCODE_RUNTIME_VERSION);
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(path.join(SHARED_CACHE, "opencode", OPENCODE_RUNTIME_VERSION), link, "dir");
}
