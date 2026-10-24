// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Conformance gate for the `agent-skills` adapter (#46).
 *
 * Drives the adapter over `tests/fixtures/bundles/agent-skills/` and asserts the
 * four authored goldens under `tests/fixtures/format-family-goldens/agent-skills/`.
 * Exercises RECOGNITION ≠ VALIDATION: the two invalid skills still recognize;
 * their §4.5 violations surface only in `validate`.
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { agentSkillsAdapter } from "../../../src/core/adapter/adapters/agent-skills-adapter";
import type { BundleComponent, Diagnostic, IndexDocument, ValidateContext } from "../../../src/core/adapter/types";
import type { FileChange } from "../../../src/core/file-change";
import { presentationFor } from "../../../src/core/type-presentation";
import { buildFileContext } from "../../../src/indexer/walk/file-context";

const FIXTURE_ROOT = path.join(import.meta.dir, "../../fixtures/bundles/agent-skills");
const GOLDENS_ROOT = path.join(import.meta.dir, "../../fixtures/format-family-goldens/agent-skills");
const BUNDLE_ID = "sample-agent-skills";

function loadGolden(name: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(GOLDENS_ROOT, `${name}.json`), "utf8"));
}

function component(): BundleComponent {
  return { id: BUNDLE_ID, adapter: "agent-skills", root: FIXTURE_ROOT, writable: true };
}

function recognizeRel(relPath: string): IndexDocument | null {
  return agentSkillsAdapter.recognize(component(), buildFileContext(FIXTURE_ROOT, path.join(FIXTURE_ROOT, relPath)));
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

describe("agent-skills adapter — metadata", () => {
  test("id / version", () => {
    expect(agentSkillsAdapter.id).toBe("agent-skills");
    expect(agentSkillsAdapter.version).toBe("0.9.0");
  });
});

describe("agent-skills adapter — recognition golden (recognition ≠ validation)", () => {
  const byRelPath = loadGolden("recognition").byRelPath as Record<string, Record<string, unknown>>;

  for (const [relPath, expected] of Object.entries(byRelPath)) {
    test(`recognize(${relPath})`, () => {
      const doc = recognizeRel(relPath);
      if (expected.recognized === false) {
        expect(doc, `${relPath} must abstain (bundled resource)`).toBeNull();
        return;
      }
      expect(doc, `${relPath} must be recognized`).not.toBeNull();
      if (!doc) throw new Error("unreachable");
      expect(doc.adapterId).toBe(expected.adapterId as string);
      expect(doc.component).toBe(expected.component as string);
      expect(doc.type).toBe(expected.type as string);
      expect(doc.conceptId).toBe(expected.conceptId as string);
      expect(doc.ref).toBe(expected.ref as string);
      expect(doc.name).toBe(expected.name as string);
      if (expected.description !== undefined) expect(doc.description).toBe(expected.description as string);
    });
  }
});

describe("agent-skills adapter — placement golden", () => {
  const byType = loadGolden("placement").byType as Record<string, { conceptId: string; assetPath: string }>;

  function relFromRoot(abs: string): string {
    return path.relative(FIXTURE_ROOT, abs).split(path.sep).join("/");
  }

  for (const [typeKey, expected] of Object.entries(byType)) {
    test(`placeNew(${typeKey}) → ${expected.assetPath}`, () => {
      const abs = agentSkillsAdapter.placeNew?.(component(), expected.conceptId);
      expect(relFromRoot(abs as string)).toBe(expected.assetPath);
    });
  }
});

describe("agent-skills adapter — renderer golden (renders regardless of validity)", () => {
  const byRelPath = loadGolden("renderer").byRelPath as Record<string, Record<string, unknown>>;

  for (const [relPath, expected] of Object.entries(byRelPath)) {
    test(`presentationFor(${relPath})`, () => {
      const doc = recognizeRel(relPath);
      expect(doc, `${relPath} must be recognized`).not.toBeNull();
      if (!doc) throw new Error("unreachable");
      expect(doc.type).toBe(expected.type as string);
      const p = presentationFor(doc.type);
      expect(p.label).toBe(expected.label as string);
      expect(p.renderer ?? null).toBe((expected.renderer as string | null) ?? null);
      const action = p.action ? p.action(doc.ref ?? "") : `akm show ${doc.ref}`;
      expect(action).toBe(expected.action as string);
    });
  }
});

describe("agent-skills adapter — lint golden (Agent Skills §4.5 hard rules)", () => {
  const perType = loadGolden("lint").perType as Record<string, { relPath: string; issues: Diagnostic[] }>;

  test("each SKILL.md validates to exactly the golden's issue codes", async () => {
    const changes: FileChange[] = Object.values(perType).map((e) => ({
      path: e.relPath,
      op: "update" as const,
      after: fs.readFileSync(path.join(FIXTURE_ROOT, e.relPath), "utf8"),
    }));
    const diags = await agentSkillsAdapter.validate(component(), changes, ctx);
    const byFile = new Map<string, string[]>();
    for (const d of diags) byFile.set(d.file, [...(byFile.get(d.file) ?? []), d.issue]);
    for (const entry of Object.values(perType)) {
      expect(byFile.get(entry.relPath) ?? [], entry.relPath).toEqual((entry.issues ?? []).map((i) => i.issue));
    }
  });

  test("the bad-name skill fires skill-name-invalid; the over-long one fires skill-description-too-long", async () => {
    const mk = (rel: string): FileChange => ({
      path: rel,
      op: "update",
      after: fs.readFileSync(path.join(FIXTURE_ROOT, rel), "utf8"),
    });
    const bad = await agentSkillsAdapter.validate(component(), [mk("Data_Analysis/SKILL.md")], ctx);
    expect(bad.map((d) => d.issue)).toEqual(["skill-name-invalid"]);
    const overlong = await agentSkillsAdapter.validate(component(), [mk("overlong-summary/SKILL.md")], ctx);
    expect(overlong.map((d) => d.issue)).toEqual(["skill-description-too-long"]);
    const clean = await agentSkillsAdapter.validate(component(), [mk("pdf-processing/SKILL.md")], ctx);
    expect(clean).toEqual([]);
  });
});
