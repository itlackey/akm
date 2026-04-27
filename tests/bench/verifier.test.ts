/**
 * Unit tests for the verifier dispatcher. Covers each of the three
 * verifier kinds plus the missing-pytest graceful-127 path.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { SpawnedSubprocess, SpawnFn } from "../../src/integrations/agent/spawn";
import { runVerifier } from "./verifier";

let scratch: string;

beforeAll(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "bench-verifier-test-"));
});

afterAll(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

function fakeSpawn(exitCode: number, stdout = "", stderr = "", throwSync?: Error): SpawnFn {
  return (_cmd, _options) => {
    if (throwSync) throw throwSync;
    const proc: SpawnedSubprocess = {
      exitCode,
      exited: Promise.resolve(exitCode),
      stdout: stdout
        ? new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(stdout));
              controller.close();
            },
          })
        : null,
      stderr: stderr
        ? new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(stderr));
              controller.close();
            },
          })
        : null,
      stdin: null,
      kill() {
        /* noop */
      },
    };
    return proc;
  };
}

describe("runVerifier — script", () => {
  test("returns exit 0 when verify.sh succeeds", async () => {
    const taskDir = path.join(scratch, "script-pass");
    fs.mkdirSync(taskDir);
    fs.writeFileSync(path.join(taskDir, "verify.sh"), "");
    const workspace = fs.mkdtempSync(path.join(scratch, "ws-"));
    const result = await runVerifier(taskDir, workspace, "script", {
      spawn: fakeSpawn(0, "ok"),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("ok");
  });

  test("returns 127 when verify.sh is missing", async () => {
    const taskDir = path.join(scratch, "script-missing");
    fs.mkdirSync(taskDir);
    const workspace = fs.mkdtempSync(path.join(scratch, "ws-"));
    const result = await runVerifier(taskDir, workspace, "script", {
      spawn: fakeSpawn(0),
    });
    expect(result.exitCode).toBe(127);
    expect(result.stdout).toContain("verify.sh not found");
  });
});

describe("runVerifier — regex", () => {
  test("returns 0 when expected_match matches agent stdout", async () => {
    const result = await runVerifier(scratch, scratch, "regex", {
      agentStdout: "the agent printed: hello world",
      expectedMatch: "hello",
    });
    expect(result.exitCode).toBe(0);
  });

  test("returns 1 when expected_match does not match", async () => {
    const result = await runVerifier(scratch, scratch, "regex", {
      agentStdout: "different output",
      expectedMatch: "hello",
    });
    expect(result.exitCode).toBe(1);
  });

  test("returns 127 when expected_match missing", async () => {
    const result = await runVerifier(scratch, scratch, "regex", {
      agentStdout: "anything",
    });
    expect(result.exitCode).toBe(127);
    expect(result.stdout).toContain("expected_match");
  });

  test("returns 127 on invalid regex pattern", async () => {
    const result = await runVerifier(scratch, scratch, "regex", {
      agentStdout: "x",
      expectedMatch: "(",
    });
    expect(result.exitCode).toBe(127);
    expect(result.stdout).toContain("invalid regex");
  });
});

describe("runVerifier — pytest", () => {
  test("returns 127 with a clear message when pytest is missing", async () => {
    const result = await runVerifier(scratch, scratch, "pytest", {
      // Simulate ENOENT: spawn throws when bin not on PATH.
      spawn: fakeSpawn(0, "", "", new Error("ENOENT: pytest not found")),
    });
    expect(result.exitCode).toBe(127);
    expect(result.stdout).toContain("ENOENT");
  });

  test("returns the pytest exit code when present", async () => {
    const result = await runVerifier(scratch, scratch, "pytest", {
      spawn: fakeSpawn(0, "1 passed in 0.05s"),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("passed");
  });
});
