// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Integration: repairs a real index written by the previous classifier without changing its source files.
import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmHealth } from "../../../src/commands/health";
import { akmShowUnified } from "../../../src/commands/read/show";
import { akmAdapter } from "../../../src/core/adapter/adapters/akm-adapter";
import { getDbPath } from "../../../src/core/paths";
import { akmIndex, lookupBundleRef } from "../../../src/indexer/indexer";
import { computeDirFingerprint } from "../../../src/indexer/passes/dir-staleness";
import { CONTENT_PROJECTION_VERSION } from "../../../src/indexer/passes/metadata";
import { openIndexDatabase } from "../../../src/storage/repositories/index-connection";
import { withIsolatedAkmStorage, writeSandboxConfig } from "../../_helpers/sandbox";

test("ordinary incremental indexing repairs unchanged $ARGUMENTS knowledge and memory refs (#1300)", async () => {
  const storage = withIsolatedAkmStorage();
  try {
    writeSandboxConfig({
      semanticSearchMode: "off",
      defaultBundle: "fixture",
      bundles: { fixture: { path: storage.stashDir, components: { main: { root: ".", adapter: "akm" } } } },
    });
    const files = (
      [
        ["knowledge", "knowledge"],
        ["memories", "memory"],
      ] as const
    ).map(([dir, type]) => {
      const filePath = path.join(storage.stashDir, dir, "guide.md");
      const content = `# Placeholder guide\n\nThe literal \`$ARGUMENTS\` is documented here (${dir}).\n`;
      fs.writeFileSync(filePath, content);
      return {
        filePath,
        content,
        type,
        conceptId: `${dir}/guide`,
        oldConceptId: `commands/${dir}/guide`,
        stat: fs.statSync(filePath, { bigint: true }),
      };
    });
    await akmIndex({ stashDir: storage.stashDir, full: true });

    // Reproduce the old persisted classification and its exact freshness variant.
    // The ordinary index must detect the adapter change, not a changed file or a forced full scan.
    const previousVariant = `akm@0.9.2+content${CONTENT_PROJECTION_VERSION}`;
    const db = openIndexDatabase(getDbPath());
    try {
      for (const file of files) {
        db.prepare(
          "UPDATE entries SET item_ref = ?, concept_id = ?, type = 'command', document_json = json_set(document_json, '$.type', 'command') WHERE file_path = ?",
        ).run(`fixture//${file.oldConceptId}`, file.oldConceptId, file.filePath);
      }
      for (const { dir_path } of db.prepare("SELECT dir_path FROM index_dir_state").all() as { dir_path: string }[]) {
        const paths = fs
          .readdirSync(dir_path, { withFileTypes: true })
          .filter((entry) => entry.isFile())
          .map((entry) => path.join(dir_path, entry.name));
        db.prepare("UPDATE index_dir_state SET index_variant = ?, file_set_hash = ? WHERE dir_path = ?").run(
          previousVariant,
          computeDirFingerprint(dir_path, paths, previousVariant).fileSetHash,
          dir_path,
        );
      }
    } finally {
      db.close();
    }
    for (const file of files) {
      expect((await lookupBundleRef({ bundle: "fixture", conceptId: file.oldConceptId }))?.type).toBe("command");
    }
    const before = await akmHealth({ since: "7d" });
    const advisory = before.advisories.find((check) => check.name === "type-directory-disagreement");
    expect(advisory?.message).toContain("smart-md:$ARGUMENTS");
    expect(advisory?.message).not.toContain("known-good override");

    await akmIndex({ stashDir: storage.stashDir });

    for (const file of files) {
      expect(await lookupBundleRef({ bundle: "fixture", conceptId: file.oldConceptId })).toBeNull();
      expect((await lookupBundleRef({ bundle: "fixture", conceptId: file.conceptId }))?.type).toBe(file.type);
      const shown = await akmShowUnified({ ref: `fixture//${file.conceptId}` });
      expect(shown.type).toBe(file.type);
      expect(shown.template).toBeUndefined();
      expect(shown.content).toContain("`$ARGUMENTS`");
      expect(fs.readFileSync(file.filePath, "utf8")).toBe(file.content);
      expect(fs.statSync(file.filePath, { bigint: true }).mtimeNs).toBe(file.stat.mtimeNs);
      expect(fs.statSync(file.filePath, { bigint: true }).ctimeNs).toBe(file.stat.ctimeNs);
    }
    const after = await akmHealth({ since: "7d" });
    expect(after.advisories.find((check) => check.name === "type-directory-disagreement")).toBeUndefined();
    const repaired = openIndexDatabase(getDbPath());
    try {
      expect(repaired.prepare("SELECT count(*) AS n FROM entries").get()).toEqual({ n: 2 });
      expect(repaired.prepare("SELECT DISTINCT index_variant AS v FROM index_dir_state").all()).toEqual([
        { v: `akm@${akmAdapter.version}+content${CONTENT_PROJECTION_VERSION}` },
      ]);
    } finally {
      repaired.close();
    }
  } finally {
    storage.cleanup();
  }
});
