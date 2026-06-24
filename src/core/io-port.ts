// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Stdin I/O seam (#664 Seam 4).
 *
 * stdin is the one host resource read from a leaf helper with no dependency
 * boundary reachable from a test, so it gets an ambient, harness-scoped slot
 * (the lone ambient seam in the design). The slot defaults to the REAL
 * implementation — `process.stdin.isTTY`, `fs.readFileSync(0)`, and the
 * Bun/Node stdin stream — so production behaviour is unchanged.
 *
 * This module sits below `common.ts`: it imports only `node:fs` and the
 * `runtime.ts` stdin-stream boundary helper, so wiring `tryReadStdinText`
 * (common.ts) and `readStdin` (runtime.ts) as thin delegates here cannot create
 * a `common.ts ↔ runtime.ts` import cycle. The `runtime.ts ↔ io-port.ts` edge it
 * does introduce is import-cycle-safe: every imported binding is used only
 * inside a function body, never at module-evaluation time (ESM live bindings).
 *
 * The slot is PRODUCTION-IMMUTABLE: `setStdinPort` throws unless
 * `AKM_TEST_HARNESS === "1"`, so only the test harness can swap it. It accepts a
 * `Partial<StdinPort>` and merges over the real port, so a sync-path test need
 * not satisfy the async member (and vice versa). `resetStdinPort()` restores the
 * real port and is wired into the harness `resetAllProcessState`.
 *
 * @module io-port
 */

import fs from "node:fs";
import { stdinByteStream } from "../runtime";

/** Sync text read — the body of `tryReadStdinText` (`fs.readFileSync(0)`). */
export type StdinTextReader = () => string;
/** Async byte read — the body of `readStdin` (the Bun/Node stdin stream loop). */
export type StdinByteReader = (limit: number, onLimitExceeded: () => Error) => Promise<Buffer>;

export interface StdinPort {
  /** Whether stdin is a TTY (no pipe). */
  isTty(): boolean;
  /** Read all of stdin as UTF-8 text, synchronously. */
  readText: StdinTextReader;
  /** Read all of stdin as bytes, enforcing a byte limit. */
  readBytes: StdinByteReader;
}

async function realReadBytes(limitBytes: number, onLimitExceeded: () => Error): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of stdinByteStream()) {
    total += chunk.byteLength;
    if (total > limitBytes) throw onLimitExceeded();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** The real stdin port — the production path. */
const realStdinPort: StdinPort = {
  isTty: () => process.stdin.isTTY === true,
  readText: () => fs.readFileSync(0, "utf8"),
  readBytes: realReadBytes,
};

let activeStdinPort: StdinPort = realStdinPort;

/** The active stdin port. Defaults to the real impl. */
export function getStdinPort(): StdinPort {
  return activeStdinPort;
}

/**
 * Install a stdin port. TEST-ONLY: throws unless `AKM_TEST_HARNESS === "1"`, so
 * production code can never mutate the ambient slot. Accepts a partial port and
 * merges it over the real one (override only the member a test needs). Returns
 * the previous port so a test can restore it.
 */
export function setStdinPort(port: Partial<StdinPort> | null): StdinPort {
  if (process.env.AKM_TEST_HARNESS !== "1") {
    throw new Error("setStdinPort is test-only (requires AKM_TEST_HARNESS=1)");
  }
  const prev = activeStdinPort;
  activeStdinPort = port ? { ...realStdinPort, ...port } : realStdinPort;
  return prev;
}

/** Restore the real stdin port. Wired into the harness `resetAllProcessState`. */
export function resetStdinPort(): void {
  activeStdinPort = realStdinPort;
}
