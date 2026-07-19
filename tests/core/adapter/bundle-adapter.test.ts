// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * WI-1.1 gate — type-level conformance test for the amended `BundleAdapter`
 * interface (`src/core/adapter/bundle-adapter.ts`) + its supporting type
 * family (`src/core/adapter/types.ts`).
 *
 * A minimal STUB adapter implements only the REQUIRED members (`id`,
 * `version`, `extensions`, `recognize`, `validate`) and is assigned to a
 * `BundleAdapter`-typed const below. That assignment is the COMPILE-TIME
 * half of the gate: `bunx tsc --noEmit` fails if the stub does not
 * structurally satisfy `BundleAdapter` given only its required members —
 * which in turn proves the whole D1-1 type family (`BundleComponent`,
 * `IndexDocument`, `Diagnostic`, `ValidateContext`, ...) compiles and is
 * usable together with `FileChange` (reused from `core/file-change.ts`) and
 * the type-only `FileContext` import (D1-3, `indexer/walk/file-context.ts`).
 * The tests below are the RUNTIME half: the required methods are present
 * and callable, and behave sanely against fixture inputs.
 *
 * Deliberately NOT in scope here (per the chunk-1 brief):
 *   - `scanComponent` (WI-1.3, a sibling module not yet minted);
 *   - any REAL adapter or the `index() == fold(recognize())` conformance
 *     suite (Chunk 2's gate, requires real adapters).
 */

import { describe, expect, test } from "bun:test";
import type { Stats } from "node:fs";
import type { BundleAdapter } from "../../../src/core/adapter/bundle-adapter";
import type { BundleComponent, Diagnostic, IndexDocument, ValidateContext } from "../../../src/core/adapter/types";
import type { FileChange } from "../../../src/core/file-change";
import type { FileContext } from "../../../src/indexer/walk/file-context";

function makeFileContext(overrides: Partial<FileContext> = {}): FileContext {
  return {
    absPath: "/bundle/notes/example.md",
    relPath: "notes/example.md",
    ext: ".md",
    fileName: "example.md",
    parentDir: "notes",
    parentDirAbs: "/bundle/notes",
    ancestorDirs: ["notes"],
    stashRoot: "/bundle",
    content: () => "# Example",
    frontmatter: () => null,
    stat: () => ({}) as Stats,
    ...overrides,
  };
}

function makeComponent(overrides: Partial<BundleComponent> = {}): BundleComponent {
  return { id: "main", adapter: "stub", root: "/bundle", writable: true, ...overrides };
}

function makeValidateContext(): ValidateContext {
  return {
    readFile: async () => null,
    list: async () => [],
    resolveRef: async () => ({ exists: false }),
  };
}

/**
 * The stub itself: implements ONLY the required surface
 * (id/version/extensions/recognize/validate). This assignment is the
 * compile-time conformance check — `stubAdapter` must structurally satisfy
 * `BundleAdapter` with every OTHER member (index, affectedItems, placeNew,
 * directoryList, looksLikeRoot) left absent, proving they are genuinely
 * optional per the transcription. (The spec's Tier-B authoring/export/memory
 * facet methods are deferred, not declared on the 0.9.0 contract — see the
 * interface docblock.)
 */
const stubAdapter: BundleAdapter = {
  id: "stub",
  version: "0.0.0",
  extensions: [".md"],

  recognize(_c: BundleComponent, file: FileContext): IndexDocument | null {
    if (file.ext !== ".md") return null;
    const conceptId = file.relPath.replace(/\.md$/, "");
    return {
      ref: `stub//${conceptId}`,
      bundle: "stub",
      component: "main",
      conceptId,
      path: file.absPath,
      hash: "deadbeef",
      adapterId: "stub",
      // `type` is a required member of the merged IndexDocument (F4a M-core-1).
      type: "knowledge",
      name: file.fileName,
    };
  },

  async validate(_c: BundleComponent, _changes: FileChange[], _ctx: ValidateContext): Promise<Diagnostic[]> {
    return [];
  },
};

describe("BundleAdapter type-level conformance (WI-1.1)", () => {
  test("a minimal stub implementing only the REQUIRED members typechecks as BundleAdapter", () => {
    // See the compile-time note on `stubAdapter` above. This assertion is
    // the runtime half: required methods exist and are callable.
    expect(typeof stubAdapter.recognize).toBe("function");
    expect(typeof stubAdapter.validate).toBe("function");
    expect(stubAdapter.id).toBe("stub");
    expect(stubAdapter.version).toBe("0.0.0");
    expect(stubAdapter.extensions).toEqual([".md"]);
  });

  test("recognize is callable and returns an IndexDocument for a matching file", () => {
    const doc = stubAdapter.recognize(makeComponent(), makeFileContext());
    expect(doc).not.toBeNull();
    expect(doc?.ref).toBe("stub//notes/example");
    expect(doc?.conceptId).toBe("notes/example");
    expect(doc?.name).toBe("example.md");
  });

  test("recognize abstains (returns null) for a non-matching file", () => {
    const doc = stubAdapter.recognize(makeComponent(), makeFileContext({ ext: ".txt", relPath: "notes/example.txt" }));
    expect(doc).toBeNull();
  });

  test("validate is callable and resolves a Diagnostic[]", async () => {
    const diagnostics = await stubAdapter.validate(makeComponent(), [], makeValidateContext());
    expect(Array.isArray(diagnostics)).toBe(true);
    expect(diagnostics).toEqual([]);
  });

  test("all optional members are legitimately absent on a REQUIRED-only stub", () => {
    expect(stubAdapter.index).toBeUndefined();
    expect(stubAdapter.affectedItems).toBeUndefined();
    expect(stubAdapter.placeNew).toBeUndefined();
    expect(stubAdapter.directoryList).toBeUndefined();
    expect(stubAdapter.looksLikeRoot).toBeUndefined();
  });
});
