// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * WI-1.2 — `src/core/recognition-util.ts` util home (D1-4).
 *
 * Two things pinned here:
 *   (a) the four relocated symbols export with their expected values/shapes
 *       (a behavior-preserving move must not change them); and
 *   (b) the D1-5 cycle-safety invariant — this module must import NOTHING
 *       from `src/` — mechanized by reading the source text directly and
 *       asserting no `import ... from "..."` line references a relative
 *       (`./`/`../`) path, since a relative specifier from this file could
 *       only ever resolve back into `src/`.
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import {
  canonicalizeWorkflowName,
  DERIVED_SUFFIX,
  SCRIPT_EXTENSIONS,
  WORKFLOW_EXTENSIONS,
} from "../../src/core/recognition-util";

describe("recognition-util — relocated symbol values (behavior-preserving move)", () => {
  test("SCRIPT_EXTENSIONS is the Set of 16 recognized script extensions", () => {
    expect(SCRIPT_EXTENSIONS).toBeInstanceOf(Set);
    expect(SCRIPT_EXTENSIONS.size).toBe(16);
    for (const ext of [
      ".sh",
      ".ts",
      ".js",
      ".ps1",
      ".cmd",
      ".bat",
      ".py",
      ".rb",
      ".go",
      ".pl",
      ".php",
      ".lua",
      ".r",
      ".swift",
      ".kt",
      ".kts",
    ]) {
      expect(SCRIPT_EXTENSIONS.has(ext)).toBe(true);
    }
  });

  test("WORKFLOW_EXTENSIONS is the readonly [.md, .yaml, .yml] tuple, .md first", () => {
    expect(WORKFLOW_EXTENSIONS).toEqual([".md", ".yaml", ".yml"]);
  });

  test("canonicalizeWorkflowName strips a recognized workflow extension, else passes through", () => {
    expect(canonicalizeWorkflowName("foo.md")).toBe("foo");
    expect(canonicalizeWorkflowName("foo.yaml")).toBe("foo");
    expect(canonicalizeWorkflowName("foo.yml")).toBe("foo");
    expect(canonicalizeWorkflowName("foo")).toBe("foo");
    expect(canonicalizeWorkflowName("foo.FOO")).toBe("foo.FOO");
  });

  test("DERIVED_SUFFIX is the structural .derived marker", () => {
    expect(DERIVED_SUFFIX).toBe(".derived");
  });
});

describe("recognition-util — D1-5 cycle-safety invariant (import-free)", () => {
  const SRC_PATH = path.join(import.meta.dir, "../../src/core/recognition-util.ts");

  test("the file exists at the expected util-home path", () => {
    expect(fs.existsSync(SRC_PATH)).toBe(true);
  });

  test("no import/export-from line references a relative (./ or ../) path into src", () => {
    const text = fs.readFileSync(SRC_PATH, "utf8");
    const lines = text.split("\n");
    const importLikeLines = lines.filter((line) => /^\s*(import|export)\b.*\bfrom\s+["']/.test(line));
    const internalSrcImports = importLikeLines.filter((line) => /from\s+["']\.\.?\//.test(line));
    expect(internalSrcImports).toEqual([]);
  });

  test("no bare import/export-from statement at all — the module is a pure leaf (0 module-level dependencies)", () => {
    const text = fs.readFileSync(SRC_PATH, "utf8");
    const sourceFile = text;
    const hasAnyFromImport = /^\s*(import|export)\b.*\bfrom\s+["'][^"']+["']/m.test(sourceFile);
    expect(hasAnyFromImport).toBe(false);
  });
});
