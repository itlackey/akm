// Independent END-TO-END proof of the rollback/restore completeness gap.
//
// The migration backup snapshots ONLY config.json/state.db/workflow.db/index.db.
// The content-migration folds/deletes .stash.json sidecars and renames reserved
// files AFTER the cutover commits, and those filesystem mutations are captured by
// NO backup. So `akm backup restore` reverts the DBs+config to the pre-migration
// state but CANNOT return the stash filesystem to its pre-migration shape: the
// deleted curated .stash.json is permanently gone and the reserved file stays
// renamed. A user who "restores to go back" ends up with 0.8 databases but a
// half-0.9 filesystem, having irrecoverably lost the curated sidecar.
import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { getConfigPath, getDataDir, getStateDbPathInDataDir } from "../../src/core/paths";
import { writeLegacyStashFile } from "../../src/migrate/legacy/legacy-stash-json";
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

test("backup restore reverts the DBs but cannot recover the deleted curated sidecar or the renamed reserved file", async () => {
  openStateDbAtCeiling(getStateDbPathInDataDir(), PRE_CUTOVER_STATE_CEILING).close();

  const stash = path.join(getDataDir(), "stash");
  // (1) A curated .stash.json sidecar for a NON-markdown asset — its curated
  //     metadata lives ONLY here (the fold skips non-md and deletes the sidecar).
  const scriptsDir = path.join(stash, "scripts");
  fs.mkdirSync(scriptsDir, { recursive: true });
  fs.writeFileSync(path.join(scriptsDir, "deploy.sh"), "#!/bin/sh\necho deploy\n");
  writeLegacyStashFile(scriptsDir, {
    entries: [
      {
        name: "deploy.sh",
        type: "script",
        filename: "deploy.sh",
        description: "CURATED prod deploy — irreplaceable",
        quality: 0.9,
      } as unknown as never,
    ],
  });
  const sidecarPath = path.join(scriptsDir, ".stash.json");
  const sidecarBytesBefore = fs.readFileSync(sidecarPath, "utf8");

  // (2) A reserved-name concept that D-R6 will rename.
  const knowledgeDir = path.join(stash, "knowledge");
  fs.mkdirSync(knowledgeDir, { recursive: true });
  fs.writeFileSync(
    path.join(knowledgeDir, "index.md"),
    "---\ndescription: A concept mis-named index\nwhen_to_use: retrieval\n---\n\nbody\n",
  );

  const prepared = writeConfigs();

  // --- migrate apply (succeeds) ---
  const applied = await runCliCapture(["migrate", "apply", "--config", prepared]);
  expect(applied.code, applied.stderr).toBe(0);

  // Post-migration filesystem: sidecar deleted, reserved file renamed, config in 0.9 shape.
  expect(fs.existsSync(sidecarPath)).toBe(false);
  expect(fs.existsSync(path.join(knowledgeDir, "index.md"))).toBe(false);
  expect(fs.existsSync(path.join(knowledgeDir, "index-content.md"))).toBe(true);
  const migratedConfig = JSON.parse(fs.readFileSync(getConfigPath(), "utf8"));
  expect(migratedConfig.bundles).toBeDefined();
  expect(migratedConfig.stashDir).toBeUndefined();

  // --- backup restore --confirm (attempt to go back to pre-migration) ---
  const restored = await runCliCapture(["backup", "restore", "--for", "0.9.0", "--confirm"]);
  expect(restored.code, restored.stderr).toBe(0);

  // The DBs + config DID revert to the pre-migration 0.8 shape ...
  const restoredConfig = JSON.parse(fs.readFileSync(getConfigPath(), "utf8"));
  expect(restoredConfig.configVersion).toBe("0.8.0");
  expect(restoredConfig.bundles).toBeUndefined();

  // ... but the FILESYSTEM did NOT: the curated sidecar is still gone (permanently
  // unrecoverable — it was never in any backup), and the reserved file stays renamed.
  console.log("sidecar exists after restore:", fs.existsSync(sidecarPath));
  console.log("original index.md exists after restore:", fs.existsSync(path.join(knowledgeDir, "index.md")));
  console.log("renamed index-content.md still present:", fs.existsSync(path.join(knowledgeDir, "index-content.md")));
  expect(fs.existsSync(sidecarPath)).toBe(false); // curated metadata GONE despite "restore"
  expect(fs.existsSync(path.join(knowledgeDir, "index.md"))).toBe(false); // not restored
  expect(fs.existsSync(path.join(knowledgeDir, "index-content.md"))).toBe(true); // still renamed

  // Prove the lost bytes are irrecoverable: nothing on disk holds the sidecar's
  // curated `quality: 0.9` (non-md metadata that had no frontmatter home).
  expect(sidecarBytesBefore).toContain("irreplaceable");
  expect(fs.readFileSync(path.join(scriptsDir, "deploy.sh"), "utf8")).not.toContain("irreplaceable");
}, 60_000);
