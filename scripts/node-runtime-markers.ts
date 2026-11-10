// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Failure markers shared by the two gates that guard akm's Node fallback:
 * `scripts/node-smoke.ts` and `tests/integration/node-compat.test.ts`.
 *
 * They exist in one place because both run in the same CI step
 * (`bun run test:node-smoke && bun run test:node-compat`) and because the
 * strings are UPSTREAM-owned — Node's crash banner and its error codes can
 * change across majors. Duplicated, the two gates drift on that change: one
 * keeps matching and one silently stops, and the step still reports green from
 * the half that works. That is the shape of #790 itself, where a native abort
 * was reported only as "stdout missing expected substring" and got re-run
 * rather than diagnosed.
 *
 * Test/CI only — deliberately under `scripts/` rather than `src/`, so it is not
 * shipped in the published bundle. Tests importing from `scripts/` is the
 * established direction here (see tests/integration/install/package-install.test.ts);
 * no script imports from `tests/`.
 */

/**
 * Node's own banner when a native addon aborts the process (SIGABRT).
 *
 * Not a boundary leak — nothing in akm's JS produced it — but just as hard a
 * failure, and one both gates previously swallowed whenever the command had
 * already flushed enough stdout to satisfy their assertions.
 */
export const NATIVE_CRASH_MARKER = "----- Native stack trace -----";

/**
 * A Node-branch regression in the runtime boundary surfaces as one of these
 * even when the command still prints a usable result, so they are hard
 * failures rather than warnings.
 *
 * `appendEvent failed` is akm's own, not Node's: it is how a storage write that
 * fails only on the Node path announces itself.
 */
export const BOUNDARY_MARKERS = [
  "Bun is not defined",
  "ERR_MODULE_NOT_FOUND",
  "ERR_UNKNOWN_FILE_EXTENSION",
  "appendEvent failed",
] as const;
