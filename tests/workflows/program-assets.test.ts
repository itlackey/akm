// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * YAML workflow programs as first-class workflow assets (redesign addendum,
 * R1): ref resolution (`workflow:<name>` → workflows/<name>.yaml|.yml, .md
 * first for back-compat), the runtime asset loader projection, `workflow
 * validate` over programs (parse + compile errors with lines), the
 * `workflow-program-yaml` show renderer with orchestration summaries, and the
 * indexer matcher (sandboxed stash, following indexer-rejection.test.ts).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { isRelevantAssetFile, resolveAssetPathFromName } from "../../src/core/asset/asset-spec";
import { akmIndex } from "../../src/indexer/indexer";
import { buildFileContext, buildRenderContext } from "../../src/indexer/walk/file-context";
import { workflowProgramMatcher } from "../../src/indexer/walk/matchers";
import { resolveAssetPath } from "../../src/sources/resolve";
import {
  formatWorkflowErrors,
  getWorkflowProgramTemplate,
  validateWorkflowProgramSource,
} from "../../src/workflows/authoring/authoring";
import { compileWorkflowProgram } from "../../src/workflows/ir/compile";
import { parseWorkflowProgram } from "../../src/workflows/program/parser";
import { WORKFLOW_PROGRAM_RENDERER_NAME } from "../../src/workflows/program/project";
import { workflowProgramRenderer } from "../../src/workflows/renderer";
import { loadWorkflowAsset } from "../../src/workflows/runtime/workflow-asset-loader";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../_helpers/sandbox";

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
});

afterEach(() => storage.cleanup());

// The addendum's v1 sketch, completed with the three route-target steps the
// sketch references (route targets must exist and come after the router).
const ADDENDUM_EXAMPLE = `version: 1
name: review-changes
description: Review changed files and route the outcome
params:
  changed_files: { type: array, items: { type: string } }
defaults:
  runner: sdk
  model: balanced
  timeout: 10m
  on_error: fail

steps:
  - id: discover
    title: Discover targets
    unit:
      instructions: |
        List the files that need review for \${{ params.changed_files }}.
      output:
        type: object
        properties: { files: { type: array, items: { type: string } } }
        required: [files]
    gate:
      criteria: [every target is listed]

  - id: review
    title: Review files
    map:
      over: \${{ steps.discover.output.files }}
      concurrency: 8
      reducer: collect
      unit:
        runner: agent
        profile: reviewer
        model: deep
        timeout: 5m
        retry: { max: 1, on: [timeout, llm_rate_limit] }
        on_error: continue
        instructions: |
          Review \${{ item }} for correctness bugs.
        output: { type: object, properties: { file: { type: string }, verdict: { type: string } }, required: [file, verdict] }
    output:
      type: object
      properties: { verdict: { type: string } }
    gate:
      criteria: [every changed file has a verdict]
      max_loops: 2

  - id: triage
    route:
      input: \${{ steps.review.output.verdict }}
      when: { pass: ship, fail: rework }
      default: manual-triage

  - id: ship
    unit:
      instructions: Ship it.
  - id: rework
    unit:
      instructions: Rework the findings.
  - id: manual-triage
    unit:
      instructions: Triage manually.
`;

const MINIMAL_PROGRAM = `version: 1
name: minimal
steps:
  - id: only
    unit:
      instructions: Do the only thing.
`;

const MARKDOWN_WORKFLOW = `# Workflow: Same Name

## Step: Only
Step ID: only

### Instructions
Do the markdown thing.
`;

function writeStashFile(relPath: string, content: string): string {
  const file = path.join(storage.stashDir, relPath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
  return file;
}

// ── 1. Ref resolution ────────────────────────────────────────────────────────

describe("workflow ref resolution over .yaml/.yml", () => {
  test("workflow:<name> resolves to workflows/<name>.yaml", async () => {
    const file = writeStashFile("workflows/prog.yaml", MINIMAL_PROGRAM);
    const resolved = await resolveAssetPath(storage.stashDir, "workflow", "prog");
    expect(fs.realpathSync(resolved)).toBe(fs.realpathSync(file));
  });

  test("workflow:<name> resolves to workflows/<name>.yml", async () => {
    const file = writeStashFile("workflows/prog-yml.yml", MINIMAL_PROGRAM);
    const resolved = await resolveAssetPath(storage.stashDir, "workflow", "prog-yml");
    expect(fs.realpathSync(resolved)).toBe(fs.realpathSync(file));
  });

  test(".md wins over .yaml for the same name (back-compat priority)", async () => {
    writeStashFile("workflows/dual.yaml", MINIMAL_PROGRAM);
    const md = writeStashFile("workflows/dual.md", MARKDOWN_WORKFLOW);
    const resolved = await resolveAssetPath(storage.stashDir, "workflow", "dual");
    expect(fs.realpathSync(resolved)).toBe(fs.realpathSync(md));
  });

  test("asset-spec treats .yaml/.yml as relevant workflow files and probes paths", () => {
    expect(isRelevantAssetFile("workflow", "release.yaml")).toBe(true);
    expect(isRelevantAssetFile("workflow", "release.yml")).toBe(true);
    expect(isRelevantAssetFile("workflow", "release.md")).toBe(true);
    expect(isRelevantAssetFile("workflow", "release.txt")).toBe(false);

    // No file on disk → still falls back to the canonical markdown path.
    const root = path.join(storage.stashDir, "workflows");
    expect(resolveAssetPathFromName("workflow", root, "missing")).toBe(path.join(root, "missing.md"));
    // Explicit extension is honored verbatim.
    expect(resolveAssetPathFromName("workflow", root, "x.yaml")).toBe(path.join(root, "x.yaml"));
  });
});

// ── 2. Loader projection + run start ─────────────────────────────────────────

describe("loadWorkflowAsset over YAML programs", () => {
  test("projects program steps (raw templates, sequence indexes) and keeps the program", async () => {
    writeStashFile("workflows/review-changes.yaml", ADDENDUM_EXAMPLE);
    const asset = await loadWorkflowAsset("workflow:review-changes");

    expect(asset.title).toBe("review-changes");
    expect(asset.program).toBeDefined();
    expect(asset.document).toBeUndefined();
    expect(asset.path.endsWith("review-changes.yaml")).toBe(true);

    expect(asset.steps.map((s) => s.id)).toEqual(["discover", "review", "triage", "ship", "rework", "manual-triage"]);
    expect(asset.steps.map((s) => s.sequenceIndex)).toEqual([0, 1, 2, 3, 4, 5]);

    const discover = asset.steps[0];
    expect(discover?.title).toBe("Discover targets");
    // Raw template — NOT resolved or re-scanned.
    expect(discover?.instructions).toContain("${{ params.changed_files }}");

    const review = asset.steps[1];
    expect(review?.instructions).toContain("${{ item }}");

    // Route steps have no unit; the projection stands in a routing description.
    const triage = asset.steps[2];
    expect(triage?.instructions).toContain("${{ steps.review.output.verdict }}");

    expect(asset.parameters).toEqual([{ name: "changed_files" }]);
  });

  test("startWorkflowRun freezes the compiled program plan", async () => {
    writeStashFile("workflows/review-changes.yaml", ADDENDUM_EXAMPLE);
    const { startWorkflowRun } = await import("../../src/workflows/runtime/runs");
    const { withWorkflowRunsRepo } = await import("../../src/storage/repositories/workflow-runs-repository");

    const started = await startWorkflowRun("workflow:review-changes", { changed_files: ["a.ts"] });
    expect(started.run.workflowTitle).toBe("review-changes");

    const row = await withWorkflowRunsRepo((repo) => repo.getRunById(started.run.id));
    expect(row?.plan_json).toBeTruthy();
    const plan = JSON.parse(row?.plan_json ?? "{}");
    expect(plan.title).toBe("review-changes");
    const review = plan.steps.find((s: { stepId: string }) => s.stepId === "review");
    expect(review?.root?.kind).toBe("map");
    expect(review?.root?.over).toBe("${{ steps.discover.output.files }}");
  });

  test("gate criteria project into completionCriteria, persist on step rows, and arm the completion gate (peer review)", async () => {
    writeStashFile("workflows/review-changes.yaml", ADDENDUM_EXAMPLE);
    const asset = await loadWorkflowAsset("workflow:review-changes");

    // The projection carries the gate criteria (previously dropped → the
    // summary-validation gate silently failed open for every YAML program).
    const byId = new Map(asset.steps.map((s) => [s.id, s]));
    expect(byId.get("discover")?.completionCriteria).toEqual(["every target is listed"]);
    expect(byId.get("review")?.completionCriteria).toEqual(["every changed file has a verdict"]);
    // Steps without a gate stay criteria-less (fail-open there is intentional).
    expect(byId.get("ship")?.completionCriteria).toBeUndefined();

    // Criteria land in the run's step rows (completion_json)…
    const { startWorkflowRun, completeWorkflowStep } = await import("../../src/workflows/runtime/runs");
    const started = await startWorkflowRun("workflow:review-changes", { changed_files: ["a.ts"] });
    const discover = started.workflow.steps.find((s) => s.id === "discover");
    expect(discover?.completionCriteria).toEqual(["every target is listed"]);

    // … so completeWorkflowStep actually judges the summary against them: a
    // rejecting judge now BLOCKS completion instead of never being consulted.
    const judged: string[] = [];
    const verdict = await completeWorkflowStep({
      runId: started.run.id,
      stepId: "discover",
      status: "completed",
      summary: "Did something vague.",
      summaryJudge: async ({ user }) => {
        judged.push(user);
        return JSON.stringify({ complete: false, missing: ["every target is listed"], feedback: "List the targets." });
      },
    });
    expect(judged).toHaveLength(1);
    expect(judged[0]).toContain("every target is listed");
    expect("ok" in verdict && verdict.ok === false).toBe(true);
  });

  test("a broken program fails the load with line-anchored errors", async () => {
    writeStashFile("workflows/broken.yaml", "version: 1\nname: broken\nsteps:\n  - id: a\n");
    await expect(loadWorkflowAsset("workflow:broken")).rejects.toThrow(/exactly one of "unit", "map", or "route"/);
  });
});

// ── 3. workflow validate over programs ───────────────────────────────────────

describe("validateWorkflowProgramSource", () => {
  test("accepts the addendum example (parse + compile green)", () => {
    const file = writeStashFile("workflows/review-changes.yaml", ADDENDUM_EXAMPLE);
    const { result } = validateWorkflowProgramSource(file);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.program.name).toBe("review-changes");
      expect(result.program.steps).toHaveLength(6);
    }
  });

  test("surfaces parse errors with line numbers", () => {
    const file = writeStashFile(
      "workflows/dup.yaml",
      `version: 1\nname: dup\nsteps:\n  - id: a\n    unit: { instructions: x }\n  - id: a\n    unit: { instructions: y }\n`,
    );
    const { result } = validateWorkflowProgramSource(file);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const dup = result.errors.find((e) => e.message.includes(`Duplicate step id "a"`));
      expect(dup).toBeDefined();
      expect(dup?.line).toBe(6);
      expect(formatWorkflowErrors(file, result.errors)).toContain(`${file}:6`);
    }
  });

  test("surfaces compile (expression/reference) errors with line numbers", () => {
    const file = writeStashFile(
      "workflows/bad-ref.yaml",
      [
        "version: 1",
        "name: bad-ref",
        "steps:",
        "  - id: fan",
        "    map:",
        "      over: ${{ steps.nope.output.files }}",
        "      unit:",
        "        instructions: Review ${{ item }}.",
      ].join("\n"),
    );
    const { result } = validateWorkflowProgramSource(file);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const bad = result.errors.find((e) => e.message.includes(`"nope" is not a step in this workflow`));
      expect(bad).toBeDefined();
      expect(bad?.line).toBeGreaterThan(0);
    }
  });
});

// ── 4. Show renderer + orchestration summary ─────────────────────────────────

describe("workflow-program-yaml renderer", () => {
  function renderShow(file: string) {
    // The show/metadata pipeline roots the FileContext at the type dir
    // (see generateMetadata), so canonical names don't carry "workflows/".
    const ctx = buildRenderContext(
      buildFileContext(path.join(storage.stashDir, "workflows"), file),
      { type: "workflow", specificity: 19, renderer: WORKFLOW_PROGRAM_RENDERER_NAME },
      [storage.stashDir],
    );
    return workflowProgramRenderer.buildShowResponse(ctx);
  }

  test("buildShowResponse carries name/description/params/steps + orchestration summaries", () => {
    const file = writeStashFile("workflows/review-changes.yaml", ADDENDUM_EXAMPLE);
    const show = renderShow(file);

    expect(show.type).toBe("workflow");
    expect(show.name).toBe("review-changes");
    expect(show.workflowTitle).toBe("review-changes");
    expect(show.description).toBe("Review changed files and route the outcome");
    expect(show.parameters).toEqual(["changed_files"]);
    expect(show.workflowParameters).toEqual([{ name: "changed_files" }]);
    expect(show.action).toContain("akm workflow next");

    const steps = show.steps ?? [];
    expect(steps.map((s) => s.id)).toEqual(["discover", "review", "triage", "ship", "rework", "manual-triage"]);

    const discover = steps.find((s) => s.id === "discover");
    expect(discover?.completionCriteria).toEqual(["every target is listed"]);
    // Run-level defaults are merged, mirroring the compiler.
    expect(discover?.orchestration?.runner).toBe("sdk");
    expect(discover?.orchestration?.model).toBe("balanced");
    expect(discover?.orchestration?.timeoutMs).toBe(600_000);
    expect(discover?.orchestration?.hasSchema).toBe(true);

    const review = steps.find((s) => s.id === "review");
    expect(review?.orchestration?.fanOut).toEqual({
      over: "${{ steps.discover.output.files }}",
      concurrency: 8,
      reducer: "collect",
    });
    expect(review?.orchestration?.runner).toBe("agent");
    expect(review?.orchestration?.profile).toBe("reviewer");
    expect(review?.orchestration?.model).toBe("deep");
    expect(review?.orchestration?.timeoutMs).toBe(300_000);

    const triage = steps.find((s) => s.id === "triage");
    expect(triage?.orchestration?.route).toEqual({
      input: "${{ steps.review.output.verdict }}",
      branches: [
        { match: "pass", stepId: "ship" },
        { match: "fail", stepId: "rework" },
      ],
      defaultStepId: "manual-triage",
    });
  });
});

// ── 5. Indexer matcher ───────────────────────────────────────────────────────

describe("workflowProgramMatcher + indexing", () => {
  test("claims .yaml under workflows/ with the program renderer", () => {
    const file = writeStashFile("workflows/prog.yaml", MINIMAL_PROGRAM);
    const match = workflowProgramMatcher(buildFileContext(storage.stashDir, file));
    expect(match).toEqual({ type: "workflow", specificity: 15, renderer: WORKFLOW_PROGRAM_RENDERER_NAME });
  });

  test("claims a program-shaped .yaml outside workflows/ by content probe", () => {
    const file = writeStashFile("knowledge/loose-program.yaml", MINIMAL_PROGRAM);
    const match = workflowProgramMatcher(buildFileContext(storage.stashDir, file));
    expect(match?.type).toBe("workflow");
    expect(match?.specificity).toBe(19);
  });

  test("abstains from non-program yaml outside workflows/", () => {
    const file = writeStashFile("knowledge/settings.yaml", "kind: settings\nvalues:\n  a: 1\n");
    expect(workflowProgramMatcher(buildFileContext(storage.stashDir, file))).toBeNull();
  });

  test("akm index picks up a YAML program as a workflow entry", async () => {
    writeStashFile("workflows/prog.yaml", MINIMAL_PROGRAM);
    const result = await akmIndex({ stashDir: storage.stashDir, full: true });
    expect(result.totalEntries).toBe(1);

    const { openIndexDatabase, closeDatabase } = await import("../../src/indexer/db/db");
    const db = openIndexDatabase();
    try {
      const row = db
        .prepare(`SELECT entry_type, entry_json FROM entries WHERE entry_key = ?`)
        .get(`${storage.stashDir}:workflow:prog`) as { entry_type: string; entry_json: string } | undefined;
      expect(row).toBeDefined();
      expect(row?.entry_type).toBe("workflow");
      const entry = JSON.parse(row?.entry_json ?? "{}") as { name?: string; searchHints?: string[] };
      expect(entry.name).toBe("prog");
      // Search hints carry the program name, step ids/titles, instructions.
      const hints = entry.searchHints ?? [];
      expect(hints).toContain("minimal");
      expect(hints).toContain("only");
      expect(hints).toContain("Do the only thing.");
    } finally {
      closeDatabase(db);
    }
  });

  test("akm index skips a broken YAML program with a warning", async () => {
    const broken = writeStashFile("workflows/broken.yaml", "version: 1\nname: broken\nsteps: []\n");
    const originalWarn = console.warn.bind(console);
    console.warn = () => {};
    try {
      const result = await akmIndex({ stashDir: storage.stashDir, full: true });
      expect(result.totalEntries).toBe(0);
      const warning = (result.warnings ?? []).find((w) => w.includes(broken));
      expect(warning).toBeDefined();
      expect(warning).toContain("steps");
    } finally {
      console.warn = originalWarn;
    }
  });
});

// ── Template ─────────────────────────────────────────────────────────────────

describe("workflow template --yaml source", () => {
  test("the shipped program template parses AND compiles clean", () => {
    const template = getWorkflowProgramTemplate();
    const parsed = parseWorkflowProgram(template, { path: "workflows/example-workflow.yaml" });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.program.name).toBe("example-workflow");
    const compiled = compileWorkflowProgram(parsed.program);
    expect(compiled.ok).toBe(true);
  });
});
