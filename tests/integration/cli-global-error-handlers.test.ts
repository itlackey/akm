// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * VALUE-11: real-subprocess coverage for the global `unhandledRejection` /
 * `uncaughtException` handlers registered at the top of src/cli.ts
 * — both must retain stable machine-readable classifications.
 *
 * WHY A REAL SUBPROCESS: both handlers terminate the process. Triggering
 * them in-process would kill the test runner itself.
 *
 * WHY A THROWAWAY HARNESS FILE, NOT THE CLI DIRECTLY: the handlers exist to
 * catch failures OUTSIDE the normal command-dispatch/`runWithJsonErrors`
 * envelope — "Background timers, fire-and-forget appendEvent writes, and
 * lazy `import()` failures" per their own doc comment (src/cli.ts:33-38).
 * There is no supported CLI flag/command that manufactures one of these on
 * demand, and adding a test-only trigger flag to production code would be
 * worse than testing the real thing. Instead, each test writes a tiny
 * harness `.ts` file that `import`s the real, unmodified src/cli.ts — an
 * import (not the entry point) leaves `import.meta.main` false, so only the
 * unconditional top-of-module handler registration runs, none of the
 * startup/dispatch machinery — then performs the exact class of
 * fire-and-forget failure the handlers document as their target: an
 * unawaited rejected promise for `unhandledRejection`, and a throw from a
 * `setTimeout` callback for `uncaughtException`. The registered handlers are
 * the CLI's real production code; nothing here calls into them directly.
 *
 * PROOF THIS SUITE IS LOAD-BEARING: with both `process.on(...)`
 * registrations in src/cli.ts temporarily deleted, every test in this file
 * fails — Bun's default crash path prints a raw, non-JSON stack trace to
 * stderr, so `JSON.parse(result.stderr)` itself throws, and none of the
 * `code`/`ok`/`hint` assertions can even run. This was verified by hand
 * while writing this file (handlers removed → all tests red; handlers
 * restored byte-for-byte, confirmed via `git diff` → all tests green again).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CLI_ABS = path.join(import.meta.dir, "..", "..", "src", "cli.ts");

let harnessDir: string | undefined;

afterEach(() => {
  if (harnessDir) fs.rmSync(harnessDir, { recursive: true, force: true });
  harnessDir = undefined;
});

/**
 * Write a one-off harness file that imports the real src/cli.ts (for its
 * side-effecting global-handler registration only) followed by
 * `triggerSource` — arbitrary top-level statements producing a genuinely
 * unhandled rejection or uncaught exception — then run it as a real `bun`
 * subprocess.
 */
function runHarness(triggerSource: string, opts?: { debug?: boolean; retiredDebug?: boolean }) {
  harnessDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-cli-error-handler-"));
  const harnessFile = path.join(harnessDir, "harness.ts");
  fs.writeFileSync(harnessFile, `import ${JSON.stringify(CLI_ABS)};\n${triggerSource}\n`);

  const env = { ...process.env };
  if (opts?.debug) {
    env.AKM_VERBOSE = "1";
  } else {
    delete env.AKM_VERBOSE;
  }
  if (opts?.retiredDebug) env.AKM_DEBUG = "1";
  else delete env.AKM_DEBUG;

  return spawnSync("bun", [harnessFile], { encoding: "utf8", env, timeout: 15_000 });
}

describe("src/cli.ts global unhandledRejection handler", () => {
  test("a fire-and-forget rejected promise uses the classified JSON envelope and exits 70", () => {
    const result = runHarness('Promise.reject(new Error("value-11 probe: unhandled rejection"));');

    expect(result.status).toBe(70);
    const envelope = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(envelope.ok).toBe(false);
    expect(envelope.code).toBe("UNHANDLED_REJECTION");
    expect(envelope.error).toBe("Unhandled rejection: value-11 probe: unhandled rejection");
    expect(envelope.hint).toContain("--verbose");
  });

  test("a non-Error rejection reason is stringified into the error message", () => {
    // reason instanceof Error ? reason : new Error(String(reason)) — exercise
    // the non-Error branch explicitly.
    const result = runHarness('Promise.reject("plain string reason");');

    expect(result.status).toBe(70);
    const envelope = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(envelope.code).toBe("UNHANDLED_REJECTION");
    expect(envelope.error).toBe("Unhandled rejection: plain string reason");
  });

  test("AKM_VERBOSE=1 appends the real stack trace after the JSON envelope", () => {
    const result = runHarness('Promise.reject(new Error("value-11 probe: debug stack"));', { debug: true });

    expect(result.status).toBe(70);
    expect(result.stderr).toContain('"code": "UNHANDLED_REJECTION"');
    expect(result.stderr).toContain("Error: value-11 probe: debug stack");
    // The stack trace prints AFTER the JSON block (console.error(err.stack)
    // runs once the JSON.stringify(...) call above it has already printed),
    // not interleaved inside it.
    const jsonEnd = result.stderr.indexOf("}");
    const stackStart = result.stderr.indexOf("Error: value-11 probe: debug stack");
    expect(jsonEnd).toBeGreaterThan(-1);
    expect(stackStart).toBeGreaterThan(jsonEnd);
  });
});

describe("src/cli.ts global uncaughtException handler", () => {
  test("a throw from a background timer uses the classified JSON envelope and exits 70", () => {
    const result = runHarness('setTimeout(() => { throw new Error("value-11 probe: uncaught exception"); }, 0);');

    expect(result.status).toBe(70);
    const envelope = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(envelope.ok).toBe(false);
    expect(envelope.code).toBe("UNCAUGHT_EXCEPTION");
    expect(envelope.error).toBe("Uncaught exception: value-11 probe: uncaught exception");
    expect(envelope.hint).toContain("--verbose");
  });

  test("AKM_VERBOSE=1 appends the real stack trace after the JSON envelope", () => {
    const result = runHarness('setTimeout(() => { throw new Error("value-11 probe: debug stack"); }, 0);', {
      debug: true,
    });

    expect(result.status).toBe(70);
    expect(result.stderr).toContain('"code": "UNCAUGHT_EXCEPTION"');
    expect(result.stderr).toContain("Error: value-11 probe: debug stack");
    const jsonEnd = result.stderr.indexOf("}");
    const stackStart = result.stderr.indexOf("Error: value-11 probe: debug stack");
    expect(jsonEnd).toBeGreaterThan(-1);
    expect(stackStart).toBeGreaterThan(jsonEnd);
  });
});

describe("AKM_DEBUG is retired", () => {
  test("AKM_DEBUG=1 alone no longer prints a stack trace", () => {
    const result = runHarness('Promise.reject(new Error("value-11 probe: retired debug"));', { retiredDebug: true });

    expect(result.status).toBe(70);
    expect(result.stderr).not.toContain("Error: value-11 probe: retired debug\n");
    expect(result.stderr).not.toContain("    at ");
  });
});
