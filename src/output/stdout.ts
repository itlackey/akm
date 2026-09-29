// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The single stdout writer for result documents.
 *
 * WHY NOT `console.log`: on Bun, once `process.stdout` has been materialized
 * as a Node-compat stream — which this CLI does unconditionally, since
 * `--help`/`hints` write through it and `src/output/context.ts` reads
 * `isTTY` — `console.log(bigString)` issues a SINGLE `write(2)` against a
 * non-blocking fd 1 and silently discards whatever the kernel refused. A pipe
 * accepts at most one buffer (65,536 bytes on Linux), so `akm show … |
 * python3` lost everything past 64 KiB while `--output <file>` wrote the
 * whole document. `process.stdout.write` handles the short write correctly on
 * both runtimes, and the queued remainder keeps the event loop alive until it
 * drains, so the natural exit at the end of `runCli` still flushes it.
 *
 * The trailing newline is UNCONDITIONAL because that is exactly what
 * `console.log` appended: this is a transport fix, not a format change, and
 * `tests/integration/output-baseline.test.ts` pins the bytes either way.
 */
export function writeStdout(document: string): void {
  process.stdout.write(`${document}\n`);
}
