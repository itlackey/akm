// Independent probe: a .stash.json curated entry targeting a NON-markdown asset
// (script/secret/env) is skipped by the fold, but the sidecar is deleted anyway
// -> that entry's curated metadata is permanently lost with no error.
import { test, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runContentMigration } from "../../src/migrate/legacy/content-migration";
import { writeLegacyStashFile } from "../../src/migrate/legacy/legacy-stash-json";
import { legacyStashFilePath } from "../../src/migrate/legacy/legacy-stash-json";

test("non-markdown curated .stash.json entry is silently lost when the sidecar is deleted", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ind-nonmd-"));
  try {
    const scriptsDir = path.join(root, "scripts");
    fs.mkdirSync(scriptsDir, { recursive: true });
    const scriptPath = path.join(scriptsDir, "deploy.sh");
    const scriptBody = "#!/bin/sh\necho deploy\n";
    fs.writeFileSync(scriptPath, scriptBody);

    // A curated sidecar entry for the SCRIPT: description/quality only lived here
    // (the 0.8 indexer merged .stash.json overrides for every asset type).
    writeLegacyStashFile(scriptsDir, {
      entries: [
        {
          name: "deploy.sh",
          type: "script",
          filename: "deploy.sh",
          description: "CURATED: production deploy — handle with care",
          quality: 0.95,
          tags: ["prod", "danger"],
        } as any,
      ],
    });

    const sidecarPath = legacyStashFilePath(scriptsDir);
    expect(fs.existsSync(sidecarPath)).toBe(true);

    const report = runContentMigration([root]);

    // The entry was SKIPPED (non-markdown target) ...
    expect(report.entriesSkipped).toBe(1);
    expect(report.entriesFolded).toBe(0);
    // ... yet the sidecar was DELETED anyway.
    expect(report.sidecarsFolded).toBe(1);
    expect(fs.existsSync(sidecarPath)).toBe(false);

    // The script file is unchanged (no frontmatter can be prepended to a .sh),
    // so the curated description/quality/tags now exist NOWHERE on disk.
    expect(fs.readFileSync(scriptPath, "utf8")).toBe(scriptBody);
    const anythingLeft = fs
      .readdirSync(scriptsDir)
      .filter((f) => f !== "deploy.sh");
    console.log("scripts dir after migration:", JSON.stringify(fs.readdirSync(scriptsDir)));
    console.log("script body after migration:", JSON.stringify(fs.readFileSync(scriptPath, "utf8")));
    // No sidecar, no other file — the curated metadata is gone.
    expect(anythingLeft).toEqual([]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
