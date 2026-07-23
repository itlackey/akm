// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * REVIEW PROOF (cross-cutting: filesystem mutations outside the backup/rollback
 * envelope).
 *
 * Candidate: a stray workflow.db left behind by a silently-failed
 * `deleteWorkflowDb` (fs.rmSync throws non-ENOENT: EACCES/EPERM/EBUSY) after a
 * COMPLETED `migrate apply` permanently wedges the install:
 *   - `migrate status` reports "ready" forever (workflow.db present ->
 *     needsApply true), and
 *   - every subsequent `migrate apply` mints a NEW random operationId, re-enters
 *     the cutover, hits the committed akm_cutover_ledger marker (owned by the
 *     ORIGINAL operationId), throws, and fail-closed-rolls-back to the SAME stray
 *     state — so the leftover workflow.db is never cleaned and the user gets no
 *     guided recovery.
 *
 * The failed unlink is simulated faithfully by copying the ORIGINAL pre-cutover
 * workflow.db back into place after a successful apply (exactly what remains on
 * disk when rmSync throws).
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { getConfigPath, getDataDir, getStateDbPathInDataDir } from "../../src/core/paths";
import { getLegacyWorkflowDbPath } from "../../src/migrate/legacy/legacy-paths";
import { buildRcTrainFromState } from "../_fixtures/migration/rc-train-state";
import { runCliCapture } from "../_helpers/cli";
import {
  type Cleanup,
  sandboxHome,
  sandboxXdgCacheHome,
  sandboxXdgConfigHome,
  sandboxXdgDataHome,
} from "../_helpers/sandbox";

let cleanup: Cleanup | undefined;

beforeEach(() => {
  const home = sandboxHome();
  const config = sandboxXdgConfigHome(home.cleanup);
  const cache = sandboxXdgCacheHome(config.cleanup);
  cleanup = sandboxXdgDataHome(cache.cleanup).cleanup;
});

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

function writePreparedConfig(): string {
  fs.mkdirSync(path.dirname(getConfigPath()), { recursive: true });
  fs.writeFileSync(getConfigPath(), `${JSON.stringify({ configVersion: "0.8.0" })}\n`, { mode: 0o600 });
  const prepared = path.join(path.dirname(getConfigPath()), "prepared-0.9.json");
  fs.writeFileSync(
    prepared,
    `${JSON.stringify({
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      stashDir: path.join(getDataDir(), "stash"),
      sources: [{ type: "filesystem", path: path.join(getDataDir(), "team"), name: "team", writable: true }],
      installed: [{ id: "reg-kit", source: "npm", ref: "@scope/kit", stashRoot: path.join(getDataDir(), "kit") }],
    })}\n`,
  );
  return prepared;
}

/** Count committed cutover-ledger markers in the live state.db. */
function cutoverMarkerCount(): number {
  const db = new Database(getStateDbPathInDataDir(), { readonly: true });
  try {
    const t = db
      .query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='akm_cutover_ledger'")
      .get();
    if (!t) return 0;
    return (db.query("SELECT COUNT(*) AS n FROM akm_cutover_ledger").get() as { n: number }).n;
  } finally {
    db.close();
  }
}

/** Parse the `migrate status` plan JSON out of captured stdout. */
function statusPlan(stdout: string): { status: string } {
  const line = stdout
    .split("\n")
    .reverse()
    .find((l) => l.includes('"status"'));
  if (!line) throw new Error(`no plan JSON in status stdout:\n${stdout}`);
  return JSON.parse(line);
}

test("a stray workflow.db after a completed apply permanently wedges migrate apply", async () => {
  buildRcTrainFromState(getDataDir());
  const workflowPath = getLegacyWorkflowDbPath();
  expect(fs.existsSync(workflowPath)).toBe(true);
  const prepared = writePreparedConfig();

  // Preserve the ORIGINAL pre-cutover workflow.db so we can put it back exactly as
  // a silently-failed rmSync would leave it.
  const stashedWorkflow = path.join(getDataDir(), "workflow.db.saved-original");
  fs.copyFileSync(workflowPath, stashedWorkflow);

  // (1) First apply succeeds and (normally) deletes workflow.db.
  const first = await runCliCapture(["migrate", "apply", "--config", prepared]);
  expect(first.code, first.stderr).toBe(0);
  expect(fs.existsSync(workflowPath)).toBe(false);

  // (2) Simulate deleteWorkflowDb's rmSync throwing (EACCES/EPERM/EBUSY): the
  // original workflow.db is still on disk.
  fs.copyFileSync(stashedWorkflow, workflowPath);
  expect(fs.existsSync(workflowPath)).toBe(true);

  // (3) `migrate status` now misreports a pending migration.
  const status1 = await runCliCapture(["migrate", "status"]);
  expect(status1.code, status1.stderr).toBe(0);
  expect(statusPlan(status1.stdout).status).toBe("ready");

  // Sanity: state.db really is the committed post-cutover DB (has the cutover
  // ledger marker), i.e. the migration DID complete the first time.
  expect(cutoverMarkerCount()).toBe(1);

  // (4) A fresh apply re-enters the cutover, hits the committed marker under a NEW
  // operationId, and fails closed. It must NOT clean the stray workflow.db.
  const second = await runCliCapture(["migrate", "apply"]);
  expect(second.code).not.toBe(0);
  expect(fs.existsSync(workflowPath)).toBe(true); // still there — never cleaned

  // The rollback restored the SAME stray state: state.db still carries the
  // committed cutover marker (post-cutover), not a pre-cutover DB. Nothing
  // advanced; the stray workflow.db is still present. (Byte-identity is NOT
  // asserted — the rollback restores from a VACUUM-INTO backup that re-serializes
  // the DB, per scenario (e).)
  expect(cutoverMarkerCount()).toBe(1);

  // (5) Status is STILL "ready" — the wedge is permanent, not transient.
  const status2 = await runCliCapture(["migrate", "status"]);
  expect(statusPlan(status2.stdout).status).toBe("ready");

  // (6) And a THIRD apply repeats identically -> unrecoverable without manual
  // deletion of workflow.db.
  const third = await runCliCapture(["migrate", "apply"]);
  expect(third.code).not.toBe(0);
  expect(fs.existsSync(workflowPath)).toBe(true);

  // Surface the actual user-facing error for the report.
  console.error("SECOND APPLY STDERR:", second.stderr.trim().slice(0, 600));
}, 30_000);
