// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * REVIEW PROOF — candidate: "a crash INSIDE the state-converting migration
 * transaction leaves a hot state.db-wal that trips the exact-generation guard
 * with no committed marker -> migrate apply becomes unresumable and restore is
 * refused."
 *
 * Faithful reproduction of the untested window:
 *   1. Drive the REAL `migrate apply` to `AKM_TEST_MIGRATION_CRASH_AFTER=state-converting`,
 *      which SIGKILLs right AFTER the journal is advanced to `state-converting`
 *      (generation fingerprinted with wal=shm=null) and BEFORE the migration
 *      transaction opens state.db. This produces a genuine on-disk journal+backup.
 *   2. Simulate the mid-transaction crash a moment later: plant a genuine,
 *      valid state.db-wal (+ -shm) on the UNCHANGED state.db main file (the
 *      killed txn rolled back -> main bytes identical, no committed marker, but
 *      -wal/-shm physically present on disk).
 *   3. Re-run `migrate apply` and observe whether it resumes (fix) or wedges.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  fingerprintMigrationGeneration,
  getMigrationApplyJournalPath,
  restoreMigrationBackup,
  sameMigrationGeneration,
} from "../../src/core/migration-backup";
import { getConfigPath, getDataDir, getStateDbPathInDataDir } from "../../src/core/paths";
import { openStateDbAtCeiling, PRE_CUTOVER_STATE_CEILING } from "../_fixtures/migration/seed-rows";
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

function sha(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

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
    })}\n`,
  );
  return prepared;
}

/**
 * Plant a genuine leftover WAL on state.db while leaving the main file
 * byte-identical (the on-disk shape a SIGKILL'd, rolled-back WAL transaction
 * leaves: main unchanged, -wal/-shm physically present, no committed marker).
 */
function plantStrayWal(statePath: string): void {
  const mainOriginal = fs.readFileSync(statePath);
  const w = new Database(statePath);
  w.exec("PRAGMA wal_autocheckpoint = 0");
  w.exec("CREATE TABLE __akm_crash_leftover__(x)"); // committed frame -> written to -wal
  const walBytes = fs.readFileSync(`${statePath}-wal`);
  const shmPath = `${statePath}-shm`;
  const shmBytes = fs.existsSync(shmPath) ? fs.readFileSync(shmPath) : null;
  w.close(); // last connection -> checkpoints into main + removes -wal/-shm
  // Undo the checkpoint (restore original main) and re-plant the genuine -wal/-shm.
  fs.writeFileSync(statePath, mainOriginal);
  fs.writeFileSync(`${statePath}-wal`, walBytes);
  if (shmBytes) fs.writeFileSync(shmPath, shmBytes);
}

describe("REVIEW PROOF — state-converting mid-txn crash leaves a hot -wal", () => {
  test("interrupted state-converting migration wedges: apply cannot resume, restore refused", async () => {
    const statePath = getStateDbPathInDataDir();
    openStateDbAtCeiling(statePath, PRE_CUTOVER_STATE_CEILING).close();
    const prepared = writeConfigs();

    const mainBeforeApply = sha(statePath);
    expect(fs.existsSync(`${statePath}-wal`)).toBe(false); // realistic clean install: no leftover wal

    // (1) Drive the real apply and SIGKILL right after the journal reaches
    //     state-converting (generation captured BEFORE the DB is opened).
    const child = Bun.spawn(["bun", "src/cli.ts", "migrate", "apply", "--config", prepared], {
      cwd: path.resolve(import.meta.dir, "../.."),
      env: { ...process.env, AKM_TEST_MIGRATION_CRASH_AFTER: "state-converting" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exitCode).not.toBe(0);

    const journalPath = getMigrationApplyJournalPath();
    expect(fs.existsSync(journalPath)).toBe(true);
    const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
    expect(journal.phase).toBe("state-converting");
    // Premise: generation fingerprinted with wal=shm=null (DB not yet opened).
    expect(journal.generation.state.wal).toBeNull();
    expect(journal.generation.state.shm).toBeNull();
    // The migration never opened state.db, so main is still the pre-apply bytes.
    expect(sha(statePath)).toBe(mainBeforeApply);

    // (2) Simulate the mid-txn crash a moment later: hot -wal, main unchanged.
    plantStrayWal(statePath);
    expect(fs.existsSync(`${statePath}-wal`)).toBe(true);
    expect(sha(statePath)).toBe(mainBeforeApply); // main byte-identical -> logically unchanged

    // The stray -wal/-shm are exactly what defeats the exact-generation guard.
    const current = fingerprintMigrationGeneration();
    expect(sameMigrationGeneration(current, journal.generation)).toBe(false);

    // (3) Try to resume. A correct implementation would resume+complete
    //     (journal cleared, exit 0). Observe what actually happens.
    const r1 = await runCliCapture(["migrate", "apply"]);
    const r2 = await runCliCapture(["migrate", "apply"]); // prove it is not a one-shot self-heal

    // eslint-disable-next-line no-console
    console.error("RESUME#1 code=", r1.code, "stderr=", r1.stderr.trim().slice(0, 400));
    console.error("RESUME#2 code=", r2.code, "stderr=", r2.stderr.trim().slice(0, 400));
    console.error("wal still present after resumes:", fs.existsSync(`${statePath}-wal`));

    // Wedge assertions: both resume attempts fail and the journal never clears.
    expect(r1.code).not.toBe(0);
    expect(r2.code).not.toBe(0);
    expect(fs.existsSync(journalPath)).toBe(true); // never advanced past state-converting
    expect(fs.existsSync(`${statePath}-wal`)).toBe(true); // no self-heal: -wal is never reclaimed

    // Restore is also refused while the (unresumable) apply journal exists.
    let restoreErr = "";
    try {
      restoreMigrationBackup(true);
    } catch (e) {
      restoreErr = e instanceof Error ? e.message : String(e);
    }
    console.error("RESTORE refusal:", restoreErr);
    expect(restoreErr).toContain("run `akm migrate apply` before restore");
  }, 30_000);
});
