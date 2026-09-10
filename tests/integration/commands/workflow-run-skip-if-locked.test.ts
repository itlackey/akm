// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm workflow run --skip-if-locked` (#948) — extends improve's
 * skip-gracefully-instead-of-failing semantics to `workflow run`. Drives the
 * real CLI in-process (`runCliCapture`), same as
 * tests/integration/commands/workflow-plan.test.ts.
 *
 * A held engine lease (the existing RUN_LEASE_HELD error, now a
 * TransientError per the #948 addendum — exit 75, sysexits EX_TEMPFAIL, not
 * exit 2 — so a cron wrapper retries instead of alerting;
 * workflow-runs-repository.ts's single-driver invariant, #924) is the
 * deterministic way to reproduce a `--skip-if-locked`-eligible failure at the
 * CLI boundary without racing real concurrent processes:
 *   - WITHOUT the flag: `akm workflow run <id>` fails exactly as today —
 *     exit 75, RUN_LEASE_HELD, naming the holder.
 *   - WITH the flag: the same failure is caught at the command boundary and
 *     turned into one warn line plus `{ ok: true, skipped: { reason:
 *     "lock-held", ... } }` at exit 0.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { resetConfigCache } from "../../../src/core/config/config";
import { withWorkflowRunsRepo } from "../../../src/storage/repositories/workflow-runs-repository";
import { startWorkflowRun } from "../../../src/workflows/runtime/runs";
import { runCliCapture } from "../../_helpers/cli";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeWorkflowTestConfig } from "../../_helpers/sandbox";

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

function isoIn(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

/** Plant a live engine lease directly through the repository (simulates another engine driving this run). */
async function plantLease(runId: string, holder: string, until: string): Promise<void> {
  await withWorkflowRunsRepo((repo) => {
    expect(repo.acquireEngineLease(runId, holder, until, new Date().toISOString())).toBe(true);
  });
}

describe("akm workflow run <id> against a held engine lease", () => {
  test("without --skip-if-locked: fails exactly as today — exit 75, RUN_LEASE_HELD, naming the holder", async () => {
    writeWorkflow("skip-lock-baseline");
    const started = await startWorkflowRun("workflows/skip-lock-baseline", {});
    const runId = started.run.id;
    await plantLease(runId, "other-engine", isoIn(90_000));

    const result = await runCliCapture(["workflow", "run", runId]);
    expect(result.code).toBe(75);
    const envelope = JSON.parse(result.stderr.trim()) as { ok: boolean; code: string; error: string };
    expect(envelope.ok).toBe(false);
    expect(envelope.code).toBe("RUN_LEASE_HELD");
    expect(envelope.error).toContain("other-engine");
  });

  test("with --skip-if-locked: exit 0, one warn line, and a skipped envelope naming lock-held", async () => {
    writeWorkflow("skip-lock-flag");
    const started = await startWorkflowRun("workflows/skip-lock-flag", {});
    const runId = started.run.id;
    await plantLease(runId, "other-engine", isoIn(90_000));

    const result = await runCliCapture(["workflow", "run", runId, "--skip-if-locked"]);
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("skipping (--skip-if-locked)");
    expect(result.stderr).toContain("other-engine");

    const envelope = JSON.parse(result.stdout.trim()) as {
      ok: boolean;
      target: string;
      skipped: { reason: string; message: string };
    };
    expect(envelope.ok).toBe(true);
    expect(envelope.target).toBe(runId);
    expect(envelope.skipped.reason).toBe("lock-held");
    expect(envelope.skipped.message).toContain("other-engine");

    // The lease is untouched — this invocation never attempted to drive the run.
    const stillLeased = await withWorkflowRunsRepo((repo) => repo.getRunById(runId));
    expect(stillLeased?.engine_lease_holder).toBe("other-engine");
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
