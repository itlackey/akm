// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * D-R6 producer-conformance (ref-grammar decision §4, item 3; WI-8.5d): AKM
 * PRODUCERS emit `index.md`/`log.md` only in the OKF §6/§7 structural
 * listing/log shapes — never as a concept document carrying asset frontmatter.
 *
 * The recognition side (reserved files are never RECOGNIZED as items) is pinned
 * in `tests/core/adapter/akm-adapter.test.ts`. This file pins the WRITE side:
 *
 *  1. A source-scan guard — the only `src/` sites that write a literal
 *     `index.md`/`log.md` basename to disk are the allow-listed STRUCTURAL
 *     producers; no item-write path emits a reserved filename.
 *  2. The one concrete AKM `index.md` producer — the `.meta/` orientation
 *     scaffolder — writes a structural doc (no `description`/`when_to_use` asset
 *     frontmatter) into an indexer-skipped dot-directory.
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scaffoldStashMeta } from "../../src/commands/sources/stash-skeleton";
import { parseFrontmatter } from "../../src/core/asset/frontmatter";

const SRC_ROOT = path.resolve(import.meta.dir, "../../src");

/**
 * Files allowed to mention a literal `index.md` / `log.md` markdown basename:
 * every entry is a STRUCTURAL producer (bundle listing/log/orientation) or a
 * reserved-file EXCLUSION/RENAME set, never a concept-document write path.
 */
const ALLOWED = new Set([
  "core/adapter/adapters/okf-adapter.ts", // recognize/exclude reserved files
  "core/adapter/adapters/akm-adapter.ts", // recognize/exclude reserved files
  "core/adapter/adapters/llm-wiki-adapter.ts", // reserved root-file set
  "core/adapter/adapters/tool-dir-shared.ts", // claude/opencode reserved-file exclusion set (D-R6)
  "core/adapter/adapters/generic-files-adapter.ts", // generic-files reserved-file exclusion set (D-R6)
  "core/adapter/adapters/index.ts", // adapter probe doc
  "commands/sources/stash-skeleton.ts", // structural `.meta/index.md` orientation doc
  "commands/sources/init.ts", // doc comment referencing the `.meta/index.md` orientation doc
  "commands/sources/schema-repair.ts", // llm-wiki structural directory-index names
  "indexer/passes/metadata.ts", // WIKI_INFRA_FILES exclusion set
  "migrate/legacy/content-migration.ts", // D-R6 rename step (reserved-name detection)
  "sources/snapshot-fetchers/website-ingest.ts", // D-R6 remap: crawled pages avoid reserved basenames
]);

function walkTs(dir: string, out: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkTs(full, out);
    else if (entry.isFile() && entry.name.endsWith(".ts")) out.push(full);
  }
}

describe("D-R6 producer conformance — no AKM producer emits a reserved concept file", () => {
  test("the only src files naming a literal index.md/log.md basename are allow-listed structural producers", () => {
    const files: string[] = [];
    walkTs(SRC_ROOT, files);
    const offenders: string[] = [];
    for (const abs of files) {
      const rel = path.relative(SRC_ROOT, abs).replace(/\\/g, "/");
      if (ALLOWED.has(rel)) continue;
      const text = fs.readFileSync(abs, "utf8");
      if (/["'`/](index|log)\.md\b/.test(text)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  test("the .meta/ orientation scaffolder emits a STRUCTURAL index.md (no asset frontmatter) in a dot-directory", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "akm-reserved-producer-"));
    try {
      scaffoldStashMeta(tmp);
      const metaIndex = path.join(tmp, ".meta", "index.md");
      expect(fs.existsSync(metaIndex)).toBe(true);
      // Dot-directory: the indexer never descends into it, so it is never an item.
      expect(metaIndex).toContain(`${path.sep}.meta${path.sep}`);
      const fm = parseFrontmatter(fs.readFileSync(metaIndex, "utf8")).data;
      // Structural orientation keys only — NOT the `description`/`when_to_use`
      // asset markers that would make it a concept document.
      expect(fm.description).toBeUndefined();
      expect(fm.when_to_use).toBeUndefined();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
