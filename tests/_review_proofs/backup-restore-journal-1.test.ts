// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { createMigrationBackup, restoreMigrationBackup } from "../../src/core/migration-backup";
import { getConfigPath, getStateDbPathInDataDir } from "../../src/core/paths";
import { type Cleanup, sandboxXdgCacheHome, sandboxXdgConfigHome, sandboxXdgDataHome } from "../_helpers/sandbox";

let cleanup: Cleanup | undefined;

beforeEach(() => {
  const config = sandboxXdgConfigHome();
  const cache = sandboxXdgCacheHome(config.cleanup);
  cleanup = sandboxXdgDataHome(cache.cleanup).cleanup;
});

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

function seedHealthyLegacyInstall(): { configBefore: string } {
  const configBefore = `${JSON.stringify({ configVersion: "0.8.0", profiles: { llm: { old: {} } } }, null, 2)}\n`;
  fs.writeFileSync(getConfigPath(), configBefore, { mode: 0o600 });
  fs.mkdirSync(path.dirname(getStateDbPathInDataDir()), { recursive: true });
  const state = new Database(getStateDbPathInDataDir());
  state.exec("PRAGMA journal_mode=WAL; CREATE TABLE durable(value TEXT); INSERT INTO durable VALUES ('before')");
  state.close();
  return { configBefore };
}

describe("PROOF: manual `migrate backup restore` is refused precisely in the recovery scenarios", () => {
  // Case 1 — the candidate's proposed scenario: live state.db corrupted by a
  // partial write / power loss. The user reaches for their verified good backup.
  test("corrupt live state.db => restore refused, good data NOT recovered through the tool", () => {
    const { configBefore } = seedHealthyLegacyInstall();

    const backup = createMigrationBackup();
    expect(backup.created).toBe(true);
    expect(backup.manifest.artifacts["state.db"].present).toBe(true);

    // Corrupt the live state.db (interrupted write): garbage main file, no WAL/SHM.
    const statePath = getStateDbPathInDataDir();
    for (const suffix of ["-wal", "-shm"]) {
      if (fs.existsSync(`${statePath}${suffix}`)) fs.rmSync(`${statePath}${suffix}`);
    }
    fs.writeFileSync(statePath, Buffer.from("not a sqlite database at all"));

    let threw: unknown;
    try {
      restoreMigrationBackup(true, backup.manifest.runId);
    } catch (error) {
      threw = error;
    }

    // DEFECT: restore is refused. (Proximate cause is even earlier than the
    // candidate said: assertNoArtifactReplacementBlockers -> activeWorkflowClaims
    // opens the corrupt state.db read-only and queries it with NO try/catch, so a
    // raw uncaught SQLite error escapes.)
    expect(threw).toBeDefined();
    expect(String((threw as Error).message)).toMatch(/file is not a database|unsafe|corrupt/i);

    // Harm: the live state.db is STILL the corrupt garbage — no recovery happened.
    expect(fs.readFileSync(statePath).toString("utf8")).toBe("not a sqlite database at all");
    expect(fs.readFileSync(getConfigPath(), "utf8")).toBe(configBefore);

    // The good backup itself is intact & readable — recovery was possible in
    // principle; only the tool refused it.
    const good = new Database(path.join(backup.path, "state.db"), { readonly: true });
    expect((good.query("SELECT value FROM durable").get() as { value: string }).value).toBe("before");
    good.close();
  });

  // Case 2 — the candidate's EXACT cited mechanism: createMigrationBackupUnlocked
  // -> assertBackupEligible. A downgrade leaves config.json "newer" while state.db
  // stays readable, so the earlier locks gate passes and we reach the rescue gate.
  test("newer config.json (post-downgrade) => restore refused by the rescue eligibility gate", () => {
    seedHealthyLegacyInstall();

    const backup = createMigrationBackup();
    expect(backup.created).toBe(true);

    // Accidental downgrade: config carries a version newer than this binary's.
    fs.writeFileSync(getConfigPath(), '{"configVersion":"99.0.0"}\n', { mode: 0o600 });

    let threw: unknown;
    try {
      restoreMigrationBackup(true, backup.manifest.runId);
    } catch (error) {
      threw = error;
    }

    // DEFECT (candidate's exact mechanism): the pre-restore rescue snapshot of the
    // live install is eligibility-gated and refuses because config.json=newer,
    // aborting the whole restore before any good bytes are published.
    expect(threw).toBeDefined();
    expect(String((threw as Error).message)).toMatch(/unsafe/i);
    expect(String((threw as Error).message)).toMatch(/config\.json=newer/i);

    // Harm: the live config is still the newer/incompatible one; restore blocked.
    expect(fs.readFileSync(getConfigPath(), "utf8")).toBe('{"configVersion":"99.0.0"}\n');
  });
});
