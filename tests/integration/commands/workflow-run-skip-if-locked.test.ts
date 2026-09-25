// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm workflow run --skip-if-locked` (#948) — extends improve's
 * skip-gracefully-instead-of-failing semantics to `workflow run`. Drives the
 * real CLI in-process (`runCliCapture`), same as
 * tests/integration/commands/workflow-plan.test.ts.
 *
 * A held per-run lock (RUN_LEASE_HELD, a TransientError — exit 75, sysexits
 * EX_TEMPFAIL, not exit 2 — so a cron wrapper retries instead of alerting) is
 * the deterministic way to reproduce a `--skip-if-locked`-eligible failure at
 * the CLI boundary without racing real concurrent processes. The planted
 * lock's holder is this (live) test process:
 *   - WITHOUT the flag: `akm workflow run <id>` fails — exit 75,
 *     RUN_LEASE_HELD, naming the holder pid.
 *   - WITH the flag: the same failure is caught at the command boundary and
 *     turned into one warn line plus `{ ok: true, skipped: { reason:
 *     "lock-held", ... } }` at exit 0.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { resetConfigCache } from "../../../src/core/config/config";
import { workflowRunLockPath } from "../../../src/workflows/exec/run-workflow";
import { startWorkflowRun } from "../../../src/workflows/runtime/runs";
import { runCliCapture } from "../../_helpers/cli";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeWorkflowTestConfig } from "../../_helpers/sandbox";
import { plantRunLock } from "../../_helpers/workflow";

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  writeWorkflowTestConfig();
  resetConfigCache();
});

afterEach(() => {
  resetConfigCache();
  storage.cleanup();
});

function writeWorkflow(name: string): void {
  const file = path.join(storage.stashDir, "workflows", `${name}.md`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    ["---", "type: workflow", "steps:", "  - id: only-step", "---", "", "## only-step", "", "Do the thing.", ""].join(
      "\n",
    ),
    "utf8",
  );
}

describe("akm workflow run <id> against a held run lock", () => {
  test("without --skip-if-locked: exit 75, RUN_LEASE_HELD, naming the holder pid", async () => {
    writeWorkflow("skip-lock-baseline");
    const started = await startWorkflowRun("workflows/skip-lock-baseline", {});
    const runId = started.run.id;
    const release = plantRunLock(runId);

    const result = await runCliCapture(["workflow", "run", runId]);
    release();
    expect(result.code).toBe(75);
    const envelope = JSON.parse(result.stderr.trim()) as { ok: boolean; code: string; error: string };
    expect(envelope.ok).toBe(false);
    expect(envelope.code).toBe("RUN_LEASE_HELD");
    expect(envelope.error).toContain(`pid ${process.pid}`);
  });

  test("with --skip-if-locked: exit 0, one warn line, and a skipped envelope naming lock-held", async () => {
    writeWorkflow("skip-lock-flag");
    const started = await startWorkflowRun("workflows/skip-lock-flag", {});
    const runId = started.run.id;
    const release = plantRunLock(runId);

    const result = await runCliCapture(["workflow", "run", runId, "--skip-if-locked"]);
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("skipping (--skip-if-locked)");
    expect(result.stderr).toContain(`pid ${process.pid}`);

    const envelope = JSON.parse(result.stdout.trim()) as {
      ok: boolean;
      target: string;
      skipped: { reason: string; message: string };
    };
    expect(envelope.ok).toBe(true);
    expect(envelope.target).toBe(runId);
    expect(envelope.skipped.reason).toBe("lock-held");
    expect(envelope.skipped.message).toContain(`pid ${process.pid}`);

    // The lock is untouched — this invocation never attempted to drive the run.
    expect(fs.existsSync(workflowRunLockPath(runId))).toBe(true);
    release();
  });

  test("--skip-if-locked does not swallow an unrelated usage error (e.g. an unknown run id)", async () => {
    const result = await runCliCapture(["workflow", "run", "does-not-exist", "--skip-if-locked"]);
    expect(result.code).not.toBe(0);
    const envelope = JSON.parse(result.stderr.trim()) as { ok: boolean; code: string };
    expect(envelope.ok).toBe(false);
    expect(envelope.code).not.toBe("RUN_LEASE_HELD");
    expect(envelope.code).not.toBe("STATE_DB_CONTENDED");
  });
});
