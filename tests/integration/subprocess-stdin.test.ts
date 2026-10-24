// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The managed subprocess delivers a stdin payload to a real child and closes
 * it. Integration-scoped (ORG-03): spawns a real process. Under Bun the pipe
 * is a FileSink, not a WritableStream; writing it as a stream failed silently
 * and the child waited for EOF until its timeout (the OpenCode 2 CLI path sends
 * its prompt this way).
 */

import { expect, test } from "bun:test";
import { runManagedSubprocess } from "../../src/core/subprocess";

test("a stdin payload reaches the child, which then sees EOF", async () => {
  const result = await runManagedSubprocess(["cat"], {
    capture: true,
    stdin: 'Return JSON like {"ok": true}.\nSecond line',
    timeoutMs: 10_000,
  });
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toBe('Return JSON like {"ok": true}.\nSecond line');
});
