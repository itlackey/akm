/**
 * `src/core/children.ts`: the record of asynchronous child starts, and `execFileChild`'s `execFile` contract.
 */

import { describe, expect, test } from "bun:test";
import { execFileChild, runningChildren, spawnChild } from "../../src/core/children";

const run = (file: string, args: string[], options: Parameters<typeof execFileChild>[2] = {}) =>
  new Promise<{ error: ReturnType<typeof errorOf>; stdout: string; stderr: string }>((resolve) => {
    execFileChild(file, args, options, (error, stdout, stderr) => resolve({ error: errorOf(error), stdout, stderr }));
  });

const errorOf = (error: (Error & { code?: unknown; killed?: boolean }) | null) =>
  error && { code: error.code, killed: error.killed, message: error.message };

const posix = process.platform === "win32" ? test.skip : test;

describe("execFileChild", () => {
  posix("gives the output of a command that succeeds", async () => {
    expect(await run("sh", ["-c", "echo out; echo err >&2"])).toEqual({
      error: null,
      stdout: "out\n",
      stderr: "err\n",
    });
  });

  posix("gives the exit code of a command that fails, with its stderr", async () => {
    const { error, stderr } = await run("sh", ["-c", "echo bad >&2; exit 3"]);
    expect(error).toMatchObject({ code: 3, killed: false });
    expect(error?.message).toContain("bad");
    expect(stderr).toBe("bad\n");
  });

  test("gives ENOENT for a program that is not there", async () => {
    expect((await run("akm-no-such-program", [])).error).toMatchObject({ code: "ENOENT" });
  });

  posix("ends a command that runs past its timeout, and says it was killed", async () => {
    const { error } = await run("sleep", ["5"], { timeout: 100 });
    expect(error).toMatchObject({ killed: true });
  });

  posix("ends a command whose output passes maxBuffer", async () => {
    const { error } = await run("sh", ["-c", "yes | head -c 100000; sleep 5"], { maxBuffer: 1000 });
    expect(error).toMatchObject({ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", killed: true });
  });
});

describe("record", () => {
  posix("keeps a child while it runs and drops it once it has exited", async () => {
    const child = spawnChild("sleep", ["5"], { stdio: "ignore" });
    expect(runningChildren().map((c) => [c.pid, c.name])).toContainEqual([child.pid as number, "sleep 5"]);
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill();
    await exited;
    expect(runningChildren().map((c) => c.pid)).not.toContain(child.pid);
  });
});
