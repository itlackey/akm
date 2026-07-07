// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Subprocess driver entrypoint for the MULTI-PROCESS workflow chaos tests
 * (tests/integration/workflow-*crossproc / crash-windows / db-contention).
 *
 * This is NOT a *.test.ts file: it is spawned as a real `bun` child by those
 * integration tests so two genuine OS processes drive the SAME workflow run
 * against ONE shared workflow.db — the only way to exercise the run-lease
 * single-driver invariant, crash-window resume, and cross-process SQLite
 * contention for real (an in-process fake cannot). It never touches a real
 * agent binary or LLM: unit dispatch and the completion-gate judge are fake
 * seams whose behaviour is driven entirely by env vars, so every scenario stays
 * deterministic and is synchronized on marker files / journal polling — never a
 * bare sleep as the sole coordination.
 *
 * Storage is shared with the parent purely through the inherited env
 * (AKM_STASH_DIR + XDG_* from the parent's `withIsolatedAkmStorage`). The parent
 * freezes the plan with `startWorkflowRun` before spawning; this driver only
 * needs the run id — `runWorkflowSteps` executes the FROZEN plan off the run
 * row, so the asset file is never re-read here.
 *
 * Env contract:
 *   CHAOS_RUN_ID        (required) run id to drive.
 *   CHAOS_MARKER_DIR    (required) directory for per-unit dispatch markers.
 *   CHAOS_HOLD_MATCH    if a unit prompt contains this substring, the dispatcher
 *                       writes a `holdstart.<unit>` marker then blocks until
 *                       CHAOS_RELEASE_FILE appears (or the signal aborts / the
 *                       process is killed) — the "stuck mid-dispatch" window.
 *   CHAOS_RELEASE_FILE  path whose existence releases every hold. Absent ⇒ hold
 *                       forever (the parent SIGKILLs).
 *   CHAOS_JUDGE         "none" (default) → no gate judge; "accept" → gate passes;
 *                       "hold" → judge writes `judgestart` then blocks on the
 *                       release file (the "units done, gate not finalized"
 *                       window).
 *   CHAOS_MAX_CONCURRENCY  optional integer engine concurrency cap.
 *
 * Exit codes: 0 = drove without throwing; 3 = threw (e.g. lease refusal — the
 * message, which names the holder, is written to stderr for the parent to
 * assert on).
 */

import fs from "node:fs";
import path from "node:path";
import type { UnitDispatchRequest, UnitDispatchResult } from "../../../src/workflows/exec/native-executor";
import { runWorkflowSteps } from "../../../src/workflows/exec/run-workflow";
import type { SummaryJudge } from "../../../src/workflows/validate-summary";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    process.stderr.write(`workflow-chaos-runner: missing required env ${name}\n`);
    process.exit(2);
  }
  return value;
}

const runId = requireEnv("CHAOS_RUN_ID");
const markerDir = requireEnv("CHAOS_MARKER_DIR");
const holdMatch = process.env.CHAOS_HOLD_MATCH || "";
const releaseFile = process.env.CHAOS_RELEASE_FILE || "";
const judgeMode = process.env.CHAOS_JUDGE || "none";
const maxConcurrency = process.env.CHAOS_MAX_CONCURRENCY ? Number(process.env.CHAOS_MAX_CONCURRENCY) : undefined;

/** Filesystem-safe, collision-free per-unit marker key. */
function unitKey(unitId: string): string {
  return Buffer.from(unitId, "utf8").toString("base64url");
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Block until the release file exists or the dispatch signal aborts. */
async function waitForRelease(signal: AbortSignal | undefined): Promise<void> {
  // No release file configured ⇒ block until aborted or killed (the parent
  // synchronizes on the holdstart marker, then SIGKILLs).
  for (;;) {
    if (signal?.aborted) return;
    if (releaseFile && fs.existsSync(releaseFile)) return;
    await sleep(25);
  }
}

const dispatcher = async (req: UnitDispatchRequest): Promise<UnitDispatchResult> => {
  // Append one line per dispatch so the parent can count side effects PER UNIT
  // (a reused durable row never reaches the dispatcher, so its count stays put).
  fs.appendFileSync(path.join(markerDir, `dispatch.${unitKey(req.unitId)}`), `${process.pid}\n`);
  if (holdMatch && req.prompt.includes(holdMatch)) {
    fs.writeFileSync(path.join(markerDir, `holdstart.${unitKey(req.unitId)}`), String(process.pid));
    await waitForRelease(req.signal);
  }
  return { ok: true, text: `did ${req.unitId}` };
};

const acceptJudge: SummaryJudge = async () => '{"complete": true, "missing": []}';

const holdJudge: SummaryJudge = async () => {
  // The gate row is already journaled `running` (journalGateEvaluationStart ran
  // before this inner judge). Signal the window is open, then block: a SIGKILL
  // here leaves a dangling running gate row + all units complete — the exact
  // "units done, step not finalized" crash window.
  fs.writeFileSync(path.join(markerDir, "judgestart"), String(process.pid));
  await waitForRelease(undefined);
  return '{"complete": true, "missing": []}';
};

const summaryJudge: SummaryJudge | null =
  judgeMode === "accept" ? acceptJudge : judgeMode === "hold" ? holdJudge : null;

async function main(): Promise<void> {
  try {
    await runWorkflowSteps({
      target: runId,
      summaryJudge,
      dispatcher,
      ...(maxConcurrency !== undefined ? { maxConcurrency } : {}),
    });
    process.exit(0);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(3);
  }
}

void main();
