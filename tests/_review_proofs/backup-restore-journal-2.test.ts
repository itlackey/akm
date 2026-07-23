// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { createMigrationBackup, restoreMigrationBackup } from "../../src/core/migration-backup";
import { getConfigPath, getDataDir, getStateDbPathInDataDir } from "../../src/core/paths";
import { runContentMigration } from "../../src/migrate/legacy/content-migration";
import { writeLegacyStashFile } from "../../src/migrate/legacy/legacy-stash-json";
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

function seedLegacyConfigAndState(): void {
  fs.writeFileSync(
    getConfigPath(),
    `${JSON.stringify({ configVersion: "0.8.0", profiles: { llm: { old: {} } } }, null, 2)}\n`,
    { mode: 0o600 },
  );
  fs.mkdirSync(path.dirname(getStateDbPathInDataDir()), { recursive: true });
  const state = new Database(getStateDbPathInDataDir());
  state.exec("PRAGMA journal_mode=WAL; CREATE TABLE durable(value TEXT); INSERT INTO durable VALUES ('before')");
  state.close();
}

describe("restore does not revert the stash filesystem; sidecar metadata for non-md assets is unrecoverable", () => {
  test("non-markdown asset curated metadata is deleted by content-migration and NOT restored", () => {
    seedLegacyConfigAndState();

    // Realistic 0.8.x stash: a shell-script asset (`tool.sh`) whose curated
    // description lived ONLY in the per-directory .stash.json sidecar (a
    // non-markdown asset has no frontmatter home). Also an index.md concept
    // that carries asset frontmatter (D-R6 reserved rename target).
    const stashRoot = path.join(getDataDir(), "stash");
    fs.mkdirSync(stashRoot, { recursive: true });
    fs.writeFileSync(path.join(stashRoot, "tool.sh"), "#!/bin/sh\necho hi\n");
    fs.writeFileSync(
      path.join(stashRoot, "index.md"),
      "---\ndescription: a concept mis-named index.md\n---\n\nbody\n",
    );
    writeLegacyStashFile(stashRoot, {
      entries: [
        {
          name: "tool",
          type: "script",
          filename: "tool.sh",
          description: "CURATED-DESC-ONLY-IN-SIDECAR",
          quality: "curated",
        },
      ],
    });

    const sidecarPath = path.join(stashRoot, ".stash.json");
    const indexMdPath = path.join(stashRoot, "index.md");
    const renamedPath = path.join(stashRoot, "index-content.md");
    expect(fs.existsSync(sidecarPath)).toBe(true);

    // (1) Pre-cutover backup — captures config.json/state.db/workflow.db/index.db only.
    const backup = createMigrationBackup();
    expect(backup.created).toBe(true);

    // (2) Post-cutover forward-only content migration.
    const report = runContentMigration([stashRoot]);
    // The non-md entry is skipped (no frontmatter home) but the sidecar is
    // deleted anyway; the reserved index.md concept is renamed.
    expect(report.sidecarsFolded).toBe(1);
    expect(report.entriesSkipped).toBe(1);
    expect(report.entriesFolded).toBe(0);
    expect(report.reservedRenames.length).toBe(1);

    // Sidecar gone; index.md renamed; the curated description now lives NOWHERE.
    expect(fs.existsSync(sidecarPath)).toBe(false);
    expect(fs.existsSync(indexMdPath)).toBe(false);
    expect(fs.existsSync(renamedPath)).toBe(true);
    const toolContents = fs.readFileSync(path.join(stashRoot, "tool.sh"), "utf8");
    expect(toolContents.includes("CURATED-DESC-ONLY-IN-SIDECAR")).toBe(false);

    // (3) User later runs `migrate backup restore` to "return to 0.8.x".
    restoreMigrationBackup(true, backup.manifest.runId);

    // DEFECT: restore republished the DBs/config but did NOT revert the
    // filesystem. A faithful restore of the pre-migration state would bring
    // the sidecar (and the curated metadata inside it) back and undo the
    // reserved rename. It does neither — the metadata is permanently lost.
    expect(fs.existsSync(sidecarPath)).toBe(false); // sidecar NOT restored
    expect(fs.existsSync(indexMdPath)).toBe(false); // rename NOT reverted
    expect(fs.existsSync(renamedPath)).toBe(true); // renamed file still there

    // The curated description is gone from every on-disk file.
    let foundDescAnywhere = false;
    for (const name of fs.readdirSync(stashRoot)) {
      const full = path.join(stashRoot, name);
      if (fs.statSync(full).isFile() && fs.readFileSync(full, "utf8").includes("CURATED-DESC-ONLY-IN-SIDECAR")) {
        foundDescAnywhere = true;
      }
    }
    expect(foundDescAnywhere).toBe(false); // unrecoverable metadata loss
  });
});
