// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Conformance gate for the `generic-files` adapter (#46).
 *
 * Drives the adapter over `tests/fixtures/bundles/generic-files/` and asserts the
 * four authored goldens under `tests/fixtures/format-family-goldens/generic-files/`.
 * Exercises the open-question-5 classification (script / document / file), the
 * identity placement, and the EXPLICIT-CONFIG-ONLY contract (`looksLikeRoot`
 * never fires). `script` presents type-specifically; `document`/`file` fall to
 * the generic renderer fallback.
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { genericFilesAdapter } from "../../../src/core/adapter/adapters/generic-files-adapter";
import type { BundleComponent, Diagnostic, IndexDocument, ValidateContext } from "../../../src/core/adapter/types";
import type { FileChange } from "../../../src/core/file-change";
import { presentationFor } from "../../../src/core/type-presentation";
import { buildFileContext } from "../../../src/indexer/walk/file-context";

const FIXTURE_ROOT = path.join(import.meta.dir, "../../fixtures/bundles/generic-files");
const GOLDENS_ROOT = path.join(import.meta.dir, "../../fixtures/format-family-goldens/generic-files");
const BUNDLE_ID = "sample-generic";

function loadGolden(name: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(GOLDENS_ROOT, `${name}.json`), "utf8"));
}

function component(): BundleComponent {
  return { id: BUNDLE_ID, adapter: "generic-files", root: FIXTURE_ROOT, writable: true };
}

function recognizeRel(relPath: string): IndexDocument | null {
  return genericFilesAdapter.recognize(component(), buildFileContext(FIXTURE_ROOT, path.join(FIXTURE_ROOT, relPath)));
}

const ctx: ValidateContext = {
  readFile: async (p) => {
    try {
      return fs.readFileSync(path.join(FIXTURE_ROOT, p), "utf8");
    } catch {
      return null;
    }
  },
  list: async () => [],
  resolveRef: async () => ({ exists: false }),
};

describe("generic-files adapter — metadata + explicit-config", () => {
  test("id / version", () => {
    expect(genericFilesAdapter.id).toBe("generic-files");
    expect(genericFilesAdapter.version).toBe("0.9.0");
  });

  test("looksLikeRoot NEVER fires (explicit-config only, §1.2)", () => {
    expect(genericFilesAdapter.looksLikeRoot?.(FIXTURE_ROOT)).toBe(false);
  });
});

describe("generic-files adapter — recognition golden (script/document/file)", () => {
  const byRelPath = loadGolden("recognition").byRelPath as Record<string, Record<string, unknown>>;

  for (const [relPath, expected] of Object.entries(byRelPath)) {
    test(`recognize(${relPath})`, () => {
      const doc = recognizeRel(relPath);
      expect(doc, `${relPath} must be recognized`).not.toBeNull();
      if (!doc) throw new Error("unreachable");
      expect(doc.adapterId).toBe(expected.adapterId as string);
      expect(doc.component).toBe(expected.component as string);
      expect(doc.type).toBe(expected.type as string);
      expect(doc.conceptId).toBe(expected.conceptId as string);
      expect(doc.ref).toBe(expected.ref as string);
      expect(doc.name).toBe(expected.name as string);
    });
  }
});

describe("generic-files adapter — placement golden (identity)", () => {
  const byType = loadGolden("placement").byType as Record<string, { conceptId: string; assetPath: string }>;

  function relFromRoot(abs: string): string {
    return path.relative(FIXTURE_ROOT, abs).split(path.sep).join("/");
  }

  for (const [typeKey, expected] of Object.entries(byType)) {
    test(`placeNew(${typeKey}) → ${expected.assetPath}`, () => {
      const abs = genericFilesAdapter.placeNew?.(component(), expected.conceptId);
      expect(relFromRoot(abs as string)).toBe(expected.assetPath);
    });
  }
});

describe("generic-files adapter — renderer golden (script known; document/file generic)", () => {
  const byRelPath = loadGolden("renderer").byRelPath as Record<string, Record<string, unknown>>;

  for (const [relPath, expected] of Object.entries(byRelPath)) {
    test(`presentationFor(${relPath})`, () => {
      const doc = recognizeRel(relPath);
      expect(doc?.type).toBe(expected.type as string);
      const p = presentationFor(doc?.type ?? "");
      expect(p.label).toBe(expected.label as string);
      expect(p.renderer ?? null).toBe((expected.renderer as string | null) ?? null);
      const action = p.action ? p.action(doc?.ref ?? "") : `akm show ${doc?.ref}`;
      expect(action).toBe(expected.action as string);
    });
  }
});

describe("generic-files adapter — lint golden (base checks only)", () => {
  const perType = loadGolden("lint").perType as Record<string, { relPath: string; issues: Diagnostic[] }>;

  test("every file validates clean ([])", async () => {
    const changes: FileChange[] = Object.values(perType).map((e) => ({
      path: e.relPath,
      op: "update" as const,
      after: fs.readFileSync(path.join(FIXTURE_ROOT, e.relPath), "utf8"),
    }));
    const diags = await genericFilesAdapter.validate(component(), changes, ctx);
    const byFile = new Map<string, string[]>();
    for (const d of diags) byFile.set(d.file, [...(byFile.get(d.file) ?? []), d.issue]);
    for (const entry of Object.values(perType)) {
      expect(byFile.get(entry.relPath) ?? [], entry.relPath).toEqual((entry.issues ?? []).map((i) => i.issue));
    }
  });
});
