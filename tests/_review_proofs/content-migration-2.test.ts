// Proof test for candidate finding:
// "backup restore cannot undo the post-cutover content migration; the deleted
//  curated sidecar and renamed reserved files are unrecoverable while restore
//  reports success"
//
// Strategy: the load-bearing claim is that runContentMigration (which runs AFTER
// the cutover commit / point-of-no-return, and whose mutations are NOT in the
// backup's 4-artifact scope) irreversibly mutates the STASH FILESYSTEM:
//   (a) deletes a curated .stash.json sidecar whose only entry targets a NON-md
//       asset -> the curated bytes are folded NOWHERE and then destroyed;
//   (b) renames a reserved-name concept index.md -> index-content.md.
// Both mutations live entirely in the stash tree, which the migration backup
// (config.json/state.db/workflow.db/index.db only) never snapshots, so a later
// `backup restore` (replaceArtifactsFromBundle restores only those 4 artifacts
// and returns success) can never undo them. This test exhibits the byte loss +
// irreversible rename directly.

import { test, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runContentMigration } from "../../src/migrate/legacy/content-migration";

const CURATED_DESCRIPTION = "curated: production deploy runbook (hand-written, non-md asset)";

function readAllFilesUnder(root: string): Array<{ path: string; text: string }> {
  const out: Array<{ path: string; text: string }> = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.isFile()) out.push({ path: p, text: fs.readFileSync(p, "utf8") });
    }
  };
  walk(root);
  return out;
}

test("runContentMigration destroys curated non-md sidecar bytes and renames reserved file — unrecoverable, no backup captures the stash tree", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akm-content-mig-"));

  // (a) A realistic 0.8.x directory: a non-markdown asset with a CURATED sidecar.
  const scriptsDir = path.join(root, "scripts");
  fs.mkdirSync(scriptsDir, { recursive: true });
  const deploySh = path.join(scriptsDir, "deploy.sh");
  fs.writeFileSync(deploySh, "#!/usr/bin/env bash\nset -euo pipefail\necho deploying\n");
  const sidecarPath = path.join(scriptsDir, ".stash.json");
  fs.writeFileSync(
    sidecarPath,
    JSON.stringify(
      {
        entries: [
          {
            name: "deploy",
            type: "command",
            filename: "deploy.sh",
            quality: "curated",
            description: CURATED_DESCRIPTION,
            tags: ["ops", "release"],
          },
        ],
      },
      null,
      2,
    ),
  );

  // (b) A reserved-name concept the user authored, carrying asset frontmatter.
  const knowledgeDir = path.join(root, "knowledge");
  fs.mkdirSync(knowledgeDir, { recursive: true });
  const indexMd = path.join(knowledgeDir, "index.md");
  fs.writeFileSync(
    indexMd,
    "---\ndescription: How the knowledge base is organized\nwhen_to_use: When onboarding an engineer\n---\n# Knowledge index\n\nHand-written concept body.\n",
  );

  // Snapshot the shell script bytes to confirm they are NOT rewritten.
  const deployBefore = fs.readFileSync(deploySh, "utf8");

  // --- run the exact post-cutover content-migration step ---
  const report = runContentMigration([root]);

  // The sidecar was deleted...
  expect(fs.existsSync(sidecarPath)).toBe(false);
  expect(report.sidecarsFolded).toBe(1);
  // ...but the ONLY entry (a non-md target) was skipped, never folded anywhere.
  expect(report.entriesSkipped).toBe(1);
  expect(report.entriesFolded).toBe(0);

  // The shell script is untouched (no frontmatter prepended — correct, but it
  // means the curated metadata had nowhere to land).
  expect(fs.readFileSync(deploySh, "utf8")).toBe(deployBefore);

  // DATA LOSS: the curated description now exists in NO file anywhere under the
  // stash tree. It was in the sidecar; the sidecar is gone; nothing carries it.
  const survivors = readAllFilesUnder(root).filter((f) => f.text.includes(CURATED_DESCRIPTION));
  expect(survivors.map((f) => f.path)).toEqual([]); // curated bytes are gone

  // IRREVERSIBLE RENAME: the reserved concept moved and cannot be un-renamed by
  // a DB/config backup restore (the stash tree is outside backup scope).
  expect(fs.existsSync(indexMd)).toBe(false);
  expect(fs.existsSync(path.join(knowledgeDir, "index-content.md"))).toBe(true);
  expect(report.reservedRenames.length).toBe(1);
  expect(path.basename(report.reservedRenames[0]!.to)).toBe("index-content.md");
});
