// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm migrate` is a pass-through over the standalone `akm-migrate`
 * executable: it re-emits the child's one JSON plan through the output
 * pipeline, forwards its stderr, and mirrors its exit code. The runner is a
 * parameter, so this proves the wrapper with a stand-in and no subprocess.
 */

import { afterEach, expect, spyOn, test } from "bun:test";
import { EXIT_CODES } from "../../src/cli/shared";
import { type RunMigrationTool, runMigrateSubcommand } from "../../src/commands/migrate-cli";
import { initOutputMode, resetOutputMode } from "../../src/output/context";

const priorExitCode = process.exitCode;
afterEach(() => {
  process.exitCode = priorExitCode;
  resetOutputMode();
});

function fakeTool(result: { status: number; stdout: string; stderr?: string }): {
  runTool: RunMigrationTool;
  calls: string[][];
} {
  const calls: string[][] = [];
  return {
    calls,
    runTool: async (args: readonly string[]) => {
      calls.push([...args]);
      return { status: result.status, stdout: result.stdout, stderr: result.stderr ?? "" };
    },
  };
}

function capture(): { logs: string[]; errs: string[]; restore: () => void } {
  initOutputMode(["--format", "json"]);
  const logs: string[] = [];
  const errs: string[] = [];
  // stdout is captured at the stream, exactly like stderr below: result
  // documents go through `writeStdout` (src/output/stdout.ts), not
  // `console.log`, because Bun's `console.log` truncates a payload larger than
  // the pipe buffer at 64 KiB.
  const log = spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
    logs.push(String(chunk));
    return true;
  }) as never);
  const err = spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
    errs.push(String(chunk));
    return true;
  }) as never);
  return {
    logs,
    errs,
    restore: () => {
      log.mockRestore();
      err.mockRestore();
    },
  };
}

test("status forwards the child's argv and re-emits its plan at exit 0", async () => {
  const plan = { schemaVersion: 1, status: "current", blockers: [], stateMigrations: { pending: [] } };
  const { runTool, calls } = fakeTool({ status: EXIT_CODES.SUCCESS, stdout: JSON.stringify(plan) });
  const out = capture();
  try {
    await runMigrateSubcommand("migrate-status", ["status"], runTool);
  } finally {
    out.restore();
  }
  expect(calls).toEqual([["status"]]);
  expect(JSON.parse(out.logs.join("\n"))).toMatchObject(plan);
  expect(process.exitCode).toBe(priorExitCode);
});

test("apply --dry-run reaches the child verbatim", async () => {
  const { runTool, calls } = fakeTool({ status: EXIT_CODES.SUCCESS, stdout: JSON.stringify({ status: "current" }) });
  const out = capture();
  try {
    await runMigrateSubcommand("migrate-apply", ["apply", "--dry-run"], runTool);
  } finally {
    out.restore();
  }
  expect(calls).toEqual([["apply", "--dry-run"]]);
});

test("a blocked plan is re-emitted and the child's exit code is mirrored", async () => {
  const plan = {
    schemaVersion: 1,
    status: "blocked",
    blockers: ["tasks/bad.yml: argv-array-has-no-portable-shell-string"],
  };
  const { runTool } = fakeTool({ status: EXIT_CODES.GENERAL, stdout: JSON.stringify(plan) });
  const out = capture();
  try {
    await runMigrateSubcommand("migrate-apply", ["apply"], runTool);
  } finally {
    out.restore();
  }
  expect(JSON.parse(out.logs.join("\n"))).toMatchObject(plan);
  expect(process.exitCode).toBe(EXIT_CODES.GENERAL);
});

test("a child that died with an error envelope has its stderr forwarded and its exit code mirrored", async () => {
  const envelope = `${JSON.stringify({ ok: false, error: "Invalid config", code: "INVALID_CONFIG_FILE" })}\n`;
  const { runTool } = fakeTool({ status: EXIT_CODES.CONFIG, stdout: "", stderr: envelope });
  const out = capture();
  try {
    await runMigrateSubcommand("migrate-status", ["status"], runTool);
  } finally {
    out.restore();
  }
  expect(out.errs.join("")).toBe(envelope);
  expect(out.logs).toEqual([]);
  expect(process.exitCode).toBe(EXIT_CODES.CONFIG);
});
