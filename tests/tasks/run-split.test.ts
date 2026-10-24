// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * STRUCTURAL contract for P1b's `src/tasks/run/**` split (spec
 * docs/plans/specs/p1b-model-extraction.md §5.1, §9 "Structure"). Sibling to
 * `tests/tasks/prepare-split.test.ts` (Lane B's caller-shape parity contract)
 * but for Lane C, and narrower in scope on purpose: Lane C's *behavior* is
 * already pinned exhaustively elsewhere — the flipped P0 characterization
 * files (tasks-provenance-characterization.test.ts,
 * tasks-legacy-vocabulary-characterization.test.ts), the two P1b files
 * (tasks-provenance-context.test.ts, tasks-result-vocabulary.test.ts), and
 * cli-errors.test.ts. What NONE of those files pins is whether
 * `src/tasks/run/**` actually holds the real logic, independent of any other
 * module — an implementation that lands every authorized behavior flip
 * without the split modules actually exporting real runtime logic passes
 * every one of them. This file exists to close exactly that gap:
 *
 *   (a) each spec §5.1 module under src/tasks/run/** loads and exports its
 *       named responsibility: run-task.ts -> runTask, attempt-lifecycle.ts ->
 *       recordTaskAttemptFailure, task-history.ts -> readTaskHistory,
 *       task-result.ts -> exitCodeForStatus, task-log.ts -> scrubDbLines,
 *       provenance.ts -> a context factory matching D5's construction. The
 *       remaining four modules (load-task.ts, run-native-task.ts,
 *       run-workflow-task.ts, run-command-task.ts) hold helpers with no
 *       spec-committed exported name, so pinning one here would force an
 *       implementation choice the spec never made; they get a weaker but
 *       still real "exists and exports actual runtime logic, not an empty
 *       stub" check instead.
 *   (b) `src/tasks/runner.ts` — the 1177-line-at-head module `src/tasks/run/**`
 *       was split out of, kept alive afterward only as a re-export compat
 *       shim (spec §9: "runner.ts contains no logic — only re-exports") —
 *       does not exist. P4 (docs/plans/specs/p4-deletions-closeout.md
 *       §3.2.7, row B-26, F-A2.16) deleted it once every caller was rewired
 *       to import `src/tasks/run/**` directly; its own former "no function/
 *       class declarations of its own" AST scan and the "no file under
 *       src/tasks/run/** imports runner.ts" one-way-rule scan (spec §5.1)
 *       both collapse into this one, strictly stronger claim — a module that
 *       does not exist cannot be imported by anything that still compiles.
 *
 * Every module below is real, shipped production code (no longer test-first
 * red-phase authoring) — imported directly, by literal path, typed for real.
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { recordTaskAttemptFailure } from "../../src/tasks/run/attempt-lifecycle";
import { createExecutionProvenanceContext } from "../../src/tasks/run/provenance";
import { runTask } from "../../src/tasks/run/run-task";
import { readTaskHistory } from "../../src/tasks/run/task-history";
import { scrubDbLines } from "../../src/tasks/run/task-log";
import { exitCodeForStatus } from "../../src/tasks/run/task-result";

const ROOT = path.resolve(import.meta.dir, "../..");
const RUNNER_FILE = path.join(ROOT, "src/tasks/runner.ts");
const RUN_DIR = path.join(ROOT, "src/tasks/run");

// ── (a) each §5.1 module loads and exports its named responsibility ────────

describe("src/tasks/run/** — each named module exports its spec §5.1 responsibility", () => {
  test("run/run-task.ts exports runTask", () => {
    expect(typeof runTask).toBe("function");
  });

  test("run/attempt-lifecycle.ts exports recordTaskAttemptFailure", () => {
    expect(typeof recordTaskAttemptFailure).toBe("function");
  });

  test("run/task-history.ts exports readTaskHistory", () => {
    expect(typeof readTaskHistory).toBe("function");
  });

  test("run/task-result.ts exports exitCodeForStatus", () => {
    expect(typeof exitCodeForStatus).toBe("function");
  });

  test("run/task-log.ts exports scrubDbLines", () => {
    expect(typeof scrubDbLines).toBe("function");
  });

  test('run/provenance.ts exports a context factory matching D5\'s construction ({eventSource: "task", scheduled}, spec §1.2/§5.2)', () => {
    expect(createExecutionProvenanceContext(false)).toEqual({ eventSource: "task", scheduled: false });
    expect(createExecutionProvenanceContext(true)).toEqual({ eventSource: "task", scheduled: true });
  });
});

describe("src/tasks/run/** — the remaining §5.1 modules export real runtime logic, not an empty stub (spec §5.1)", () => {
  // load-task.ts / run-native-task.ts / run-workflow-task.ts /
  // run-command-task.ts hold helpers with no spec-committed exported name
  // (loadPreparedTask-shaped orchestration; shellCommand/
  // resolveLeadingBareAkmCommand/quoteShellArgument; runWorkflowTask/
  // mapWorkflowStatus/renderWorkflowLog; runPreparedCommandTask/
  // renderPromptLog). This checks the weaker, still-real thing the spec DOES
  // commit to: the file exists and exports at least one RUNTIME (non
  // type-only) declaration.
  const MODULE_FILES: ReadonlyArray<readonly [label: string, filePath: string]> = [
    ["run/load-task.ts", path.join(RUN_DIR, "load-task.ts")],
    ["run/run-native-task.ts", path.join(RUN_DIR, "run-native-task.ts")],
    ["run/run-workflow-task.ts", path.join(RUN_DIR, "run-workflow-task.ts")],
    ["run/run-command-task.ts", path.join(RUN_DIR, "run-command-task.ts")],
  ];

  /**
   * True when `filePath` has a top-level `export` on a function, class, or
   * variable declaration — i.e. something that still exists at RUNTIME after
   * TypeScript's types are erased. `export interface`/`export type` alone
   * would make an empty stub file look "covered", which is exactly the
   * vacuous check this file's header rules out.
   */
  function hasRuntimeExport(filePath: string): boolean {
    const source = ts.createSourceFile(filePath, fs.readFileSync(filePath, "utf8"), ts.ScriptTarget.Latest, true);
    let found = false;
    function visit(node: ts.Node): void {
      if (found) return;
      if (
        ts.canHaveModifiers(node) &&
        ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) &&
        (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isVariableStatement(node))
      ) {
        found = true;
        return;
      }
      // `export { x }` / `export { x as y }` (no re-export moduleSpecifier —
      // that case is a re-export) also counts as a runtime export.
      if (ts.isExportDeclaration(node) && !node.moduleSpecifier && node.exportClause) found = true;
      ts.forEachChild(node, visit);
    }
    visit(source);
    return found;
  }

  for (const [label, filePath] of MODULE_FILES) {
    test(`${label} exists and exports at least one runtime declaration`, () => {
      expect(hasRuntimeExport(filePath), label).toBe(true);
    });
  }
});

describe("src/tasks/runner.ts — the deleted compat shim (spec §5.1/§9, P4 §3.2.7 row B-26)", () => {
  test("does not exist — every caller is rewired to src/tasks/run/** directly", () => {
    expect(fs.existsSync(RUNNER_FILE)).toBe(false);
  });
});
