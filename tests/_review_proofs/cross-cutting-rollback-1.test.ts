// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * REVIEW PROOF — dimension: filesystem mutations outside the backup/rollback envelope.
 *
 * Candidate claim: `backup restore` (and the automatic pre-cutover rollback that
 * shares its engine, `replaceArtifactsFromBundle`) reverts ONLY the four backed-up
 * artifacts (config.json / state.db / workflow.db / index.db). Every filesystem
 * mutation the migration performs OUTSIDE those artifacts — the `.stash.json`
 * sidecar fold+delete and the D-R6 reserved-filename rename (both real work of
 * `runContentMigration`), plus the task `.yml` target rewrite — is NOT captured in
 * the backup and NOT reverted by restore. A user who runs `backup restore --confirm`
 * to return to 0.8 gets 0.8 DBs/config sitting on a half-0.9 filesystem.
 *
 * This test drives the REAL functions: `createMigrationBackup`, the REAL migration
 * FS step `runContentMigration`, the REAL config-shape migrator, and the REAL
 * `restoreMigrationBackup`. It asserts restore reverts config.json (a covered
 * artifact) while silently leaving the sidecar deleted and the reserved file renamed.
 */

import { beforeEach, afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { createMigrationBackup, restoreMigrationBackup } from "../../src/core/migration-backup";
import { getConfigPath, getDataDir, getStateDbPathInDataDir } from "../../src/core/paths";
import { runContentMigration } from "../../src/migrate/legacy/content-migration";
import { migrateConfigSourcesToBundles } from "../../src/migrate/legacy/config-source-migration";
import { writeLegacyStashFile } from "../../src/migrate/legacy/legacy-stash-json";
import { openStateDbAtCeiling, PRE_CUTOVER_STATE_CEILING } from "../_fixtures/migration/seed-rows";
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

test("backup restore reverts config.json but silently leaves content-migration FS mutations in 0.9 shape", () => {
  // ── build a realistic pre-migration 0.8.x install ─────────────────────────
  const stashRoot = path.join(getDataDir(), "stash");
  const conceptDir = path.join(stashRoot, "skills");
  fs.mkdirSync(conceptDir, { recursive: true });

  // 1. A per-directory `.stash.json` sidecar carrying curated metadata for a
  //    markdown concept — the universal 0.8 layout.
  const conceptFile = "greeter.md";
  fs.writeFileSync(
    path.join(conceptDir, conceptFile),
    "---\nname: greeter\n---\nhello\n",
    { mode: 0o600 },
  );
  writeLegacyStashFile(conceptDir, {
    entries: [{ filename: conceptFile, name: "greeter", description: "curated: the greeter skill" } as never],
  });
  const sidecarPath = path.join(conceptDir, ".stash.json");
  expect(fs.existsSync(sidecarPath)).toBe(true);

  // 2. A reserved-name concept (`index.md`) carrying asset frontmatter — D-R6
  //    renames it to `index-content.md` during the committed cutover.
  const reservedPath = path.join(conceptDir, "index.md");
  fs.writeFileSync(reservedPath, "---\ndescription: a mis-placed concept\n---\nbody\n", { mode: 0o600 });

  // A well-formed 0.8 config (stashDir source shape) + a genuine pre-cutover state.db.
  fs.mkdirSync(path.dirname(getConfigPath()), { recursive: true });
  const base08 = { configVersion: "0.8.0", stashDir: stashRoot } as Record<string, unknown>;
  fs.writeFileSync(getConfigPath(), `${JSON.stringify(base08)}\n`, { mode: 0o600 });
  openStateDbAtCeiling(getStateDbPathInDataDir(), PRE_CUTOVER_STATE_CEILING).close();

  // ── the migration creates its verified backup FIRST ───────────────────────
  const backup = createMigrationBackup();
  const backedUpConfigBytes = fs.readFileSync(getConfigPath());

  // ── committed cutover work: REAL content migration + config-shape rewrite ──
  // These run AFTER workflow.db is deleted (past the point of no return); they
  // mutate the filesystem OUTSIDE the four backed-up artifacts.
  const report = runContentMigration([stashRoot]);
  expect(report.sidecarsFolded).toBe(1); // sidecar folded into frontmatter …
  expect(fs.existsSync(sidecarPath)).toBe(false); // … then DELETED
  expect(report.reservedRenames.length).toBe(1); // index.md → index-content.md
  expect(fs.existsSync(reservedPath)).toBe(false);
  expect(fs.existsSync(path.join(conceptDir, "index-content.md"))).toBe(true);

  // config-applied phase: config.json is rewritten to the 0.9 `bundles` shape.
  const config09 = migrateConfigSourcesToBundles(base08);
  config09.configVersion = "0.9.0";
  expect(config09.bundles).toBeDefined();
  fs.writeFileSync(getConfigPath(), `${JSON.stringify(config09)}\n`, { mode: 0o600 });

  // ── user runs `akm backup restore --confirm` to return to 0.8 ─────────────
  const result = restoreMigrationBackup(true);
  expect(result).toBeTruthy();

  // config.json (a COVERED artifact) is faithfully reverted to its 0.8 bytes.
  const restoredConfig = JSON.parse(fs.readFileSync(getConfigPath(), "utf8"));
  expect(restoredConfig.configVersion).toBe("0.8.0");
  expect(restoredConfig.bundles).toBeUndefined();
  expect(fs.readFileSync(getConfigPath()).equals(backedUpConfigBytes)).toBe(true);

  // ── the DEFECT: the filesystem is STILL in 0.9 shape after "restore" ──────
  // The user was returned to 0.8 DBs/config on top of a 0.9 filesystem.
  expect(fs.existsSync(sidecarPath)).toBe(false); // sidecar STILL gone — never restored
  expect(fs.existsSync(reservedPath)).toBe(false); // index.md STILL missing
  expect(fs.existsSync(path.join(conceptDir, "index-content.md"))).toBe(true); // rename survives

  // Concretely: the restored 0.8 config's stashDir points at a tree whose
  // `.stash.json` curated metadata is gone and whose `index.md` concept has
  // vanished under a renamed file — a "pre-migration restore" that silently
  // excludes every non-DB mutation the migration made.
});
