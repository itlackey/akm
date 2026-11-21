// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * What a captured child is given and what akm keeps of its output, with real children: a captured child with no
 * payload sees the end of its input at once, and output past the retention cap is never spliced back in.
 */

import { expect, test } from "bun:test";
import path from "node:path";
import { runManagedSubprocess } from "../../src/core/subprocess";

const SUBPROCESS = path.resolve(import.meta.dir, "../../src/core/subprocess.ts");

test.skipIf(process.platform === "win32")(
  "a captured child given no input sees its end at once, though the caller's own input stays open",
  async () => {
    const host = Bun.spawn(
      [
        process.execPath,
        "-e",
        `const { runManagedSubprocess } = await import(${JSON.stringify(SUBPROCESS)});
         const result = await runManagedSubprocess(["cat"], { capture: true, timeoutMs: 20000 });
         console.log(JSON.stringify({ exitCode: result.exitCode, stdout: result.stdout }));`,
      ],
      { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
    );
    try {
      const ended = await Promise.race([host.exited, Bun.sleep(10_000).then(() => "still waiting" as const)]);
      expect(ended).toBe(0);
      expect(JSON.parse(await new Response(host.stdout).text())).toEqual({ exitCode: 0, stdout: "" });
    } finally {
      host.kill("SIGKILL");
    }
  },
  30_000,
);

test.skipIf(process.platform === "win32")(
  "output that comes after the retention cap was reached is not added to what was kept",
  async () => {
    // The cap falls inside the euro sign, so four bytes are kept and a later one-byte chunk would fit again.
    const result = await runManagedSubprocess(["sh", "-c", "printf 'AAAA\\342\\202\\254'; sleep 0.3; printf b"], {
      capture: true,
      maxOutputBytes: 5,
      timeoutMs: 10_000,
    });
    expect(result.stdout).toBe("AAAA");
    expect(result.stdoutRead.overflowed).toBe(true);
  },
  30_000,
);
