// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { test, expect, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runContentMigration } from "../../src/migrate/legacy/content-migration";
import { parseFrontmatter } from "../../src/core/asset/frontmatter";

const tmpRoots: string[] = [];

function mkRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akm-cm3-"));
  tmpRoots.push(root);
  return root;
}

afterEach(() => {
  for (const r of tmpRoots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

test("sanity: yaml.parse throws on the malformed block, so parseFrontmatter uses the lenient path (drops tags sequence)", () => {
  const fm = [
    'title: "unterminated',
    "tags:",
    "  - keep-me",
    "source: memory:parent",
  ].join("\n");
  const raw = `---\n${fm}\n---\n\nbody text\n`;
  const parsed = parseFrontmatter(raw);
  // Lenient recovery keeps the scalar source but silently reduces `tags` to ""
  // (the block-sequence item `keep-me` is not a `key: value` line, so it is dropped).
  expect(parsed.data.source).toBe("memory:parent");
  expect(parsed.data.tags).toBe("");
});

test("CONFIRM: a reported-successful source-backref rewrite silently destroys the tags sequence on a malformed-YAML memory asset", () => {
  const root = mkRoot();
  const filePath = path.join(root, "mem.md");
  const original = [
    "---",
    'title: "unterminated', // unterminated double quote -> yaml.parse throws
    "tags:",
    "  - keep-me", // block sequence -> dropped by lenient parser
    "source: memory:parent", // the derived-memory backref the migration rewrites
    "---",
    "",
    "captured memory body",
    "",
  ].join("\n");
  fs.writeFileSync(filePath, original, "utf8");

  // Precondition: the curated tag bytes are physically present on disk before migration.
  expect(original).toContain("keep-me");

  const report = runContentMigration([root]);

  // The migration reports the rewrite as a SUCCESS.
  expect(report.sourceBackrefsRewritten).toBe(1);

  const after = fs.readFileSync(filePath, "utf8");

  // The rewrite happened (forward-keyed conceptId is now on disk)...
  expect(after).toContain("memories/parent");
  expect(after).not.toContain("memory:parent");

  // ...but the curated `tags` sequence was silently overwritten and is GONE.
  // Before the migration `keep-me` was recoverable (fix the quote); after, the
  // lenient scalar-only recovery has been persisted to disk, destroying it.
  expect(after).not.toContain("keep-me");
});
