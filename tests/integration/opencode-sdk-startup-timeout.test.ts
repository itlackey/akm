// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * A run whose embedded OpenCode never finishes starting reports a timeout, and
 * the command that made it still ends: disposing the hosts (what the CLI and the
 * workflow engine do in a `finally`) asks the stuck start to stop, gives up on
 * it after a bounded wait, and leaves nothing that holds the process open.
 *
 * Integration-scoped (ORG-03/06): spawns a real process, on the real run and
 * dispose code with a host factory whose start never settles.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  type IsolatedAkmStorage,
  makeSandboxDir,
  type SandboxedDir,
  withIsolatedAkmStorage,
} from "../_helpers/sandbox";

const REPO_ROOT = path.resolve(import.meta.dir, "../..");

let storage: IsolatedAkmStorage;
let work: SandboxedDir;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  work = makeSandboxDir("akm-sdk-startup-timeout");
});

afterEach(() => {
  work.cleanup();
  storage.cleanup();
});

test.skipIf(process.platform === "win32")(
  "a run whose host never starts times out, and disposing the hosts lets the process end by itself",
  async () => {
    const script = path.join(work.dir, "stuck-start.ts");
    const src = (file: string) => JSON.stringify(path.join(REPO_ROOT, "src", file));
    fs.writeFileSync(
      script,
      [
        `import { _setOpencodeHostFactoryForTests } from ${src("integrations/harnesses/opencode/embedded/host.ts")};`,
        `import { runOpencodeSdk } from ${src("integrations/harnesses/opencode/embedded/run.ts")};`,
        `import { disposeDispatchResources } from ${src("integrations/agent/runner-dispatch.ts")};`,
        `import { runtimeProfile } from ${src("integrations/agent/profiles.ts")};`,
        "// A start that ignores every request to stop.",
        "_setOpencodeHostFactoryForTests(() => new Promise(() => {}));",
        'const connection = { kind: "connection", name: "lab", endpoint: "http://127.0.0.1:1/v1", model: "m", request: {}, timeoutMs: null };',
        'const result = await runOpencodeSdk(runtimeProfile(connection), { timeoutMs: 50, dispatch: { prompt: "p" } }, { endpoint: connection.endpoint, model: "m" });',
        'console.log("RESULT " + result.reason);',
        "await disposeDispatchResources();",
        'console.log("DISPOSED");',
        // No process.exit: the process must end on its own.
      ].join("\n"),
    );

    const child = spawn(process.execPath, [script], { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    const ended = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
    try {
      const outcome = await Promise.race([
        ended,
        new Promise<string>((resolve) => setTimeout(() => resolve("still running"), 30_000)),
      ]);
      expect(output).toContain("RESULT timeout");
      expect(output).toContain("DISPOSED");
      expect(outcome).toBe(0);
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
    }
  },
  60_000,
);
