// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Conformance gate for the `akm-task` adapter (#46).
 *
 * Drives the adapter over `tests/fixtures/bundles/akm-task/` and asserts the
 * four authored goldens under `tests/fixtures/format-family-goldens/akm-task/`.
 * The invalid task (two targets) is still RECOGNIZED; the `invalid-task-yaml`
 * violation surfaces only in `validate`.
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmTaskAdapter } from "../../../src/core/adapter/adapters/akm-task-adapter";
import type { BundleComponent, Diagnostic, IndexDocument, ValidateContext } from "../../../src/core/adapter/types";
import type { FileChange } from "../../../src/core/file-change";
import { presentationFor } from "../../../src/core/type-presentation";
import { buildFileContext } from "../../../src/indexer/walk/file-context";

const FIXTURE_ROOT = path.join(import.meta.dir, "../../fixtures/bundles/akm-task");
const GOLDENS_ROOT = path.join(import.meta.dir, "../../fixtures/format-family-goldens/akm-task");
const BUNDLE_ID = "sample-akm-task";

function loadGolden(name: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(GOLDENS_ROOT, `${name}.json`), "utf8"));
}

function component(): BundleComponent {
  return { id: BUNDLE_ID, adapter: "akm-task", root: FIXTURE_ROOT, writable: true };
}

function recognizeRel(relPath: string): IndexDocument | null {
  return akmTaskAdapter.recognize(component(), buildFileContext(FIXTURE_ROOT, path.join(FIXTURE_ROOT, relPath)));
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

describe("akm-task adapter — metadata", () => {
  test("id / version / extensions", () => {
    expect(akmTaskAdapter.id).toBe("akm-task");
    expect(akmTaskAdapter.version).toBe("0.9.0");
    expect(akmTaskAdapter.extensions).toEqual([".yml"]);
  });

  test("a README markdown abstains (tasks are YAML)", () => {
    expect(recognizeRel("README.md")).toBeNull();
  });
});

describe("akm-task adapter — recognition golden (recognition ≠ validation)", () => {
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

describe("akm-task adapter — placement golden", () => {
  const golden = loadGolden("placement");
  const byType = golden.byType as Record<string, { conceptId: string; assetPath: string }>;
  const edge = golden.edgeCases as Record<string, { conceptId: string; assetPath: string }>;

  function relFromRoot(abs: string): string {
    return path.relative(FIXTURE_ROOT, abs).split(path.sep).join("/");
  }

  for (const [typeKey, expected] of Object.entries(byType)) {
    test(`placeNew(${typeKey}) → ${expected.assetPath}`, () => {
      const abs = akmTaskAdapter.placeNew?.(component(), expected.conceptId);
      expect(relFromRoot(abs as string)).toBe(expected.assetPath);
    });
  }

  for (const [name, expected] of Object.entries(edge)) {
    test(`edge: ${name} → ${expected.assetPath}`, () => {
      const abs = akmTaskAdapter.placeNew?.(component(), expected.conceptId);
      expect(relFromRoot(abs as string)).toBe(expected.assetPath);
    });
  }
});

describe("akm-task adapter — renderer golden", () => {
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

describe("akm-task adapter — lint golden (invalid-task-yaml: exactly one target)", () => {
  const perType = loadGolden("lint").perType as Record<string, { relPath: string; issues: Diagnostic[] }>;

  test("each task validates to exactly the golden's issue codes", async () => {
    const changes: FileChange[] = Object.values(perType).map((e) => ({
      path: e.relPath,
      op: "update" as const,
      after: fs.readFileSync(path.join(FIXTURE_ROOT, e.relPath), "utf8"),
    }));
    const diags = await akmTaskAdapter.validate(component(), changes, ctx);
    const byFile = new Map<string, string[]>();
    for (const d of diags) byFile.set(d.file, [...(byFile.get(d.file) ?? []), d.issue]);
    for (const entry of Object.values(perType)) {
      expect(byFile.get(entry.relPath) ?? [], entry.relPath).toEqual((entry.issues ?? []).map((i) => i.issue));
    }
  });

  test("two-targets.yml is the sole invalid-task-yaml (both prompt AND command)", async () => {
    const raw = fs.readFileSync(path.join(FIXTURE_ROOT, "two-targets.yml"), "utf8");
    const diags = await akmTaskAdapter.validate(
      component(),
      [{ path: "two-targets.yml", op: "update", after: raw }],
      ctx,
    );
    expect(diags.map((d) => d.issue)).toEqual(["invalid-task-yaml"]);
  });
});
