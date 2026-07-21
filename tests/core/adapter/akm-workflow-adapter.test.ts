// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Conformance gate for the `akm-workflow` adapter (#46).
 *
 * Drives the adapter over `tests/fixtures/bundles/akm-workflow/` and asserts the
 * four authored goldens under `tests/fixtures/format-family-goldens/akm-workflow/`.
 * Both the markdown workflow and the YAML program derive `type: workflow`; the
 * lint golden's `workflowProgramYaml` correctness is `parseWorkflowProgram`'s own
 * result, exercised directly.
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmWorkflowAdapter } from "../../../src/core/adapter/adapters/akm-workflow-adapter";
import type { BundleComponent, Diagnostic, IndexDocument, ValidateContext } from "../../../src/core/adapter/types";
import type { FileChange } from "../../../src/core/file-change";
import { presentationFor } from "../../../src/core/type-presentation";
import { buildFileContext } from "../../../src/indexer/walk/file-context";
import { parseWorkflowProgram } from "../../../src/workflows/program/parser";

const FIXTURE_ROOT = path.join(import.meta.dir, "../../fixtures/bundles/akm-workflow");
const GOLDENS_ROOT = path.join(import.meta.dir, "../../fixtures/format-family-goldens/akm-workflow");
const BUNDLE_ID = "sample-akm-workflow";

function loadGolden(name: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(GOLDENS_ROOT, `${name}.json`), "utf8"));
}

function component(): BundleComponent {
  return { id: BUNDLE_ID, adapter: "akm-workflow", root: FIXTURE_ROOT, writable: true };
}

function recognizeRel(relPath: string): IndexDocument | null {
  return akmWorkflowAdapter.recognize(component(), buildFileContext(FIXTURE_ROOT, path.join(FIXTURE_ROOT, relPath)));
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

describe("akm-workflow adapter — metadata", () => {
  test("id / version / extensions", () => {
    expect(akmWorkflowAdapter.id).toBe("akm-workflow");
    expect(akmWorkflowAdapter.version).toBe("0.9.0");
    expect(akmWorkflowAdapter.extensions).toEqual([".md", ".yaml", ".yml"]);
  });

  test("a non-workflow markdown (README) abstains", () => {
    expect(recognizeRel("README.md")).toBeNull();
  });
});

describe("akm-workflow adapter — recognition golden", () => {
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
      if (expected.description !== undefined) expect(doc.description).toBe(expected.description as string);
    });
  }
});

describe("akm-workflow adapter — placement golden", () => {
  const golden = loadGolden("placement");
  const byType = golden.byType as Record<string, { conceptId: string; assetPath: string }>;
  const edge = golden.edgeCases as Record<string, { conceptId: string; assetPath: string }>;

  function relFromRoot(abs: string): string {
    return path.relative(FIXTURE_ROOT, abs).split(path.sep).join("/");
  }

  for (const [typeKey, expected] of Object.entries(byType)) {
    test(`placeNew(${typeKey}) → ${expected.assetPath}`, () => {
      const abs = akmWorkflowAdapter.placeNew?.(component(), expected.conceptId);
      expect(relFromRoot(abs as string)).toBe(expected.assetPath);
    });
  }

  for (const [name, expected] of Object.entries(edge)) {
    test(`edge: ${name} → ${expected.assetPath}`, () => {
      const abs = akmWorkflowAdapter.placeNew?.(component(), expected.conceptId);
      expect(relFromRoot(abs as string)).toBe(expected.assetPath);
    });
  }
});

describe("akm-workflow adapter — renderer golden (both forms are type=workflow)", () => {
  const byRelPath = loadGolden("renderer").byRelPath as Record<string, Record<string, unknown>>;

  for (const [relPath, expected] of Object.entries(byRelPath)) {
    test(`presentationFor(${relPath})`, () => {
      const doc = recognizeRel(relPath);
      expect(doc?.type).toBe(expected.type as string);
      const p = presentationFor(doc?.type ?? "");
      expect(p.label).toBe(expected.label as string);
      // TYPE_PRESENTATION keys `workflow` → renderer `workflow-md`; the YAML
      // program form additionally selects `workflow-program-yaml` (adapter-picked).
      expect(p.renderer).toBe("workflow-md");
      const action = p.action ? p.action(doc?.ref ?? "") : `akm show ${doc?.ref}`;
      expect(action).toBe(expected.action as string);
    });
  }
});

describe("akm-workflow adapter — lint golden", () => {
  const perType = loadGolden("lint").perType as Record<
    string,
    { relPath: string; issues?: Diagnostic[]; correctnessCheck?: string; result?: Record<string, unknown> }
  >;

  test("the markdown workflow validates clean ([])", async () => {
    const md = perType.workflowMd;
    const change: FileChange = {
      path: md.relPath,
      op: "update",
      after: fs.readFileSync(path.join(FIXTURE_ROOT, md.relPath), "utf8"),
    };
    const diags = await akmWorkflowAdapter.validate(component(), [change], ctx);
    expect(diags.map((d) => d.issue)).toEqual((md.issues ?? []).map((i) => i.issue));
  });

  test("the YAML program validates clean AND parseWorkflowProgram matches the golden shape", async () => {
    const yaml = perType.workflowProgramYaml;
    const raw = fs.readFileSync(path.join(FIXTURE_ROOT, yaml.relPath), "utf8");
    const diags = await akmWorkflowAdapter.validate(
      component(),
      [{ path: yaml.relPath, op: "update", after: raw }],
      ctx,
    );
    expect(diags).toEqual([]);

    // The workflowProgramYaml correctness surface (spec golden): parseWorkflowProgram.
    expect(yaml.correctnessCheck).toBe("parseWorkflowProgram");
    const parsed = parseWorkflowProgram(raw, { path: yaml.relPath });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("unreachable");
    const expectedProgram = yaml.result?.program as Record<string, unknown>;
    expect(parsed.program.version).toBe(expectedProgram.version as number);
    expect(parsed.program.name).toBe(expectedProgram.name as string);
    expect(parsed.program.description).toBe(expectedProgram.description as string);
    const expectedSteps = expectedProgram.steps as Array<{ id: string; unit: { instructions: string } }>;
    expect(parsed.program.steps.map((s) => ({ id: s.id, instructions: s.unit?.instructions }))).toEqual(
      expectedSteps.map((s) => ({ id: s.id, instructions: s.unit.instructions })),
    );
  });
});
