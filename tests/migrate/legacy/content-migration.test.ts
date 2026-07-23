// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { parseFrontmatter } from "../../../src/core/asset/frontmatter";
import { runContentMigration } from "../../../src/migrate/legacy/content-migration";
import { makeSandboxDir } from "../../_helpers/sandbox";

test("retains a sidecar unless every entry can be folded", () => {
  const sandbox = makeSandboxDir("akm-content-sidecar-retention");
  try {
    const dir = path.join(sandbox.dir, "memories");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "note.md"), "# Note\n");
    fs.writeFileSync(path.join(dir, "tool.sh"), "#!/bin/sh\n");
    const sidecarPath = path.join(dir, ".stash.json");
    const sidecar = `${JSON.stringify({
      entries: [
        { name: "note", type: "memory", filename: "note.md", description: "Curated note" },
        { name: "tool", type: "script", filename: "tool.sh", description: "Curated tool" },
      ],
    })}\n`;
    fs.writeFileSync(sidecarPath, sidecar);

    const report = runContentMigration([sandbox.dir]);
    expect(report.entriesFolded).toBe(1);
    expect(report.entriesSkipped).toBe(1);
    expect(report.sidecarsFolded).toBe(0);
    expect(fs.readFileSync(sidecarPath, "utf8")).toBe(sidecar);
    expect(parseFrontmatter(fs.readFileSync(path.join(dir, "note.md"), "utf8")).data.description).toBe("Curated note");
  } finally {
    sandbox.cleanup();
  }
});

test("retains malformed sidecars byte-for-byte", () => {
  const sandbox = makeSandboxDir("akm-content-invalid-sidecar");
  try {
    const sidecarPath = path.join(sandbox.dir, ".stash.json");
    const malformed = '{"entries":[{"name":"recoverable"}';
    fs.writeFileSync(sidecarPath, malformed);

    expect(runContentMigration([sandbox.dir]).sidecarsFolded).toBe(0);
    expect(fs.readFileSync(sidecarPath, "utf8")).toBe(malformed);
  } finally {
    sandbox.cleanup();
  }
});

test("retains a sidecar whose filename escapes its directory", () => {
  const sandbox = makeSandboxDir("akm-content-sidecar-confinement");
  try {
    const dir = path.join(sandbox.dir, "memories");
    fs.mkdirSync(dir, { recursive: true });
    const outside = path.join(sandbox.dir, "outside.md");
    const outsideBytes = "# Outside\n";
    fs.writeFileSync(outside, outsideBytes);
    const sidecarPath = path.join(dir, ".stash.json");
    fs.writeFileSync(
      sidecarPath,
      `${JSON.stringify({
        entries: [{ name: "outside", type: "memory", filename: "../outside.md", description: "overwrite" }],
      })}\n`,
    );

    const report = runContentMigration([sandbox.dir]);
    expect(report.entriesSkipped).toBe(1);
    expect(report.sidecarsFolded).toBe(0);
    expect(fs.existsSync(sidecarPath)).toBe(true);
    expect(fs.readFileSync(outside, "utf8")).toBe(outsideBytes);
  } finally {
    sandbox.cleanup();
  }
});

test("does not overwrite malformed frontmatter during source backref migration", () => {
  const sandbox = makeSandboxDir("akm-content-malformed-frontmatter");
  try {
    const dir = path.join(sandbox.dir, "memories");
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, "derived.md");
    const original = '---\nsource: memory:parent\ntitle: "unterminated\ntags:\n  - keep-me\n---\nBody.\n';
    fs.writeFileSync(filePath, original);

    expect(runContentMigration([sandbox.dir]).sourceBackrefsRewritten).toBe(0);
    expect(fs.readFileSync(filePath, "utf8")).toBe(original);
  } finally {
    sandbox.cleanup();
  }
});

test("rescues reserved files indexed by the frozen layout without renaming wiki structure", () => {
  const sandbox = makeSandboxDir("akm-content-reserved-rescue");
  try {
    const knowledge = path.join(sandbox.dir, "knowledge");
    const wiki = path.join(sandbox.dir, "wikis", "team");
    fs.mkdirSync(knowledge, { recursive: true });
    fs.mkdirSync(wiki, { recursive: true });
    fs.writeFileSync(path.join(knowledge, "index.md"), "---\ntags: [legacy]\n---\nLegacy concept.\n");
    fs.writeFileSync(path.join(wiki, "index.md"), "---\ndescription: Team wiki\n---\nWiki structure.\n");

    const report = runContentMigration([sandbox.dir]);
    expect(report.reservedRenames).toEqual([
      { from: path.join(knowledge, "index.md"), to: path.join(knowledge, "index-content.md") },
    ]);
    expect(fs.existsSync(path.join(knowledge, "index-content.md"))).toBe(true);
    expect(fs.existsSync(path.join(wiki, "index.md"))).toBe(true);
  } finally {
    sandbox.cleanup();
  }
});
