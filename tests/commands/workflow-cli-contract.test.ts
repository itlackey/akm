// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * CLI-level contract tests for the `akm workflow` family, pinning the exit
 * code + JSON envelope the module-level suites (run-lease) prove only at the
 * function boundary:
 *
 *   - unknown workflow refs use consistent structured envelopes;
 *   - starting a run surfaces a workflow's compiler warnings as
 *     non-fatal `warn()` lines on stderr; the run still starts.
 *
 * Driven in-process via `runCliCapture` against per-test isolated storage
 * (`withIsolatedAkmStorage`) — no real agent binary, LLM, git, or subprocess, so
 * the suite stays deterministic, order-independent, and parallel-safe.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { _setWarnSinkForTests } from "../../src/core/warn";
import { startWorkflowRun } from "../../src/workflows/runtime/runs";
import { runCliCapture } from "../_helpers/cli";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeWorkflowTestConfig } from "../_helpers/sandbox";
import { withSeam } from "../_helpers/seams";

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  writeWorkflowTestConfig();
});

afterEach(() => storage.cleanup());

describe("akm workflow refs — unknown bundles fail consistently", () => {
  test("run, list, and status return the usage envelope", async () => {
    const commands = [
      ["workflow", "run", "ghost//missing"],
      ["workflow", "list", "--ref", "ghost//missing"],
      ["workflow", "status", "ghost//missing"],
    ];
    for (const command of commands) {
      const result = await runCliCapture([...command]);
      expect(result.code, `${command.join(" ")}: ${result.stderr}`).toBe(2);
      expect(JSON.parse(result.stderr)).toMatchObject({ ok: false, code: "WORKFLOW_SOURCE_INVALID" });
    }
  });
});

describe("workflow run start boundary — surfaces program warnings on stderr", () => {
  /**
   * Write a unified-format workflow that trips a non-fatal warning
   * (`collectWorkflowWarnings`, ir/compile.ts): the map step's `map.over`
   * references `params.changed_file`, a typo of the declared
   * `params.changed_files`. Prose is never scanned for references (spec §2.3),
   * so this warning's only surface is `map.over` / `route.input`.
   *
   * It used to trip a second warning as well — the step declares no `output:`
   * schema — but #886 deleted that advisory for firing on every step while
   * guarding nothing.
   */
  function writeWarnyProgram(stashDir: string, name: string): string {
    const file = path.join(stashDir, "workflows", `${name}.md`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      [
        "---",
        "type: workflow",
        "description: Warny driver workflow",
        "params:",
        "  changed_files: { type: array }",
        "steps:",
        "  - id: review",
        "    map:",
        "      over: params.changed_file",
        "---",
        "",
        "## review",
        "",
        "Review the changed files given by the map item.",
        "",
      ].join("\n"),
      "utf8",
    );
    return file;
  }

  test("starting a run emits the program's warnings as non-fatal warn() lines", async () => {
    writeWarnyProgram(storage.stashDir, "warny-start");
    const captured: string[] = [];
    await withSeam(
      _setWarnSinkForTests,
      (level, args) => {
        if (level === "warn") captured.push(args.map((a) => String(a)).join(" "));
      },
      async () => {
        const started = await startWorkflowRun("workflows/warny-start");
        // Non-fatal: the run still starts.
        expect(started.run.status).toBe("active");
      },
    );
    const joined = captured.join("\n");
    expect(joined).toMatch(/workflow run:.*params\.changed_file.*not declared/);
  });
});
