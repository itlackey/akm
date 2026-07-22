// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Conformance gate for the `claude` tool-directory adapter (#46).
 *
 * Drives the adapter over the authored SPECIFICATION fixture
 * `tests/fixtures/bundles/claude/` and asserts the four authored goldens under
 * `tests/fixtures/format-family-goldens/claude/`. The goldens are the oracle —
 * the adapter is built to match them. Descriptive golden annotations
 * (`derivation`, `reason`, `note`, `item`) are NOT asserted; only the fields
 * that map onto the adapter's output are.
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { claudeAdapter } from "../../../src/core/adapter/adapters/claude-adapter";
import type { BundleComponent, Diagnostic, IndexDocument, ValidateContext } from "../../../src/core/adapter/types";
import type { FileChange } from "../../../src/core/file-change";
import { presentationFor } from "../../../src/core/type-presentation";
import { buildFileContext } from "../../../src/indexer/walk/file-context";

const FIXTURE_ROOT = path.join(import.meta.dir, "../../fixtures/bundles/claude");
const GOLDENS_ROOT = path.join(import.meta.dir, "../../fixtures/format-family-goldens/claude");
/** The bundle id = the ref prefix the goldens pin (`sample-claude//...`). */
const BUNDLE_ID = "sample-claude";

function loadGolden(name: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(GOLDENS_ROOT, `${name}.json`), "utf8"));
}

function component(): BundleComponent {
  return { id: BUNDLE_ID, adapter: "claude", root: FIXTURE_ROOT, writable: true };
}

function recognizeRel(relPath: string): IndexDocument | null {
  return claudeAdapter.recognize(component(), buildFileContext(FIXTURE_ROOT, path.join(FIXTURE_ROOT, relPath)));
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

describe("claude adapter — metadata", () => {
  test("id / version / extensions", () => {
    expect(claudeAdapter.id).toBe("claude");
    expect(claudeAdapter.version).toBe("0.9.0");
    expect(claudeAdapter.extensions).toEqual([".md"]);
  });
});

describe("claude adapter — recognition golden", () => {
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
});

describe("claude adapter — placement golden", () => {
  const byType = loadGolden("placement").byType as Record<string, { conceptId: string; assetPath: string }>;

  function relFromRoot(abs: string): string {
    return path.relative(FIXTURE_ROOT, abs).split(path.sep).join("/");
  }

  for (const [typeKey, expected] of Object.entries(byType)) {
    test(`placeNew(${typeKey}) → ${expected.assetPath}`, () => {
      const abs = claudeAdapter.placeNew?.(component(), expected.conceptId);
      expect(abs).toBeDefined();
      expect(relFromRoot(abs as string)).toBe(expected.assetPath);
    });
  }

  test("skill dir-name round-trip edge case", () => {
    const edge = loadGolden("placement").edgeCases as Record<string, { conceptId: string; assetPath: string }>;
    const abs = claudeAdapter.placeNew?.(component(), edge.skillDirNameEqualsSkillName!.conceptId);
    expect(relFromRoot(abs as string)).toBe(edge.skillDirNameEqualsSkillName!.assetPath);
  });
});

describe("claude adapter — renderer golden (presentation keyed on the open type)", () => {
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

describe("claude adapter — lint golden (lenient tool-dir validation)", () => {
  const perType = loadGolden("lint").perType as Record<string, { relPath: string; issues: Diagnostic[] }>;

  test("every recognized fixture file validates to exactly the golden's issue codes", async () => {
    const changes: FileChange[] = Object.values(perType).map((e) => ({
      path: e.relPath,
      op: "update" as const,
      after: fs.readFileSync(path.join(FIXTURE_ROOT, e.relPath), "utf8"),
    }));
    const diags = await claudeAdapter.validate(component(), changes, ctx);
    const byFile = new Map<string, string[]>();
    for (const d of diags) byFile.set(d.file, [...(byFile.get(d.file) ?? []), d.issue]);
    for (const entry of Object.values(perType)) {
      expect(byFile.get(entry.relPath) ?? [], entry.relPath).toEqual((entry.issues ?? []).map((i) => i.issue));
    }
  });

  test("a skill directory with no SKILL.md emits missing-skill-md (the one coded skill check)", async () => {
    const emptyCtx: ValidateContext = { ...ctx, readFile: async () => null };
    const diags = await claudeAdapter.validate(
      component(),
      [{ path: "skills/csv-cleanup/reference.md", op: "update", after: "resource" }],
      emptyCtx,
    );
    expect(diags).toEqual([
      {
        file: "skills/csv-cleanup",
        issue: "missing-skill-md",
        detail: "no SKILL.md in skills/csv-cleanup/",
        fixed: false,
      },
    ]);
  });
});
