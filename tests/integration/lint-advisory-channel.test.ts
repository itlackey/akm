// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The lint advisory channel and the workflow frontend pass behind it.
 *
 * Three properties, all about routing a NON-FATAL finding correctly:
 *   • `ADVISORY_LINT_ISSUES` is the single home for "never `flagged`", so no
 *     two routing points can disagree about a code and let a non-fatal hint
 *     fail `--fail-on-flagged` (exit 1) on one path only.
 *   • `workflowFrontendDiagnostics` is ONE parse+compile carrying both halves,
 *     so the sweep runs the frontend exactly once per workflow file — the
 *     property a pair of single-view helpers could only hold by accident, when
 *     their two call sites happened to sit next to each other.
 *   • the sweep files each finding by the classifier, never by which half of
 *     the pass produced it.
 */

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmLint } from "../../src/commands/lint/index";
import { ADVISORY_LINT_ISSUES, isAdvisoryLintIssue } from "../../src/commands/lint/types";
import { workflowFrontendDiagnostics, workflowStructureDiagnostics } from "../../src/core/adapter/adapters/akm-lint";
import * as workflowParser from "../../src/workflows/parser";
import { makeSandboxDir } from "../_helpers/sandbox";
import { workflowDoc } from "../_helpers/workflow";

const REL = "workflows/advisory.md";
const PARSE_PATH = "/stash/workflows/advisory.md";

/**
 * Compiles cleanly, but declares `gate.max_loops: 2` on an `exec` step — one
 * advisory.
 *
 * Was previously "a step with no `output:` schema", the advisory #886 deleted
 * for firing on 100% of steps while guarding nothing. This file tests the
 * ROUTING machinery, not that particular warning, so it needs any document
 * that compiles clean and emits exactly one advisory. The gate/exec warning
 * qualifies and is a better fixture besides: it describes a real mistake, so
 * it will not be deleted out from under this suite the same way.
 */
const WARNS = workflowDoc(
  ['    unit: { exec: { command: ["echo", "hi"] } }', "    gate: { max_loops: 2 }"],
  "## work\n\nDo it.\n\n### gate\n\nMust be green.\n",
);
/** Fails the schema-definition check — errors, and therefore no advisories. */
const ERRORS = workflowDoc(["    output:", "      type: strig"]);

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** A temp stash holding `files` under `workflows/`. */
function makeWorkflowStash(files: Record<string, string>): string {
  const { dir, cleanup } = makeSandboxDir("akm-lint-advisory");
  cleanups.push(cleanup);
  const workflowsDir = path.join(dir, "workflows");
  fs.mkdirSync(workflowsDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(workflowsDir, name), content, "utf8");
  }
  return dir;
}

describe("advisory issue classification", () => {
  test("workflow-warning is advisory and ordinary findings are not", () => {
    expect(isAdvisoryLintIssue({ issue: "workflow-warning" })).toBe(true);
    for (const issue of ["invalid-workflow-structure", "placeholder-stub", "adapter-diagnostic", "broken-xref"]) {
      expect(isAdvisoryLintIssue({ issue })).toBe(false);
    }
  });

  test("every advisory code the frontend emits is registered", () => {
    const emitted = workflowFrontendDiagnostics(REL, WARNS, PARSE_PATH).warnings;
    expect(emitted.length).toBeGreaterThan(0);
    for (const diagnostic of emitted) {
      expect(ADVISORY_LINT_ISSUES.has(diagnostic.issue)).toBe(true);
    }
  });
});

describe("workflow frontend pass", () => {
  test("one pass carries both halves, and a compile warning never rides the error channel", () => {
    const pass = workflowFrontendDiagnostics(REL, WARNS, PARSE_PATH);
    expect(pass.errors).toEqual([]);
    expect(pass.warnings.map((d) => d.issue)).toEqual(["workflow-warning"]);
  });

  test("a document that fails to compile reports errors and no advisories", () => {
    const pass = workflowFrontendDiagnostics(REL, ERRORS, PARSE_PATH);
    expect(pass.errors.length).toBeGreaterThan(0);
    expect(pass.warnings).toEqual([]);
  });

  test("workflowStructureDiagnostics is the error half of the same pass", () => {
    expect(workflowStructureDiagnostics(REL, ERRORS, PARSE_PATH)).toEqual(
      workflowFrontendDiagnostics(REL, ERRORS, PARSE_PATH).errors,
    );
    expect(workflowStructureDiagnostics(REL, WARNS, PARSE_PATH)).toEqual([]);
  });

  test("each call answers for the arguments it was given", () => {
    // Two files whose findings must not be confused with each other, then the
    // same paths re-asked with different bytes (the shape a `--fix` rewrite
    // produces) — no answer may outlive the call it was computed for.
    expect(workflowFrontendDiagnostics("workflows/a.md", WARNS, "/stash/workflows/a.md").warnings[0]?.file).toBe(
      "workflows/a.md",
    );
    expect(workflowFrontendDiagnostics("workflows/a b.md", WARNS, "/stash/c.md").warnings[0]?.file).toBe(
      "workflows/a b.md",
    );
    expect(workflowFrontendDiagnostics(REL, ERRORS, PARSE_PATH).warnings).toEqual([]);
    expect(workflowFrontendDiagnostics(REL, WARNS, PARSE_PATH).warnings).toHaveLength(1);
  });
});

describe("akm lint sweep routing", () => {
  test("the workflow frontend runs exactly once per workflow file", async () => {
    const stashDir = makeWorkflowStash({
      "clean.md": WARNS,
      "broken.md": ERRORS,
      "also-clean.md": workflowDoc(["    output: { type: string }"]),
    });
    const parseSpy = spyOn(workflowParser, "parseWorkflow");

    await akmLint({ dir: stashDir, typeFilter: "workflows" });

    expect(parseSpy.mock.calls).toHaveLength(3);
    parseSpy.mockRestore();
  });

  test("every finding lands in the channel the classifier names", async () => {
    const stashDir = makeWorkflowStash({ "clean.md": WARNS, "broken.md": ERRORS });

    const result = await akmLint({ dir: stashDir, typeFilter: "workflows" });

    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.flagged.length).toBeGreaterThan(0);
    for (const issue of result.warnings) expect(isAdvisoryLintIssue(issue)).toBe(true);
    for (const issue of result.flagged) expect(isAdvisoryLintIssue(issue)).toBe(false);
    expect(result.summary).toEqual({
      fixed: 0,
      flagged: result.flagged.length,
      warnings: result.warnings.length,
    });
  });
});
