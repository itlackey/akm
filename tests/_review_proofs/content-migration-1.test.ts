// Proof test for CANDIDATE finding:
// "A corrupt/truncated/wrong-shape .stash.json is deleted with ZERO entries
//  folded, losing the entire sidecar silently."
//
// Trace under review:
//   foldSidecarInDir (content-migration.ts L242-253):
//     readLegacyStashOverrides(dir) -> iterate overrides?.entries ?? [] ->
//     fs.rmSync(sidecar) UNCONDITIONALLY -> report.sidecarsFolded++
//   readLegacyStashOverrides (legacy-stash-json.ts L49-73):
//     JSON.parse in try{...}catch{return null}, and returns null when
//     raw.entries is not an array.

import { test, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runContentMigration } from "../../src/migrate/legacy/content-migration";

function mkroot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "akm-cm1-"));
}

test("truncated .stash.json is deleted with zero entries folded (silent loss)", () => {
  const root = mkroot();
  const note = path.join(root, "note.md");
  const sidecar = path.join(root, ".stash.json");

  // A real, foldable markdown target: has frontmatter, but NO curated description.
  fs.writeFileSync(note, "---\ntitle: My Note\n---\nbody text\n");

  // A .stash.json truncated mid-write. The readable prefix clearly holds a
  // curated 'CURATED' description that WOULD have folded into note.md, but the
  // trailing brackets are missing so JSON.parse throws.
  const truncated = '{"entries":[{"name":"note","filename":"note.md","description":"CURATED"';
  fs.writeFileSync(sidecar, truncated);
  // sanity: it really is unparseable
  let parseThrew = false;
  try {
    JSON.parse(truncated);
  } catch {
    parseThrew = true;
  }
  expect(parseThrew).toBe(true);

  const report = runContentMigration([root]);

  // DEFECT ASSERTIONS ------------------------------------------------------
  // 1. The sidecar file is destroyed.
  expect(fs.existsSync(sidecar)).toBe(false);
  // 2. The report claims a sidecar was "folded" even though nothing folded.
  expect(report.sidecarsFolded).toBe(1);
  expect(report.entriesFolded).toBe(0);
  expect(report.entriesSkipped).toBe(0);
  // 3. The curated 'CURATED' description was NOT recovered into note.md.
  const noteAfter = fs.readFileSync(note, "utf8");
  expect(noteAfter.includes("CURATED")).toBe(false);
  // The note is untouched — the curated metadata is simply gone, and the raw
  // (hand-recoverable) sidecar bytes are gone too.
  expect(noteAfter).toBe("---\ntitle: My Note\n---\nbody text\n");
});

test("wrong-shape .stash.json (entries not an array) is also deleted silently", () => {
  const root = mkroot();
  const sidecar = path.join(root, ".stash.json");

  // Valid JSON, but the top-level shape lacks an `entries` array.
  // readLegacyStashOverrides returns null at L54 (raw.entries not Array).
  fs.writeFileSync(
    sidecar,
    JSON.stringify({ notEntries: [{ name: "note", filename: "note.md", description: "CURATED" }] }),
  );

  const report = runContentMigration([root]);

  expect(fs.existsSync(sidecar)).toBe(false);
  expect(report.sidecarsFolded).toBe(1);
  expect(report.entriesFolded).toBe(0);
});

test("CONTROL: a well-formed .stash.json actually folds its curated description", () => {
  const root = mkroot();
  const note = path.join(root, "note.md");
  const sidecar = path.join(root, ".stash.json");

  fs.writeFileSync(note, "---\ntitle: My Note\n---\nbody text\n");
  fs.writeFileSync(
    sidecar,
    JSON.stringify({
      entries: [{ name: "note", type: "skill", filename: "note.md", description: "CURATED" }],
    }),
  );

  const report = runContentMigration([root]);

  // The healthy path proves the harness is wired right: this one DOES fold.
  expect(fs.existsSync(sidecar)).toBe(false);
  expect(report.sidecarsFolded).toBe(1);
  expect(report.entriesFolded).toBe(1);
  expect(fs.readFileSync(note, "utf8").includes("CURATED")).toBe(true);
});
