// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * PROOF for candidate finding:
 *   "D-R6 reserved-file rename misses mis-named concepts that lack
 *    description/when_to_use, silently de-indexing them under 0.9.0"
 *
 * Claim: a 0.8.x-indexed concept literally named knowledge/index.md that carries
 * frontmatter WITHOUT description/when_to_use (e.g. only tags:) is NOT renamed by
 * D-R6 (carriesAssetFrontmatter returns false), and is then DROPPED from the 0.9.0
 * index by the akm adapter's unconditional reserved-file exclusion — silent data
 * loss for a file that WAS a searchable concept under 0.8.x.
 *
 * We establish the "was indexed under 0.8.x" half two ways:
 *   1. A byte-identical NON-reserved sibling (knowledge/regular.md) IS recognized
 *      by the 0.9.0 akm adapter, proving the content is a legitimate indexable
 *      knowledge concept (tags-only frontmatter is enough).
 *   2. Under 0.8.x shouldIndexStashFile excluded index.md/log.md ONLY inside
 *      wikis/<name>/ roots, so knowledge/index.md was indexed (verified by
 *      code-reading the frozen legacy predicate).
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { akmAdapter } from "../../src/core/adapter/adapters/akm-adapter";
import type { BundleComponent } from "../../src/core/adapter/types";
import { buildFileContext } from "../../src/indexer/walk/file-context";
import { runContentMigration } from "../../src/migrate/legacy/content-migration";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "cm4-"));
  fs.mkdirSync(path.join(root, "knowledge"), { recursive: true });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function component(): BundleComponent {
  return { id: "b", adapter: "akm", root, writable: true };
}

// A tags-only note body (no description / when_to_use / whenToUse frontmatter).
const TAGS_ONLY = `---\ntags: [notes]\n---\n\nThis is a hand-organized note the user wants searchable.\n`;

test("D-R6 skips a tags-only knowledge/index.md, and 0.9.0 then silently de-indexes it", () => {
  const reservedFile = path.join(root, "knowledge", "index.md");
  const controlFile = path.join(root, "knowledge", "regular.md");
  fs.writeFileSync(reservedFile, TAGS_ONLY);
  fs.writeFileSync(controlFile, TAGS_ONLY); // byte-identical content, non-reserved name

  // ── D-R6 content migration ───────────────────────────────────────────────
  const report = runContentMigration([root]);

  // The rename never fired: carriesAssetFrontmatter keys only on
  // description/when_to_use, which this file lacks.
  expect(report.reservedRenames.length).toBe(0);
  // The file is still named index.md (not renamed to index-content.md).
  expect(fs.existsSync(reservedFile)).toBe(true);
  expect(fs.existsSync(path.join(root, "knowledge", "index-content.md"))).toBe(false);

  // ── 0.9.0 recognition ────────────────────────────────────────────────────
  // The byte-identical, non-reserved sibling IS recognized as a knowledge
  // concept — proving the CONTENT is a legitimate indexable asset (so this file
  // was indexed under 0.8.x, which had no reserved-file exclusion outside wikis/).
  const controlDoc = akmAdapter.recognize(component(), buildFileContext(root, controlFile));
  expect(controlDoc).not.toBeNull();
  expect(controlDoc?.type).toBe("knowledge");

  // The reserved-named file with identical content is DROPPED (recognize → null):
  // the D-R6 rename that would have saved it never ran. Silent de-indexing.
  const reservedDoc = akmAdapter.recognize(component(), buildFileContext(root, reservedFile));
  expect(reservedDoc).toBeNull();
});

test("control: an index.md WITH a description IS renamed (predicate boundary)", () => {
  const withDesc = path.join(root, "knowledge", "index.md");
  fs.writeFileSync(withDesc, `---\ndescription: a real concept\n---\n\nbody\n`);

  const report = runContentMigration([root]);

  // Description-bearing reserved file: the rename fires and saves it.
  expect(report.reservedRenames.length).toBe(1);
  expect(fs.existsSync(withDesc)).toBe(false);
  expect(fs.existsSync(path.join(root, "knowledge", "index-content.md"))).toBe(true);

  // After the rename it is indexable again under 0.9.0.
  const doc = akmAdapter.recognize(
    component(),
    buildFileContext(root, path.join(root, "knowledge", "index-content.md")),
  );
  expect(doc).not.toBeNull();
  expect(doc?.type).toBe("knowledge");
});
