import { test, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runContentMigration } from "../../src/migrate/legacy/content-migration";

// PROOF for candidate: `.stash.json` fold deletes the sidecar after SKIPPING every
// non-markdown asset entry, silently dropping curated metadata (description/run/tags)
// for script/env assets. Non-md files have no frontmatter home, the sidecar is the
// ONLY store, and the migration backup set never captures stash files.

function mkRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "akm-content-mig-"));
}

test("script asset: curated metadata dropped, sidecar deleted, .sh untouched", () => {
  const root = mkRoot();
  const scripts = path.join(root, "scripts");
  fs.mkdirSync(scripts);

  // A plain 0.8.x shell asset with NO frontmatter — cannot carry a `---` block.
  const shPath = path.join(scripts, "deploy.sh");
  const shBytes = "#!/usr/bin/env bash\necho deploying\n";
  fs.writeFileSync(shPath, shBytes);

  // The sidecar is the ONLY store of the curated description/run/tags for this asset.
  const sidecarPath = path.join(scripts, ".stash.json");
  fs.writeFileSync(
    sidecarPath,
    JSON.stringify(
      {
        entries: [
          {
            name: "deploy",
            type: "script",
            filename: "deploy.sh",
            description: "Production deploy helper — curated by the user",
            run: "./deploy.sh --prod",
            setup: "npm ci",
            cwd: "infra",
            tags: ["ops", "deploy"],
          },
        ],
      },
      null,
      2,
    ),
  );

  const report = runContentMigration([root]);

  // 1. The sidecar — the only durable store of the curated metadata — is GONE.
  expect(fs.existsSync(sidecarPath)).toBe(false);
  // 2. The script file is byte-identical: the curated fields were NOT folded into it.
  expect(fs.readFileSync(shPath, "utf8")).toBe(shBytes);
  // 3. The entry was counted as skipped and the sidecar counted as folded+deleted.
  expect(report.entriesSkipped).toBe(1);
  expect(report.entriesFolded).toBe(0);
  expect(report.sidecarsFolded).toBe(1);

  // 4. There is now NO surviving home for description/run/setup/cwd/tags anywhere:
  //    the .sh has no frontmatter, and the sidecar was deleted. Re-indexing the
  //    frontmatter-less .sh cannot recover any of it.
  const shAfter = fs.readFileSync(shPath, "utf8");
  expect(shAfter.includes("curated by the user")).toBe(false);
  expect(shAfter.includes("--prod")).toBe(false);
  expect(shAfter.includes("ops")).toBe(false);

  // CONTRAST: an identical entry pointing at a .md target DOES get folded, proving
  // the loss is purely a consequence of the non-md skip + unconditional delete.
  const mdRoot = mkRoot();
  const notes = path.join(mdRoot, "notes");
  fs.mkdirSync(notes);
  const mdPath = path.join(notes, "deploy.md");
  fs.writeFileSync(mdPath, "# Deploy\n\nbody\n"); // no frontmatter yet
  fs.writeFileSync(
    path.join(notes, ".stash.json"),
    JSON.stringify({
      entries: [
        { name: "deploy", type: "note", filename: "deploy.md", description: "kept", run: "./x", tags: ["ops"] },
      ],
    }),
  );
  const mdReport = runContentMigration([mdRoot]);
  expect(mdReport.entriesFolded).toBe(1);
  const mdAfter = fs.readFileSync(mdPath, "utf8");
  expect(mdAfter.includes("kept")).toBe(true); // description survived into frontmatter
});
