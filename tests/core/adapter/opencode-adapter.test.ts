// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Conformance gate for the `opencode` tool-directory adapter (#46).
 *
 * Drives the adapter over `tests/fixtures/bundles/opencode/` and asserts the
 * four authored goldens under `tests/fixtures/format-family-goldens/opencode/`.
 * Beyond the shared tool-dir shape it exercises the open-question-6 SINGULAR
 * directory alias (`command/legacy.md`).
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { opencodeAdapter } from "../../../src/core/adapter/adapters/opencode-adapter";
import type { BundleComponent, Diagnostic, IndexDocument, ValidateContext } from "../../../src/core/adapter/types";
import type { FileChange } from "../../../src/core/file-change";
import { presentationFor } from "../../../src/core/type-presentation";
import { buildFileContext } from "../../../src/indexer/walk/file-context";

const FIXTURE_ROOT = path.join(import.meta.dir, "../../fixtures/bundles/opencode");
const GOLDENS_ROOT = path.join(import.meta.dir, "../../fixtures/format-family-goldens/opencode");
const BUNDLE_ID = "sample-opencode";

function loadGolden(name: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(GOLDENS_ROOT, `${name}.json`), "utf8"));
}

function component(): BundleComponent {
  return { id: BUNDLE_ID, adapter: "opencode", root: FIXTURE_ROOT, writable: true };
}

function recognizeRel(relPath: string): IndexDocument | null {
  return opencodeAdapter.recognize(component(), buildFileContext(FIXTURE_ROOT, path.join(FIXTURE_ROOT, relPath)));
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

describe("opencode adapter — metadata", () => {
  test("id / version / extensions", () => {
    expect(opencodeAdapter.id).toBe("opencode");
    expect(opencodeAdapter.version).toBe("0.9.0");
    expect(opencodeAdapter.extensions).toEqual([".md"]);
  });
});

describe("opencode adapter — recognition golden", () => {
  const byRelPath = loadGolden("recognition").byRelPath as Record<string, Record<string, unknown>>;

  for (const [relPath, expected] of Object.entries(byRelPath)) {
    test(`recognize(${relPath})`, () => {
      const doc = recognizeRel(relPath);
      if (expected.recognized === false) {
        expect(doc, `${relPath} must abstain`).toBeNull();
        return;
      }
      expect(doc, `${relPath} must be recognized`).not.toBeNull();
      if (!doc) throw new Error("unreachable");
      expect(doc.adapterId).toBe(expected.adapterId as string);
      expect(doc.component).toBe(expected.component as string);
      expect(doc.bundle).toBe(BUNDLE_ID);
      expect(doc.type).toBe(expected.type as string);
      expect(doc.conceptId).toBe(expected.conceptId as string);
      expect(doc.ref).toBe(expected.ref as string);
      expect(doc.name).toBe(expected.name as string);
      if (expected.description !== undefined) expect(doc.description).toBe(expected.description as string);
    });
  }

  test("the SINGULAR command/ dir alias preserves its on-disk conceptId (command/legacy)", () => {
    const doc = recognizeRel("command/legacy.md");
    expect(doc?.type).toBe("command");
    expect(doc?.conceptId).toBe("command/legacy");
  });
});

describe("opencode adapter — placement golden (writes normalize to plural)", () => {
  const byType = loadGolden("placement").byType as Record<string, { conceptId: string; assetPath: string }>;

  function relFromRoot(abs: string): string {
    return path.relative(FIXTURE_ROOT, abs).split(path.sep).join("/");
  }

  for (const [typeKey, expected] of Object.entries(byType)) {
    test(`placeNew(${typeKey}) → ${expected.assetPath}`, () => {
      const abs = opencodeAdapter.placeNew?.(component(), expected.conceptId);
      expect(relFromRoot(abs as string)).toBe(expected.assetPath);
    });
  }

  test("a singular command/ conceptId still WRITES to the canonical plural commands/", () => {
    const abs = opencodeAdapter.placeNew?.(component(), "command/legacy");
    expect(relFromRoot(abs as string)).toBe("commands/legacy.md");
  });
});

describe("opencode adapter — renderer golden", () => {
  const byRelPath = loadGolden("renderer").byRelPath as Record<string, Record<string, unknown>>;

  for (const [relPath, expected] of Object.entries(byRelPath)) {
    test(`presentationFor(${relPath})`, () => {
      const doc = recognizeRel(relPath);
      expect(doc, `${relPath} must be recognized`).not.toBeNull();
      if (!doc) throw new Error("unreachable");
      expect(doc.type).toBe(expected.type as string);
      expect(doc.ref).toBe(expected.ref as string);
      const p = presentationFor(doc.type);
      expect(p.label).toBe(expected.label as string);
      expect(p.renderer ?? null).toBe((expected.renderer as string | null) ?? null);
      const action = p.action ? p.action(doc.ref ?? "") : `akm show ${doc.ref}`;
      expect(action).toBe(expected.action as string);
    });
  }
});

describe("opencode adapter — lint golden (lenient tool-dir validation)", () => {
  const perType = loadGolden("lint").perType as Record<string, { relPath: string; issues: Diagnostic[] }>;

  test("every recognized fixture file validates to exactly the golden's issue codes", async () => {
    // Include the singular-dir alias too — both dir forms are conformant → [].
    const relPaths = [...Object.values(perType).map((e) => e.relPath), "command/legacy.md"];
    const changes: FileChange[] = relPaths.map((rel) => ({
      path: rel,
      op: "update" as const,
      after: fs.readFileSync(path.join(FIXTURE_ROOT, rel), "utf8"),
    }));
    const diags = await opencodeAdapter.validate(component(), changes, ctx);
    const byFile = new Map<string, string[]>();
    for (const d of diags) byFile.set(d.file, [...(byFile.get(d.file) ?? []), d.issue]);
    for (const entry of Object.values(perType)) {
      expect(byFile.get(entry.relPath) ?? [], entry.relPath).toEqual((entry.issues ?? []).map((i) => i.issue));
    }
    expect(byFile.get("command/legacy.md") ?? []).toEqual([]);
  });
});
