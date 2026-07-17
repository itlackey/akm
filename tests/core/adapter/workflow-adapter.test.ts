// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * WI-2.2 — parity tests for the `workflow` `BundleAdapter`
 * (`src/core/adapter/adapters/workflow-adapter.ts`) against the Chunk 0b
 * goldens (`tests/fixtures/goldens/{recognition,placement,lint}/all-types.json`).
 * See `skill-adapter.test.ts`'s header for the shared byte-for-byte-parity
 * rationale. Covers BOTH forms (workflow-md + workflow-program-yaml) and the
 * renderer-identity wrinkle (`workflow-adapter.ts`'s header).
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { workflowAdapter } from "../../../src/core/adapter/adapters/workflow-adapter";
import type { BundleComponent } from "../../../src/core/adapter/types";
import { buildFileContext } from "../../../src/indexer/walk/file-context";
import { parseWorkflowProgram } from "../../../src/workflows/program/parser";
import { WORKFLOW_PROGRAM_RENDERER_NAME } from "../../../src/workflows/program/project";
import { makeFsValidateContext } from "./_helpers/validate-context";

const ALL_TYPES_ROOT = path.resolve(__dirname, "../../fixtures/stashes/all-types");
const WORKFLOWS_ROOT = path.join(ALL_TYPES_ROOT, "workflows");

const RECOGNITION_GOLDEN = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "../../fixtures/goldens/recognition/all-types.json"), "utf8"),
);
const PLACEMENT_GOLDEN = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "../../fixtures/goldens/placement/all-types.json"), "utf8"),
);
const LINT_GOLDEN = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "../../fixtures/goldens/lint/all-types.json"), "utf8"),
);

const WORKFLOW_MD_REL_PATH = "workflows/all-types-workflow.md";
const WORKFLOW_YAML_REL_PATH = "workflows/all-types-workflow-program.yaml";

function workflowsComponent(): BundleComponent {
  return { id: "workflows", adapter: "workflow", root: WORKFLOWS_ROOT, writable: true };
}

describe("workflow adapter — recognition parity vs recognition/all-types.json (both forms)", () => {
  test("recognizes workflows/all-types-workflow.md (Form A, md) as type workflow with rendererName workflow-md", () => {
    const component = workflowsComponent();
    const file = buildFileContext(WORKFLOWS_ROOT, path.join(ALL_TYPES_ROOT, WORKFLOW_MD_REL_PATH));
    const doc = workflowAdapter.recognize(component, file);
    expect(doc).not.toBeNull();
    expect(doc?.type).toBe(RECOGNITION_GOLDEN.byRelPath[WORKFLOW_MD_REL_PATH].type);
    expect(doc?.adapterId).toBe("workflow");
    expect(doc?.conceptId).toBe("all-types-workflow");
    // The renderer wrinkle: this form's identity must be named byte-for-byte
    // against the golden's `renderer` field via the new per-document field.
    expect(doc?.rendererName).toBe(RECOGNITION_GOLDEN.byRelPath[WORKFLOW_MD_REL_PATH].renderer);
    expect(doc?.rendererName).toBe("workflow-md");
  });

  test("recognizes workflows/all-types-workflow-program.yaml (Form B, program) as type workflow with rendererName workflow-program-yaml", () => {
    const component = workflowsComponent();
    const file = buildFileContext(WORKFLOWS_ROOT, path.join(ALL_TYPES_ROOT, WORKFLOW_YAML_REL_PATH));
    const doc = workflowAdapter.recognize(component, file);
    expect(doc).not.toBeNull();
    expect(doc?.type).toBe(RECOGNITION_GOLDEN.byRelPath[WORKFLOW_YAML_REL_PATH].type);
    expect(doc?.adapterId).toBe("workflow");
    expect(doc?.conceptId).toBe("all-types-workflow-program");
    // The renderer wrinkle, program side: never silently dropped.
    expect(doc?.rendererName).toBe(RECOGNITION_GOLDEN.byRelPath[WORKFLOW_YAML_REL_PATH].renderer);
    expect(doc?.rendererName).toBe(WORKFLOW_PROGRAM_RENDERER_NAME);
    expect(doc?.rendererName).toBe("workflow-program-yaml");
  });

  // NOTE on methodology, mirroring wiki-adapter.test.ts's identical note: no
  // broad "abstains on every OTHER all-types fixture file" cross-type test
  // exists here (unlike skill-adapter.test.ts / script-adapter.test.ts).
  // Form B's recognition (see workflow-adapter.ts's header) is POSITIONAL —
  // extension-only, no directory-name check — exactly like wiki's positional
  // recognition, because under D2-8 the component root already scopes which
  // files this adapter is ever handed in production. Building FileContext
  // objects rooted at ALL_TYPES_ROOT (not WORKFLOWS_ROOT) and feeding them to
  // a component whose root IS WORKFLOWS_ROOT is an ill-formed scenario the
  // real system never produces (e.g. tasks/all-types-task.yml's `.yml`
  // extension would spuriously "match" Form B, exactly as a foreign
  // one-level-nested file would spuriously match wiki's positional check) —
  // isolation is enforced by MOUNTING, not recognize(), per D2-8. Form A's
  // negative case (a non-workflow-shaped .md correctly rooted under a
  // workflows/ directory) IS safely testable and covered above.

  test('a plain-prose .md under the workflows root IS claimed as type workflow (positional dir-hint parity — matchers.ts:62-66 ext===".md" only, no content gate)', () => {
    // Separate, dedicated fixture (NOT all-types/ — that fixture is
    // sha256-pinned and must not gain a new file): a plain-prose .md sitting
    // under a workflows/ directory that does NOT have `# Workflow:` /
    // `## Step:` structure. The legacy `workflows` dir-hint rule
    // (matchDirectoryHint's DIR_TYPE_MAP "workflows" entry, `ext === ".md"`
    // only, no body probe) classifies EVERY non-README .md under workflows/
    // as type `workflow`; this adapter reproduces that positional floor (it
    // does NOT gate recognize() on looksLikeWorkflow — see the file header
    // "WHY positional, not content-gated"). Whether such a file is a VALID
    // workflow is validate()'s job (invalid-workflow-structure), not
    // recognize()'s.
    const nonWorkflowRoot = path.resolve(__dirname, "../../fixtures/stashes/workflow-non-workflow-md/workflows");
    const component: BundleComponent = { id: "workflows", adapter: "workflow", root: nonWorkflowRoot, writable: true };
    const file = buildFileContext(nonWorkflowRoot, path.join(nonWorkflowRoot, "notes.md"));
    const doc = workflowAdapter.recognize(component, file);
    expect(doc).not.toBeNull();
    expect(doc?.type).toBe("workflow");
    expect(doc?.rendererName).toBe("workflow-md");
  });
});

describe("workflow adapter — placement parity vs placement/all-types.json (the one disk-probing spec)", () => {
  function workflowsRootComponent(): BundleComponent {
    return { id: "workflows", adapter: "workflow", root: path.join(ALL_TYPES_ROOT, "workflows"), writable: true };
  }

  test("placeNew reproduces the workflowSpec placement for the .md fixture", () => {
    const golden = PLACEMENT_GOLDEN.byType.workflow;
    expect(golden.stashDir).toBe("workflows");
    const component = workflowsRootComponent();
    const result = workflowAdapter.placeNew?.(component, golden.name);
    expect(result).toBeDefined();
    const relResult = path
      .relative(ALL_TYPES_ROOT, result as string)
      .split(path.sep)
      .join("/");
    expect(relResult).toBe(golden.assetPath);
  });

  test("explicit extension skips the existsSync probe entirely (edgeCases.workflowExplicitExtensionSkipsProbe)", () => {
    const golden = PLACEMENT_GOLDEN.edgeCases.workflowExplicitExtensionSkipsProbe;
    const component = workflowsRootComponent();
    const result = workflowAdapter.placeNew?.(component, golden.name);
    const relResult = path
      .relative(ALL_TYPES_ROOT, result as string)
      .split(path.sep)
      .join("/");
    expect(relResult).toBe(golden.assetPath);
  });

  test("probe falls back to .md when no candidate exists on disk (edgeCases.workflowProbeFallbackToMdWhenNoCandidateExists)", () => {
    const golden = PLACEMENT_GOLDEN.edgeCases.workflowProbeFallbackToMdWhenNoCandidateExists;
    const component = workflowsRootComponent();
    const result = workflowAdapter.placeNew?.(component, golden.name);
    const relResult = path
      .relative(ALL_TYPES_ROOT, result as string)
      .split(path.sep)
      .join("/");
    expect(relResult).toBe(golden.assetPath);
  });

  test("probe finds the .yaml-only candidate before defaulting to .md (edgeCases.workflowProbeFindsYamlOnlyCandidateBeforeDefaultingToMd)", () => {
    const golden = PLACEMENT_GOLDEN.edgeCases.workflowProbeFindsYamlOnlyCandidateBeforeDefaultingToMd;
    const component = workflowsRootComponent();
    const result = workflowAdapter.placeNew?.(component, golden.name);
    const relResult = path
      .relative(ALL_TYPES_ROOT, result as string)
      .split(path.sep)
      .join("/");
    expect(relResult).toBe(golden.assetPath);
  });
});

describe("workflow adapter — validate() parity vs lint/all-types.json perType.workflowMd (Form A only)", () => {
  test("validate() returns [] for the lint-clean fixture workflow.md (matches perType.workflowMd.issues, linterUsed: WorkflowLinter)", async () => {
    const golden = LINT_GOLDEN.perType.workflowMd;
    expect(golden.issues).toEqual([]);
    expect(golden.linterUsed).toBe("WorkflowLinter");

    const component = workflowsComponent();
    const raw = fs.readFileSync(path.join(ALL_TYPES_ROOT, WORKFLOW_MD_REL_PATH), "utf8");
    const ctx = makeFsValidateContext(WORKFLOWS_ROOT);
    const diagnostics = await workflowAdapter.validate(
      component,
      [{ path: "all-types-workflow.md", op: "update", after: raw }],
      ctx,
    );
    expect(diagnostics).toEqual([]);
  });

  test("validate() flags placeholder-stub as a read-only diagnostic (never deletes — D2-3/bundle-adapter MUST-NOT-write)", async () => {
    const component = workflowsComponent();
    const ctx = makeFsValidateContext(WORKFLOWS_ROOT);
    const stub = [
      "---",
      "description: stub",
      "updated: 2025-06-01",
      "---",
      "# Workflow: Stub",
      "",
      "## Step: Announce",
      "Step ID: announce",
      "",
      "### Instructions",
      "Describe what this workflow accomplishes.",
      "",
    ].join("\n");
    const diagnostics = await workflowAdapter.validate(
      component,
      [{ path: "stub.md", op: "create", after: stub }],
      ctx,
    );
    expect(diagnostics).toEqual([
      {
        file: "stub.md",
        issue: "placeholder-stub",
        detail: 'placeholder text: "Describe what this workflow accomplishes"',
        fixed: false,
      },
    ]);
  });

  test("validate() flags invalid-workflow-structure via parseWorkflow for a malformed workflow body", async () => {
    const component = workflowsComponent();
    const ctx = makeFsValidateContext(WORKFLOWS_ROOT);
    const malformed = "# Not a workflow heading\n\nJust prose.\n";
    const diagnostics = await workflowAdapter.validate(
      component,
      [{ path: "broken.md", op: "create", after: malformed }],
      ctx,
    );
    expect(diagnostics.length).toBeGreaterThan(0);
    for (const d of diagnostics) {
      expect(d.issue).toBe("invalid-workflow-structure");
      expect(d.fixed).toBe(false);
    }
  });

  test("validate() produces NO diagnostics for a .yaml/.yml (Form B) change — no lint path in production (§C.3)", async () => {
    const component = workflowsComponent();
    const ctx = makeFsValidateContext(WORKFLOWS_ROOT);
    // Deliberately malformed YAML program content — if validate() ran ANY
    // check against it, this would produce diagnostics. It must not.
    const diagnostics = await workflowAdapter.validate(
      component,
      [{ path: "broken-program.yaml", op: "create", after: "not: [valid, workflow, program" }],
      ctx,
    );
    expect(diagnostics).toEqual([]);
  });
});

describe("workflow adapter — workflow-program-yaml's correctness check (parseWorkflowProgram, NOT a lint path)", () => {
  test("reproduces perType.workflowProgramYaml.result via a direct parseWorkflowProgram call (the golden's own capture mechanism)", () => {
    const golden = LINT_GOLDEN.perType.workflowProgramYaml;
    expect(golden.correctnessCheck).toBe("parseWorkflowProgram");
    const raw = fs.readFileSync(path.join(ALL_TYPES_ROOT, WORKFLOW_YAML_REL_PATH), "utf8");
    const result = parseWorkflowProgram(raw, { path: WORKFLOW_YAML_REL_PATH });
    expect(result).toEqual(golden.result);
  });
});
