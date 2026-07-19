// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * WI-1.3 — `scanComponent` (`src/core/adapter/scan-component.ts`, decision
 * D1-7): the core-owned git-aware/symlink-safe/skip-dirs walk of ONE
 * component's root, MINUS every other configured component's root that is
 * strictly nested inside it (normative §9.3), x `adapter.recognize` per
 * file.
 *
 * Exercised against a STUB adapter implementing only `recognize`
 * (+ `validate`, required by the interface but unused here) — per the
 * chunk-1 brief, real adapters and the `index() == fold(recognize)`
 * conformance suite are Chunk 2's gate, not this one's.
 *
 * Three groups:
 *   1. basic walk — recognized files yield an IndexDocument each; abstained
 *      files (adapter.recognize returned null) are silently skipped.
 *   2. skip-dirs / symlink safety — mirrors `tests/integration/walker.test.ts`'s
 *      guarantees (SKIP_DIRS contents never walked, symlinks never followed)
 *      and asserts they hold THROUGH `scanComponent`, not just
 *      `walkStashFlat` directly.
 *   3. nested-root subtraction (the new §9.3 behavior, no prior analog) — the
 *      load-bearing case: a parent component's root contains a nested CHILD
 *      component's root (both registered in `inst.components`).
 *      `scanComponent(parent)` must NOT yield files under the child root;
 *      `scanComponent(child)` must yield them. Also covers a doubly-nested
 *      grandchild, a false-positive-prefix sibling (`comp` vs `comp-other`,
 *      pinning the strict path-boundary check over naive string prefixing),
 *      and the single-component (no "other" at all) baseline.
 */

import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BundleAdapter } from "../../../src/core/adapter/bundle-adapter";
import { scanComponent } from "../../../src/core/adapter/scan-component";
import type { BundleComponent, BundleInstallation, IndexDocument } from "../../../src/core/adapter/types";
import type { FileContext } from "../../../src/indexer/walk/file-context";

const createdTmpDirs: string[] = [];

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-scan-component-"));
  createdTmpDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of createdTmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function writeFile(filePath: string, content = "# stub\n"): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

/** A minimal stub `BundleAdapter`: recognizes `.md` files, abstains (null) on everything else. */
function makeStubAdapter(): BundleAdapter {
  return {
    id: "stub",
    version: "0.0.0",
    extensions: [".md"],

    recognize(c: BundleComponent, file: FileContext): IndexDocument | null {
      if (file.ext !== ".md") return null;
      const conceptId = file.relPath.replace(/\.md$/, "");
      return {
        ref: `stub//${conceptId}`,
        bundle: "stub",
        component: c.id,
        conceptId,
        path: file.absPath,
        hash: "deadbeef",
        adapterId: "stub",
        // `type` is a required member of the merged IndexDocument (F4a M-core-1).
        type: "knowledge",
        name: file.fileName,
      };
    },

    async validate() {
      return [];
    },
  };
}

function makeComponent(overrides: Partial<BundleComponent> = {}): BundleComponent {
  return { id: "main", adapter: "stub", root: "/nonexistent", writable: true, ...overrides };
}

function makeInstallation(components: BundleComponent[]): BundleInstallation {
  return { id: "stub-bundle", components, trusted: true };
}

async function drain(iterable: AsyncIterable<IndexDocument>): Promise<IndexDocument[]> {
  const out: IndexDocument[] = [];
  for await (const doc of iterable) out.push(doc);
  return out;
}

// ── 1. Basic walk ────────────────────────────────────────────────────────────

describe("scanComponent — basic walk", () => {
  test("yields one IndexDocument per recognized file; skips files the adapter abstains on", async () => {
    const root = tmpDir();
    writeFile(path.join(root, "notes", "one.md"), "# One\n");
    writeFile(path.join(root, "notes", "two.md"), "# Two\n");
    writeFile(path.join(root, "data.json"), "{}"); // not .md — stub abstains

    const component = makeComponent({ root });
    const inst = makeInstallation([component]);
    const docs = await drain(scanComponent(inst, component, makeStubAdapter()));

    expect(docs).toHaveLength(2);
    expect(docs.map((d) => d.name).sort()).toEqual(["one.md", "two.md"]);
    for (const doc of docs) {
      expect(doc.adapterId).toBe("stub");
      expect(doc.component).toBe("main");
    }
  });

  test("yields nothing when the component root does not exist (walkStashFlat's own guard)", async () => {
    const component = makeComponent({ root: path.join(os.tmpdir(), "akm-scan-component-does-not-exist") });
    const inst = makeInstallation([component]);
    const docs = await drain(scanComponent(inst, component, makeStubAdapter()));
    expect(docs).toEqual([]);
  });
});

// ── 2. skip-dirs / symlink safety (reused from walkStashFlat, asserted through scanComponent) ──

describe("scanComponent — skip-dirs / symlink safety", () => {
  test("SKIP_DIRS contents (node_modules, .cache) and dot-directories are not walked", async () => {
    // Deliberately does NOT create a literal ".git" directory here (that
    // would make isInsideGitRepo() treat this fixture as a real repo and
    // route through walkStashGit's `git ls-files` instead of exercising the
    // manual walker's own SKIP_DIRS/dot-dir filtering directly).
    const root = tmpDir();
    writeFile(path.join(root, "node_modules", "pkg", "readme.md"), "# ignored\n");
    writeFile(path.join(root, ".cache", "readme.md"), "# ignored\n");
    writeFile(path.join(root, ".hidden", "readme.md"), "# ignored\n");
    writeFile(path.join(root, "notes", "keep.md"), "# Keep\n");

    const component = makeComponent({ root });
    const inst = makeInstallation([component]);
    const docs = await drain(scanComponent(inst, component, makeStubAdapter()));

    expect(docs).toHaveLength(1);
    expect(docs[0]?.name).toBe("keep.md");
  });

  test("a symlink pointing outside the component root is not followed", async () => {
    const root = tmpDir();
    const outsideFile = path.join(os.tmpdir(), `akm-scan-component-outside-${process.pid}-${Date.now()}.md`);
    fs.writeFileSync(outsideFile, "# secret content outside the component\n");
    writeFile(path.join(root, "notes", "keep.md"), "# Keep\n");
    fs.symlinkSync(outsideFile, path.join(root, "notes", "escaped.md"));

    try {
      const component = makeComponent({ root });
      const inst = makeInstallation([component]);
      const docs = await drain(scanComponent(inst, component, makeStubAdapter()));

      expect(docs.map((d) => d.name).sort()).toEqual(["keep.md"]);
      expect(docs.some((d) => d.path === outsideFile)).toBe(false);
    } finally {
      fs.rmSync(outsideFile, { force: true });
    }
  });
});

// ── 3. Nested-root subtraction (normative §9.3 — the new behavior) ──────────

describe("scanComponent — nested-root subtraction (normative §9.3)", () => {
  test("parent excludes files under a nested child component root; child includes them", async () => {
    const parentRoot = tmpDir();
    writeFile(path.join(parentRoot, "parent-only.md"), "# Parent only\n");
    const childRoot = path.join(parentRoot, "workflows");
    writeFile(path.join(childRoot, "release.md"), "# Release\n");

    const parent = makeComponent({ id: "main", root: parentRoot });
    const child = makeComponent({ id: "workflows", root: childRoot });
    const inst = makeInstallation([parent, child]);

    const parentDocs = await drain(scanComponent(inst, parent, makeStubAdapter()));
    expect(parentDocs.map((d) => d.name)).toEqual(["parent-only.md"]);
    expect(parentDocs.every((d) => d.component === "main")).toBe(true);

    const childDocs = await drain(scanComponent(inst, child, makeStubAdapter()));
    expect(childDocs.map((d) => d.name)).toEqual(["release.md"]);
    expect(childDocs.every((d) => d.component === "workflows")).toBe(true);
  });

  test("doubly-nested grandchild is subtracted from both the parent and the intermediate child", async () => {
    const parentRoot = tmpDir();
    const childRoot = path.join(parentRoot, "child");
    const grandchildRoot = path.join(childRoot, "grandchild");

    writeFile(path.join(parentRoot, "top.md"), "# top\n");
    writeFile(path.join(childRoot, "mid.md"), "# mid\n");
    writeFile(path.join(grandchildRoot, "leaf.md"), "# leaf\n");

    const parent = makeComponent({ id: "parent", root: parentRoot });
    const child = makeComponent({ id: "child", root: childRoot });
    const grandchild = makeComponent({ id: "grandchild", root: grandchildRoot });
    const inst = makeInstallation([parent, child, grandchild]);

    const parentDocs = await drain(scanComponent(inst, parent, makeStubAdapter()));
    expect(parentDocs.map((d) => d.name)).toEqual(["top.md"]);

    const childDocs = await drain(scanComponent(inst, child, makeStubAdapter()));
    expect(childDocs.map((d) => d.name)).toEqual(["mid.md"]);

    const grandchildDocs = await drain(scanComponent(inst, grandchild, makeStubAdapter()));
    expect(grandchildDocs.map((d) => d.name)).toEqual(["leaf.md"]);
  });

  test("a sibling root sharing a textual prefix (not strict nesting) is NOT subtracted", async () => {
    // "comp-other" starts with the string "comp" but is NOT a path descendant
    // of "comp" — pins the path.relative-based boundary check over naive
    // string prefixing.
    const base = tmpDir();
    const compRoot = path.join(base, "comp");
    const otherRoot = path.join(base, "comp-other");

    writeFile(path.join(compRoot, "a.md"), "# a\n");
    writeFile(path.join(otherRoot, "b.md"), "# b\n");

    const comp = makeComponent({ id: "comp", root: compRoot });
    const other = makeComponent({ id: "comp-other", root: otherRoot });
    const inst = makeInstallation([comp, other]);

    const compDocs = await drain(scanComponent(inst, comp, makeStubAdapter()));
    expect(compDocs.map((d) => d.name)).toEqual(["a.md"]);

    const otherDocs = await drain(scanComponent(inst, other, makeStubAdapter()));
    expect(otherDocs.map((d) => d.name)).toEqual(["b.md"]);
  });

  test("a component's own root is not treated as nested under itself (single-component baseline)", async () => {
    const root = tmpDir();
    writeFile(path.join(root, "solo.md"), "# solo\n");

    const comp = makeComponent({ id: "solo", root });
    const inst = makeInstallation([comp]); // no other components at all
    const docs = await drain(scanComponent(inst, comp, makeStubAdapter()));
    expect(docs.map((d) => d.name)).toEqual(["solo.md"]);
  });

  test("an unrelated component elsewhere on disk (not nested under c.root) is not subtracted", async () => {
    const parentRoot = tmpDir();
    const unrelatedRoot = tmpDir(); // a completely separate temp root, not under parentRoot

    writeFile(path.join(parentRoot, "keep.md"), "# keep\n");
    writeFile(path.join(unrelatedRoot, "elsewhere.md"), "# elsewhere\n");

    const parent = makeComponent({ id: "main", root: parentRoot });
    const unrelated = makeComponent({ id: "unrelated", root: unrelatedRoot });
    const inst = makeInstallation([parent, unrelated]);

    const parentDocs = await drain(scanComponent(inst, parent, makeStubAdapter()));
    expect(parentDocs.map((d) => d.name)).toEqual(["keep.md"]);
  });
});
