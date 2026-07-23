// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * REVIEW PROOF — candidate: "a stray workflow.db-shm left by an interrupted
 * three-DB cutover defeats workflowArtifactIsDeletionSubset / the workflow-applied
 * resume guard, wedging `migrate apply`."
 *
 * Mechanism under test:
 *   - The frozen workflow roll closes the WAL workflow.db cleanly, so the journal
 *     generation recorded at phase `workflow-applied` has workflow.shm = null.
 *   - runThreeDbCutover ATTACHes + SELECTs that WAL workflow.db, which SQLite
 *     satisfies by (re)creating workflow.db-shm. A power-loss / SIGKILL anywhere
 *     in the ATTACH..DETACH span leaves that -shm on disk.
 *   - On resume, fingerprintMigrationGeneration() now reports workflow.shm != null,
 *     so it no longer matches the recorded generation and is not a deletion-subset
 *     of it. Every guided recovery arm for phase `workflow-applied` throws
 *     "does not match the exact live artifact generation", and `backup restore`
 *     refuses while the apply journal exists — a circular wedge.
 *
 * The real cutover has NO crash hook inside the live-shm window (the only hook,
 * `cutover-commit`, fires AFTER DETACH removed the -shm), so the crash is
 * simulated faithfully: build the exact `workflow-applied` crashed state with the
 * REAL flow (AKM_TEST_MIGRATION_CRASH_AFTER=workflow), then drop the one stray
 * sidecar the ATTACH would have left.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import {
  fingerprintMigrationGeneration,
  getMigrationApplyJournalPath,
  restoreMigrationBackup,
  sameMigrationGeneration,
} from "../../src/core/migration-backup";
import { getConfigPath, getDataDir } from "../../src/core/paths";
import { getLegacyWorkflowDbPath } from "../../src/migrate/legacy/legacy-paths";
import { buildRcTrainFromState, rcTrainFromStatePaths } from "../_fixtures/migration/rc-train-state";
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

function writeConfigs(): string {
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

/** Drive the real flow to the `workflow-applied` phase, then SIGKILL. */
async function crashAtWorkflowApplied(prepared: string): Promise<void> {
  const child = Bun.spawn(["bun", "src/cli.ts", "migrate", "apply", "--config", prepared], {
    cwd: path.resolve(import.meta.dir, "../.."),
    env: { ...process.env, AKM_TEST_MIGRATION_CRASH_AFTER: "workflow" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(exitCode).not.toBe(0); // killed by SIGKILL, not a clean exit
}

describe("interrupted three-DB cutover leaves a workflow.db-shm", () => {
  test("a stray workflow.db-shm wedges migrate apply resume AND blocks backup restore", async () => {
    buildRcTrainFromState(getDataDir());
    const { workflowDbPath } = rcTrainFromStatePaths(getDataDir());
    expect(fs.existsSync(workflowDbPath)).toBe(true);
    const prepared = writeConfigs();

    await crashAtWorkflowApplied(prepared);

    // Crashed exactly at the pre-cutover boundary.
    const journalPath = getMigrationApplyJournalPath();
    const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
    expect(journal.phase).toBe("workflow-applied");
    // The frozen roll closed the WAL workflow.db cleanly -> no -shm recorded.
    expect(journal.generation.workflow.shm).toBe(null);
    const shmPath = `${getLegacyWorkflowDbPath()}-shm`;
    const walPath = `${getLegacyWorkflowDbPath()}-wal`;
    expect(fs.existsSync(shmPath)).toBe(false);

    // Guard would PASS right now (nothing diverged): a resume without the stray
    // sidecar re-runs the idempotent cutover.
    const gen0 = fingerprintMigrationGeneration();
    expect(sameMigrationGeneration(gen0, journal.generation)).toBe(true);

    // Realism: the workflow.db really is WAL (0.8.x default) and the cutover's
    // ATTACH+SELECT really creates workflow.db-shm.
    const wdb = new Database(getLegacyWorkflowDbPath());
    try {
      const mode = (wdb.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode;
      expect(mode.toLowerCase()).toBe("wal");
    } finally {
      wdb.close();
    }
    const probeMain = path.join(getDataDir(), "probe-main.db");
    const pdb = new Database(probeMain);
    try {
      pdb.exec(`ATTACH DATABASE '${getLegacyWorkflowDbPath()}' AS wf`);
      pdb.query("SELECT count(*) AS n FROM wf.workflow_runs").get();
      // The ATTACH of a WAL db + a read created the wal-index sidecar.
      expect(fs.existsSync(shmPath)).toBe(true);
    } finally {
      pdb.close();
    }
    // Reset back to the recorded (clean) generation before the wedge scenario.
    for (const p of [probeMain, `${probeMain}-wal`, `${probeMain}-shm`, shmPath, walPath]) {
      fs.rmSync(p, { force: true });
    }
    expect(sameMigrationGeneration(fingerprintMigrationGeneration(), journal.generation)).toBe(true);

    // === The crash: a SIGKILL mid-cutover leaves the ATTACH's workflow.db-shm. ===
    fs.writeFileSync(shmPath, Buffer.alloc(32768));

    const gen1 = fingerprintMigrationGeneration();
    expect(gen1.workflow.shm).not.toBe(null);
    // The stray sidecar alone diverges the fingerprint from the recorded one.
    expect(sameMigrationGeneration(gen1, journal.generation)).toBe(false);

    // migrate apply REFUSES to resume the (idempotent, re-runnable) cutover.
    const resumed = await runCliCapture(["migrate", "apply"]);
    expect(resumed.code).not.toBe(0);
    expect(`${resumed.stdout}${resumed.stderr}`).toContain("does not match the exact live artifact generation");
    // The apply journal survives -> the operation is still pending.
    expect(fs.existsSync(journalPath)).toBe(true);

    // backup restore ALSO refuses while the apply journal exists -> circular wedge.
    let restoreErr = "";
    try {
      restoreMigrationBackup(true);
      throw new Error("restoreMigrationBackup should have refused");
    } catch (e) {
      restoreErr = e instanceof Error ? e.message : String(e);
    }
    expect(restoreErr).toContain("Migration apply recovery is pending");

    // CONTROL: remove ONLY the stray sidecar -> the same interrupted migration
    // resumes to completion. Proves the -shm was the sole cause of the wedge.
    fs.rmSync(shmPath, { force: true });
    const recovered = await runCliCapture(["migrate", "apply"]);
    expect(recovered.code, `${recovered.stdout}${recovered.stderr}`).toBe(0);
    expect(fs.existsSync(journalPath)).toBe(false);
  }, 30_000);
});
