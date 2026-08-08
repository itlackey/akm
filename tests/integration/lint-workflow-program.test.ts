// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm lint --type workflows` structural coverage.
 *
 * Ported for workflow-format-unification: the YAML workflow *program*
 * (`.yaml`/`.yml`) this file originally covered is deleted as a distinct
 * on-disk format (spec §3). `akm commands/lint/index.ts` now collects only
 * `.md` files for the `workflows` subdir ("workflows, one markdown format
 * now, is .md") — a stray `.yaml`/`.yml` file under `workflows/` is not
 * scanned at all, so there is no lint-time equivalent of "a YAML program is
 * malformed" left to pin. Surviving coverage (clean workflow → no findings;
 * a structurally-broken workflow → a parse-stage finding; independence
 * across files in the same stash) is folded into unified-format markdown
 * fixtures below. The former compile-stage reference case is restored against
 * the unified markdown format. One case from the original file has no home
 * under the new format and is intentionally NOT re-created:
 *   - "a markdown workflow alongside a broken program: each is checked
 *     independently" — folded below as two markdown files (one clean, one
 *     broken) instead of markdown-vs-YAML, since YAML is no longer part of
 *     the surface at all.
 */

import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { akmLint } from "../../src/commands/lint/index";
import { formatLintPlain } from "../../src/output/text/lint-format";

const tempDirs: string[] = [];

function makeTempStash(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-lint-workflow-"));
  tempDirs.push(dir);
  return dir;
}

function writeWorkflowFile(stashDir: string, name: string, content: string): string {
  const workflowsDir = path.join(stashDir, "workflows");
  fs.mkdirSync(workflowsDir, { recursive: true });
  const filePath = path.join(workflowsDir, name);
  fs.writeFileSync(filePath, content, "utf8");
  return filePath;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const CLEAN_WORKFLOW = [
  "---",
  "type: workflow",
  "description: Clean workflow",
  "updated: 2026-07-30",
  "steps:",
  "  - id: only",
  "---",
  "",
  "## only",
  "",
  "Do it.",
  "",
].join("\n");

describe("akm lint --type workflows", () => {
  test("a well-formed unified workflow produces no findings", async () => {
    const stashDir = makeTempStash();
    writeWorkflowFile(stashDir, "clean.md", CLEAN_WORKFLOW);

    const result = await akmLint({ dir: stashDir, typeFilter: "workflows" });

    expect(result.flagged).toHaveLength(0);
  });

  test("README documentation in the workflows directory is not treated as a workflow asset", async () => {
    const stashDir = makeTempStash();
    writeWorkflowFile(stashDir, "README.md", "# Workflow documentation\n");

    const result = await akmLint({ dir: stashDir, typeFilter: "workflows" });

    expect(result.flagged).toHaveLength(0);
  });

  test("a workflow missing the required `steps` list is a parse-stage finding", async () => {
    const stashDir = makeTempStash();
    writeWorkflowFile(
      stashDir,
      "no-steps.md",
      ["---", "type: workflow", "description: No steps", "---", ""].join("\n"),
    );

    const result = await akmLint({ dir: stashDir, typeFilter: "workflows" });

    const structural = result.flagged.filter((i) => i.issue === "invalid-workflow-structure");
    expect(structural).toHaveLength(1);
    expect(structural[0]!.file).toContain("no-steps.md");
    expect(structural[0]!.detail).toContain('"steps" is required');
  });

  test("a reference to a missing step is a compile-stage finding", async () => {
    const stashDir = makeTempStash();
    writeWorkflowFile(
      stashDir,
      "missing-step.md",
      [
        "---",
        "type: workflow",
        "updated: 2026-07-30",
        "steps:",
        "  - id: consume",
        "    inputs: [steps.ghost.output]",
        "---",
        "",
        "## consume",
        "",
        "Use it.",
        "",
      ].join("\n"),
    );

    const result = await akmLint({ dir: stashDir, typeFilter: "workflows" });

    const structural = result.flagged.filter((i) => i.issue === "invalid-workflow-structure");
    expect(structural).toHaveLength(1);
    expect(structural[0]?.detail).toContain('"ghost" is not a step in this workflow');
  });

  test("a reference to a later step is a compile-stage finding", async () => {
    const stashDir = makeTempStash();
    writeWorkflowFile(
      stashDir,
      "later-step.md",
      [
        "---",
        "type: workflow",
        "updated: 2026-07-30",
        "steps:",
        "  - id: first",
        "    inputs: [steps.second.output]",
        "  - id: second",
        "---",
        "",
        "## first",
        "",
        "Use it.",
        "",
        "## second",
        "",
        "Produce it.",
        "",
      ].join("\n"),
    );

    const result = await akmLint({ dir: stashDir, typeFilter: "workflows" });

    const structural = result.flagged.filter((i) => i.issue === "invalid-workflow-structure");
    expect(structural).toHaveLength(1);
    expect(structural[0]?.detail).toContain("does not come before this step");
  });

  test("a param declared as a step input is a compile-stage finding", async () => {
    const stashDir = makeTempStash();
    writeWorkflowFile(
      stashDir,
      "param-input.md",
      [
        "---",
        "type: workflow",
        "updated: 2026-07-30",
        "steps:",
        "  - id: consume",
        "    inputs: [params.payload]",
        "---",
        "",
        "## consume",
        "",
        "Use it.",
        "",
      ].join("\n"),
    );

    const result = await akmLint({ dir: stashDir, typeFilter: "workflows" });

    const structural = result.flagged.filter((i) => i.issue === "invalid-workflow-structure");
    expect(structural).toHaveLength(1);
    expect(structural[0]?.detail).toContain("names a param, not a step output");
  });

  test("a clean workflow alongside a structurally-broken one: each is checked independently", async () => {
    const stashDir = makeTempStash();
    writeWorkflowFile(stashDir, "release.md", CLEAN_WORKFLOW);
    writeWorkflowFile(stashDir, "broken.md", ["---", "type: workflow", "description: Broken", "---", ""].join("\n"));

    const result = await akmLint({ dir: stashDir, typeFilter: "workflows" });

    const structural = result.flagged.filter((i) => i.issue === "invalid-workflow-structure");
    expect(structural).toHaveLength(1);
    expect(structural[0]!.file).toContain("broken.md");
  });
});

// ── Bug 9 regression: bounds that used to be decoder-only now fail lint ──────
//
// gate.max_loops / map.concurrency / engine names were only bounded by the
// strict frozen-plan decoder (`decodeWorkflowPlanV3`), so `akm lint` passed
// and `workflow run` later failed with an unlocated "Invalid frozen workflow
// plan: …". The parser now enforces the shared bounds
// (src/workflows/resource-limits.ts) with line-anchored messages, which lint
// surfaces as `invalid-workflow-structure` findings.
describe("akm lint — decoder-only bounds now fail at lint time", () => {
  test("gate.max_loops above the shared bound is a lint finding", async () => {
    const stashDir = makeTempStash();
    writeWorkflowFile(
      stashDir,
      "loops.md",
      [
        "---",
        "type: workflow",
        "steps:",
        "  - id: only",
        "    gate: { max_loops: 101 }",
        "---",
        "",
        "## only",
        "",
        "Do it.",
        "",
      ].join("\n"),
    );

    const result = await akmLint({ dir: stashDir, typeFilter: "workflows" });
    const structural = result.flagged.filter((i) => i.issue === "invalid-workflow-structure");
    expect(structural).toHaveLength(1);
    expect(structural[0]!.detail).toContain('"gate.max_loops" must be an integer from 1 through 100');
  });

  test("map.concurrency above the shared bound is a lint finding", async () => {
    const stashDir = makeTempStash();
    writeWorkflowFile(
      stashDir,
      "fanout.md",
      [
        "---",
        "type: workflow",
        "steps:",
        "  - id: only",
        "    map: { over: params.items, concurrency: 65 }",
        "---",
        "",
        "## only",
        "",
        "Do it.",
        "",
      ].join("\n"),
    );

    const result = await akmLint({ dir: stashDir, typeFilter: "workflows" });
    const structural = result.flagged.filter((i) => i.issue === "invalid-workflow-structure");
    expect(structural).toHaveLength(1);
    expect(structural[0]!.detail).toContain('"concurrency" must be an integer from 1 through 64');
  });

  test("an engine name outside the frozen-plan grammar is a lint finding", async () => {
    const stashDir = makeTempStash();
    writeWorkflowFile(
      stashDir,
      "engine.md",
      [
        "---",
        "type: workflow",
        "steps:",
        "  - id: only",
        "    unit: { engine: My_Engine }",
        "---",
        "",
        "## only",
        "",
        "Do it.",
        "",
      ].join("\n"),
    );

    const result = await akmLint({ dir: stashDir, typeFilter: "workflows" });
    const structural = result.flagged.filter((i) => i.issue === "invalid-workflow-structure");
    expect(structural).toHaveLength(1);
    expect(structural[0]!.detail).toContain('invalid engine name "My_Engine"');
  });
});

// ── Bug 9 regression: compile warnings surface through lint output ───────────
//
// `compileWorkflowPlan` emits non-fatal warnings (step missing `output:`
// schema; reference to an undeclared param), and its doc comment claims they
// surface in lint output — but the lint path used to drop `compiled.warnings`
// entirely, so they only ever appeared at run start. They now travel in the
// result's separate `warnings` channel (issue code `workflow-warning`), which
// is exactly what `akm lint --format json` serializes (lint is a passthrough
// output shape) — kept out of `flagged` so `--fail-on-flagged` is unaffected.
describe("akm lint — workflow compile warnings surface as warnings (non-fatal)", () => {
  test("a step with no output: schema yields a workflow-warning in the warnings channel, not flagged", async () => {
    const stashDir = makeTempStash();
    writeWorkflowFile(stashDir, "untyped.md", CLEAN_WORKFLOW);

    const result = await akmLint({ dir: stashDir, typeFilter: "workflows" });

    expect(result.flagged).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatchObject({ issue: "workflow-warning", fixed: false });
    expect(result.warnings[0]!.file).toContain("untyped.md");
    expect(result.warnings[0]!.detail).toContain('Step "only" declares no `output:` schema');
    expect(result.summary).toEqual({ fixed: 0, flagged: 0, warnings: 1 });
  });

  test("a reference to an undeclared param is a workflow-warning too", async () => {
    const stashDir = makeTempStash();
    writeWorkflowFile(
      stashDir,
      "typo-param.md",
      [
        "---",
        "type: workflow",
        "updated: 2026-07-30",
        "params:",
        "  items: { type: array }",
        "steps:",
        "  - id: only",
        "    output: { type: array }",
        "    map: { over: params.itmes }",
        "---",
        "",
        "## only",
        "",
        "Do it.",
        "",
      ].join("\n"),
    );

    const result = await akmLint({ dir: stashDir, typeFilter: "workflows" });

    expect(result.flagged).toHaveLength(0);
    const warnings = result.warnings.filter((i) => i.issue === "workflow-warning");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.detail).toContain('"params.itmes" references a param not declared in `params:`');
  });

  test("warnings survive JSON round-tripping of the lint result (the JSON output surface)", async () => {
    const stashDir = makeTempStash();
    writeWorkflowFile(stashDir, "untyped.md", CLEAN_WORKFLOW);

    const result = await akmLint({ dir: stashDir, typeFilter: "workflows" });
    // `lint` is a passthrough output shape (src/output/shapes/passthrough.ts):
    // `--format json` serializes the result object verbatim.
    const json = JSON.parse(JSON.stringify(result)) as typeof result;
    expect(json.warnings).toHaveLength(1);
    expect(json.warnings[0]!.issue).toBe("workflow-warning");
    expect(json.summary.warnings).toBe(1);
  });

  test("a structurally-broken workflow yields errors, and no warnings from the aborted compile", async () => {
    const stashDir = makeTempStash();
    writeWorkflowFile(stashDir, "broken.md", ["---", "type: workflow", "description: Broken", "---", ""].join("\n"));

    const result = await akmLint({ dir: stashDir, typeFilter: "workflows" });
    expect(result.flagged.filter((i) => i.issue === "invalid-workflow-structure")).toHaveLength(1);
    expect(result.warnings).toHaveLength(0);
  });
});

// ── Line anchors: lint findings carry the source line ────────────────────────
//
// `WorkflowError` has always been line-anchored (`workflow create` renders
// `path:line — message`), but `akm lint` DROPPED `err.line`, so an author
// linting a 300-line workflow got a message with no location. `LintIssue` /
// `Diagnostic` now carry an OPTIONAL `line`, populated from the workflow
// frontend and rendered by both the human formatter (`file:line`) and the JSON
// output. Non-workflow lint sources have no line and are unchanged.
describe("akm lint — workflow findings carry a line number", () => {
  /** A workflow whose ONLY error is on a known line (`gate:`, line 8). */
  const BROKEN_AT_LINE_8 = [
    "---", // 1
    "type: workflow", // 2
    "description: Anchored", // 3
    "updated: 2026-07-30", // 4
    "steps:", // 5
    "  - id: first", // 6
    "  - id: second", // 7
    "    gate: { max_loops: 0 }", // 8
    "---", // 9
    "", // 10
    "## first", // 11
    "", // 12
    "Do it.", // 13
    "", // 14
    "## second", // 15
    "", // 16
    "Do it again.", // 17
    "", // 18
  ].join("\n");

  test("a structural finding reports the offending line, not just the file", async () => {
    const stashDir = makeTempStash();
    writeWorkflowFile(stashDir, "anchored.md", BROKEN_AT_LINE_8);

    const result = await akmLint({ dir: stashDir, typeFilter: "workflows" });

    const structural = result.flagged.filter((i) => i.issue === "invalid-workflow-structure");
    expect(structural).toHaveLength(1);
    expect(structural[0]!.line).toBe(8);
    expect(structural[0]!.detail).toContain('"gate.max_loops"');
  });

  test("the line survives JSON serialization (the `--format json` surface)", async () => {
    const stashDir = makeTempStash();
    writeWorkflowFile(stashDir, "anchored.md", BROKEN_AT_LINE_8);

    const result = await akmLint({ dir: stashDir, typeFilter: "workflows" });
    const json = JSON.parse(JSON.stringify(result)) as typeof result;

    expect(json.flagged[0]!.line).toBe(8);
  });

  test("the human formatter renders `file:line` for a line-anchored finding", async () => {
    const stashDir = makeTempStash();
    writeWorkflowFile(stashDir, "anchored.md", BROKEN_AT_LINE_8);

    const result = await akmLint({ dir: stashDir, typeFilter: "workflows" });
    const text = formatLintPlain(result as unknown as Record<string, unknown>) ?? "";

    expect(text).toContain(`${path.join("workflows", "anchored.md")}:8  [invalid-workflow-structure]`);
  });

  test("compile warnings are line-anchored too", async () => {
    const stashDir = makeTempStash();
    writeWorkflowFile(stashDir, "untyped.md", CLEAN_WORKFLOW);

    const result = await akmLint({ dir: stashDir, typeFilter: "workflows" });

    expect(result.warnings).toHaveLength(1);
    // The `- id: only` step declaration is line 6 of CLEAN_WORKFLOW.
    expect(result.warnings[0]!.line).toBe(6);
    const text = formatLintPlain(result as unknown as Record<string, unknown>) ?? "";
    expect(text).toContain(":6  [workflow-warning]");
  });

  test("a whole-file finding from a non-workflow source carries NO line (field stays optional)", async () => {
    const stashDir = makeTempStash();
    const skillDir = path.join(stashDir, "skills", "no-md");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "notes.md"), "# notes\n", "utf8");

    const result = await akmLint({ dir: stashDir, typeFilter: "skills" });

    const missing = result.flagged.filter((i) => i.issue === "missing-skill-md");
    expect(missing).toHaveLength(1);
    expect(missing[0]!.line).toBeUndefined();
    expect(Object.hasOwn(missing[0]!, "line")).toBe(false);
    const text = formatLintPlain(result as unknown as Record<string, unknown>) ?? "";
    expect(text).toContain(`${path.join("skills", "no-md")}  [missing-skill-md]`);
  });
});
