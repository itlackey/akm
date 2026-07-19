// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * akm 0.9.0 Chunk-5 flip, F4c M1 — REF_RE dual-recognition.
 *
 * The linter's missing-ref scan and `akm mv`'s inbound-xref rewrite must
 * recognize BOTH the legacy `type:name` grammar (`// F5: delete`) AND the 0.9.0
 * `[bundle//]conceptId` grammar the output emitter now writes into frontmatter
 * (ref-grammar decision D-R3). The specific gap this closes: a flipped
 * short-conceptId `supersededBy` value (e.g. `memories/foo`) was invisible to
 * the old `type:name`-only scan.
 */

import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { akmLint } from "../../src/commands/lint/index";
import { runCliCapture } from "../_helpers/cli";
import { makeConfig } from "../_helpers/factories";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../_helpers/sandbox";

const tempDirs: string[] = [];

function makeStash(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-lint-dual-"));
  tempDirs.push(dir);
  for (const sub of ["memories", "knowledge"]) fs.mkdirSync(path.join(dir, sub), { recursive: true });
  return dir;
}

function writeMemory(stashDir: string, name: string, frontmatter: string, body = "body text"): void {
  const fm = frontmatter ? `---\n${frontmatter}\n---\n` : "";
  fs.writeFileSync(path.join(stashDir, "memories", `${name}.md`), `${fm}${body}\n`, "utf8");
}

function missingRefDetails(stashDir: string): string[] {
  const res = akmLint({ dir: stashDir, config: makeConfig(stashDir) });
  return res.flagged.filter((i) => i.issue === "missing-ref").map((i) => i.detail);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("F4c M1 — linter missing-ref dual grammar", () => {
  test("short conceptId supersededBy pointing at an EXISTING asset is not flagged", () => {
    const stash = makeStash();
    writeMemory(stash, "target", "");
    writeMemory(stash, "source", "supersededBy: [memories/target]");
    expect(missingRefDetails(stash)).toEqual([]);
  });

  test("short conceptId supersededBy pointing at a MISSING asset IS flagged (the closed gap)", () => {
    const stash = makeStash();
    writeMemory(stash, "source", "supersededBy: [memories/ghost]");
    const details = missingRefDetails(stash);
    expect(details.some((d) => d.includes("memories/ghost") && d.includes("supersededBy"))).toBe(true);
  });

  test("fully-qualified bundle//conceptId xref to a MISSING asset is flagged", () => {
    const stash = makeStash();
    writeMemory(stash, "source", "xrefs: [core//memories/ghost]");
    const details = missingRefDetails(stash);
    expect(details.some((d) => d.includes("core//memories/ghost"))).toBe(true);
  });

  test("legacy type:name xref keeps working — existing not flagged, missing flagged", () => {
    const stash = makeStash();
    writeMemory(stash, "target", "");
    writeMemory(stash, "ok", "xrefs: [memory:target]");
    writeMemory(stash, "bad", "xrefs: [memory:ghost]");
    const details = missingRefDetails(stash);
    expect(details.some((d) => d.includes("memory:ghost"))).toBe(true);
    expect(details.some((d) => d.includes("memory:target"))).toBe(false);
  });

  test("a bare short conceptId in PROSE is NOT a ref (no false positive, D-R3)", () => {
    const stash = makeStash();
    // No frontmatter refs list; conceptId-shaped token only in the body prose.
    writeMemory(stash, "source", "", "see memories/ghost for details");
    expect(missingRefDetails(stash)).toEqual([]);
  });

  test("a fully-qualified bundle//conceptId in PROSE body IS recognized", () => {
    const stash = makeStash();
    writeMemory(stash, "source", "", "see core//memories/ghost for details");
    const details = missingRefDetails(stash);
    expect(details.some((d) => d.includes("core//memories/ghost"))).toBe(true);
  });
});

describe("F4c M1 — akm mv rewrites both grammars", () => {
  let storage: IsolatedAkmStorage;

  afterEach(() => {
    storage?.cleanup();
  });

  test("a conceptId-spelled xref AND a legacy xref both re-point after a rename", async () => {
    storage = withIsolatedAkmStorage();
    const stashDir = storage.stashDir;
    fs.mkdirSync(path.join(stashDir, "memories"), { recursive: true });
    // The asset being moved.
    fs.writeFileSync(path.join(stashDir, "memories", "old-note.md"), "# old note\n", "utf8");
    // A citer carrying the SAME logical ref in both grammars.
    fs.writeFileSync(
      path.join(stashDir, "memories", "citer.md"),
      [
        "---",
        "xrefs: [memories/old-note, memory:old-note]",
        "---",
        "See memories/old-note and memory:old-note.",
        "",
      ].join("\n"),
      "utf8",
    );

    const res = await runCliCapture(["mv", "memory:old-note", "new-note"]);
    expect(res.code).toBe(0);

    const citer = fs.readFileSync(path.join(stashDir, "memories", "citer.md"), "utf8");
    // Both grammars re-pointed onto the new name, each preserving its grammar.
    expect(citer).toContain("memories/new-note");
    expect(citer).toContain("memory:new-note");
    expect(citer).not.toContain("old-note");
  });
});
