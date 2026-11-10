// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { runManagedSubprocess } from "../../src/core/subprocess";
import { STANDALONE_FROZEN_SCRIPT_ARG } from "../../src/tasks/standalone-script-entry";
import { type Cleanup, makeSandboxDir, withIsolatedAkmStorage } from "../_helpers/sandbox";

/**
 * The managed subprocess delivers a stdin payload to a real child and closes
 * it. Integration-scoped: spawns a real process. Under Bun the pipe
 * is a FileSink, not a WritableStream; writing it as a stream failed silently
 * and the child waited for EOF until its timeout (the Claude and OpenCode harness
 * builders send the prompt this way).
 */

test("a stdin payload reaches the child, which then sees EOF", async () => {
  const result = await runManagedSubprocess(["cat"], {
    capture: true,
    stdin: 'Return JSON like {"ok": true}.\nSecond line',
    timeoutMs: 10_000,
  });
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toBe('Return JSON like {"ok": true}.\nSecond line');
});

describe("show-argv-entrypoint", () => {
  /**
   * Real-subprocess entrypoint test for the removed global `--shape` flag.
   *
   * `--shape` (0.10 folded `agent` into `--detail`) is an ordinary unknown
   * flag now. It must fail before any command runs, so a write command like
   * `remember` leaves nothing behind; that only holds for the real subprocess
   * entry point, so it lives in tests/integration/ on spawnSync.
   */

  const CLI = path.join(import.meta.dir, "..", "..", "src", "cli.ts");

  let cleanup: Cleanup = () => {};

  afterEach(() => {
    cleanup();
    cleanup = () => {};
  });

  function useStorage(): ReturnType<typeof withIsolatedAkmStorage> {
    const storage = withIsolatedAkmStorage();
    cleanup = storage.cleanup;
    return storage;
  }

  // The spawn passes `...process.env` on purpose: withIsolatedAkmStorage mutates
  // process.env (AKM_* / XDG dirs) for the current process, and the subprocess
  // must inherit those mutations to run against the isolated sandbox storage.
  function runEntrypointSpawn(args: string[]) {
    return spawnSync("bun", [CLI, ...args], {
      encoding: "utf8",
      env: { ...process.env },
      timeout: 30_000,
    });
  }

  describe("entrypoint removed --shape flag", () => {
    test("is an unknown flag (exit 2) and the write does not happen", () => {
      const storage = useStorage();

      const result = runEntrypointSpawn(["--format=json", "--shape=summary", "remember", "write me anyway"]);

      expect(result.status).toBe(2);
      expect(result.stderr).toContain("UNKNOWN_FLAG");
      const memories = path.join(storage.stashDir, "memories");
      expect(fs.existsSync(memories) ? fs.readdirSync(memories) : []).toEqual([]);
    });
  });
});

const REPO_ROOT = path.resolve(import.meta.dir, "../..");
const STANDALONE_ENTRY = path.join(REPO_ROOT, "scripts", "akm-standalone.ts");

async function runFrozenScript(file: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([process.execPath, STANDALONE_ENTRY, STANDALONE_FROZEN_SCRIPT_ARG, file], {
    cwd: REPO_ROOT,
    env: { ...process.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

describe("standalone frozen script entry", () => {
  test.each([
    ["js", 'const marker = "js-main";'],
    ["ts", 'const marker: string = "ts-main";'],
  ] as const)("runs a frozen .%s script with import.meta.main", async (extension, declaration) => {
    const sandbox = makeSandboxDir("akm-standalone-import-meta-main");
    const script = path.join(sandbox.dir, `snapshot.${extension}`);
    const marker = path.join(sandbox.dir, "marker");
    fs.writeFileSync(
      script,
      [
        'import fs from "node:fs";',
        declaration,
        `if (import.meta.main) fs.writeFileSync(${JSON.stringify(marker)}, marker);`,
        "",
      ].join("\n"),
      { mode: 0o700 },
    );

    try {
      const result = await runFrozenScript(script);
      expect(result.exitCode, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0);
      expect(fs.readFileSync(marker, "utf8")).toBe(extension === "js" ? "js-main" : "ts-main");
    } finally {
      sandbox.cleanup();
    }
  });
});
