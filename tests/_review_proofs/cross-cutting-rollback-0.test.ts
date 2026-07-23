// Proof for candidate: "Non-markdown / skipped .stash.json curated metadata is
// destroyed by the cutover and is unrecoverable by any backup restore".
//
// runContentMigration folds a directory's .stash.json curated overrides into the
// matching file's YAML frontmatter, then UNCONDITIONALLY deletes the sidecar.
// foldEntry only writes the curated fields when the target is an existing .md
// file; for a NON-markdown target (script/env), a missing target, or an entry
// with no filename it only bumps `entriesSkipped` and writes the curated data
// NOWHERE. The sidecar is then rmSync'd anyway. The migration backup set is
// config.json/state.db/workflow.db/index.db — it never contains .stash.json, so
// no restore can bring the curated metadata back.

import { test, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runContentMigration } from "../../src/migrate/legacy/content-migration";
import { legacyStashFilePath } from "../../src/migrate/legacy/legacy-stash-json";

function mkroot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "akm-nonmd-sidecar-"));
}

// A description string that only exists inside the sidecar — we grep for it after
// the fold to prove it survives nowhere on disk.
const CURATED_DESC = "CURATED_ONLY_IN_SIDECAR_deploy_script_hand_edited_desc";

function dirHasString(dir: string, needle: string): boolean {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isFile() && fs.readFileSync(p, "utf8").includes(needle)) return true;
  }
  return false;
}

test("non-markdown curated sidecar metadata is destroyed by the fold and left nowhere on disk", () => {
  const root = mkroot();
  const dir = path.join(root, "scripts");
  fs.mkdirSync(dir, { recursive: true });

  const scriptBody = "#!/usr/bin/env bash\nset -euo pipefail\necho deploy\n";
  fs.writeFileSync(path.join(dir, "deploy.sh"), scriptBody);

  // A realistic 0.8.x sidecar: a script asset's curated override lives ONLY here
  // (a shell script cannot carry YAML frontmatter). quality/tags/description are
  // all curated fields the 0.8 indexer merged onto the entry at read time.
  fs.writeFileSync(
    legacyStashFilePath(dir),
    JSON.stringify(
      {
        entries: [
          {
            name: "deploy.sh",
            type: "script",
            filename: "deploy.sh",
            description: CURATED_DESC,
            quality: "curated",
            tags: ["deploy", "production", "hand-tuned"],
          },
        ],
      },
      null,
      2,
    ),
  );

  const report = runContentMigration([root]);

  // The curated entry was skipped (non-markdown target) — written NOWHERE.
  expect(report.entriesFolded).toBe(0);
  expect(report.entriesSkipped).toBe(1);
  // ...yet the sidecar was deleted anyway.
  expect(report.sidecarsFolded).toBe(1);
  expect(fs.existsSync(legacyStashFilePath(dir))).toBe(false);

  // The script itself is byte-unchanged (fold cannot prepend frontmatter to it).
  expect(fs.readFileSync(path.join(dir, "deploy.sh"), "utf8")).toBe(scriptBody);

  // The curated description now exists in NO file in the directory. Gone forward
  // (0.9 never captured it) and — since the backup set is
  // config/state/workflow/index.db, never .stash.json — unrecoverable by restore.
  expect(dirHasString(dir, CURATED_DESC)).toBe(false);
});

test("a curated entry whose markdown target was moved/deleted is also silently destroyed", () => {
  const root = mkroot();
  const dir = path.join(root, "memories");
  fs.mkdirSync(dir, { recursive: true });

  // A curated override for a markdown note whose file was later moved/deleted:
  // filename points at a target that no longer exists on disk.
  fs.writeFileSync(
    legacyStashFilePath(dir),
    JSON.stringify(
      {
        entries: [
          {
            name: "gone-note",
            type: "memory",
            filename: "gone-note.md", // target no longer present
            description: CURATED_DESC,
            quality: "curated",
          },
        ],
      },
      null,
      2,
    ),
  );

  const report = runContentMigration([root]);

  expect(report.entriesFolded).toBe(0);
  expect(report.entriesSkipped).toBe(1);
  expect(report.sidecarsFolded).toBe(1);
  expect(fs.existsSync(legacyStashFilePath(dir))).toBe(false);
  // Curated metadata for the missing-target entry: destroyed, nowhere on disk.
  expect(dirHasString(dir, CURATED_DESC)).toBe(false);
});
