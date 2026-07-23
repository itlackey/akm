// PROOF: content-migration fold deletes a directory's `.stash.json` sidecar
// UNCONDITIONALLY, but only folds curated overrides into `.md` targets. For a
// non-markdown target (script/env/secret) — or a missing/renamed target — the
// entry is merely `entriesSkipped++` and NOTHING durable is written, so after the
// sidecar delete the user's curated description/tags/quality for that asset are
// gone with no error surfaced.
//
// Contrast case in the same test proves the fold DOES preserve markdown metadata,
// isolating the loss to non-md / stale-target entries.
import { test, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runContentMigration } from "../../src/migrate/legacy/content-migration";
import { legacyStashFilePath, writeLegacyStashFile } from "../../src/migrate/legacy/legacy-stash-json";

const CURATED = "CURATED: production deploy — irreplaceable operator note";

function grepDirForString(dir: string, needle: string): string[] {
  const hits: string[] = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      hits.push(...grepDirForString(full, needle));
    } else {
      try {
        if (fs.readFileSync(full, "utf8").includes(needle)) hits.push(full);
      } catch {
        /* binary / unreadable: ignore */
      }
    }
  }
  return hits;
}

test("non-markdown curated .stash.json entry is silently erased; markdown sibling is preserved", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cm0-"));
  try {
    // --- scripts/: a curated SCRIPT entry (non-markdown target) ---
    const scriptsDir = path.join(root, "scripts");
    fs.mkdirSync(scriptsDir, { recursive: true });
    const scriptPath = path.join(scriptsDir, "deploy.sh");
    const scriptBody = "#!/bin/sh\necho deploy\n";
    fs.writeFileSync(scriptPath, scriptBody);
    writeLegacyStashFile(scriptsDir, {
      entries: [
        {
          name: "deploy.sh",
          type: "script",
          filename: "deploy.sh",
          description: CURATED,
          quality: "curated",
          tags: ["prod", "danger"],
          searchHints: ["ship it", "release"],
        } as never,
      ],
    });

    // --- notes/: a curated MARKDOWN entry (control — should be preserved) ---
    const notesDir = path.join(root, "notes");
    fs.mkdirSync(notesDir, { recursive: true });
    const mdPath = path.join(notesDir, "runbook.md");
    fs.writeFileSync(mdPath, "# Runbook\n\nbody\n");
    writeLegacyStashFile(notesDir, {
      entries: [
        {
          name: "runbook",
          type: "memory",
          filename: "runbook.md",
          description: "MD-CURATED note",
          tags: ["ops"],
        } as never,
      ],
    });

    const scriptSidecar = legacyStashFilePath(scriptsDir);
    const notesSidecar = legacyStashFilePath(notesDir);
    expect(fs.existsSync(scriptSidecar)).toBe(true);

    const report = runContentMigration([root]);

    // The markdown entry folded; the script entry was skipped.
    expect(report.entriesFolded).toBe(1); // notes/runbook.md
    expect(report.entriesSkipped).toBe(1); // scripts/deploy.sh (non-md)
    expect(report.sidecarsFolded).toBe(2); // BOTH sidecars deleted regardless

    // Both sidecars are gone from disk.
    expect(fs.existsSync(scriptSidecar)).toBe(false);
    expect(fs.existsSync(notesSidecar)).toBe(false);

    // Markdown metadata survived in frontmatter (the durable fold home).
    const mdAfter = fs.readFileSync(mdPath, "utf8");
    expect(mdAfter).toContain("MD-CURATED note");

    // The script bytes are untouched (no frontmatter can be prepended to a .sh).
    expect(fs.readFileSync(scriptPath, "utf8")).toBe(scriptBody);

    // THE DEFECT: the curated script metadata now lives NOWHERE under the stash.
    const survivors = grepDirForString(root, CURATED);
    console.log("scripts dir after migration:", JSON.stringify(fs.readdirSync(scriptsDir)));
    console.log("files still containing the curated string:", JSON.stringify(survivors));
    expect(survivors).toEqual([]); // curated description/tags/quality/hints: permanently lost
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("stale-target (renamed file) curated .stash.json entry is also erased on sidecar delete", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cm0b-"));
  try {
    const dir = path.join(root, "memories");
    fs.mkdirSync(dir, { recursive: true });
    // Sidecar references old-name.md, but the file on disk was renamed to new-name.md.
    fs.writeFileSync(path.join(dir, "new-name.md"), "# New\n\nbody\n");
    writeLegacyStashFile(dir, {
      entries: [
        {
          name: "old-name",
          type: "memory",
          filename: "old-name.md", // target no longer exists
          description: CURATED,
          tags: ["important"],
        } as never,
      ],
    });

    const sidecar = legacyStashFilePath(dir);
    const report = runContentMigration([root]);

    expect(report.entriesSkipped).toBe(1); // missing target -> skipped
    expect(report.entriesFolded).toBe(0);
    expect(report.sidecarsFolded).toBe(1); // deleted anyway
    expect(fs.existsSync(sidecar)).toBe(false);

    // The curated metadata is gone; the surviving new-name.md never received it.
    const survivors = grepDirForString(root, CURATED);
    expect(survivors).toEqual([]);
    expect(fs.readFileSync(path.join(dir, "new-name.md"), "utf8")).not.toContain(CURATED);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
