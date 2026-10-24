// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The target-ref classifier seam (`src/execution/target-ref.ts`,
 * `classifyTargetRef`).
 *
 * Three groups:
 *
 *   1. `classifyTargetRef` accept/reject matrix, including the frozen-result
 *      assertion on every accepted shape.
 *   2. `classifyWorkflowStepUses` exercised through its REAL default
 *      classifier (no injected spy) — a direct unit-level pin of the seam's
 *      observable results.
 *   3. Import boundary: `src/workflows/source-ir/{semantics,uses}.ts` must
 *      import nothing from `src/tasks/source-v3.ts`.
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { UsageError } from "../../src/core/errors";
import type { TargetRefKind } from "../../src/execution/target-ref";
import { classifyWorkflowStepUses, WorkflowSourceSemanticError } from "../../src/workflows/source-semantics";

const ROOT = path.resolve(import.meta.dir, "../..");

/** Capture a synchronous throw once, so a message/code pin never re-invokes the function under test. */
function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("expected function to throw");
}

/** Resolve the classifier module dynamically per test. */
async function targetRefApi() {
  return import("../../src/execution/target-ref");
}

// ── classifyTargetRef: accept/reject matrix ─────────────────────────────────

describe("classifyTargetRef — canonical asset-ref classification (src/execution/target-ref.ts)", () => {
  test("classifies each of commands/scripts/tasks/workflows, bundle-qualified or not, and freezes the result", async () => {
    const { classifyTargetRef } = await targetRefApi();
    const matrix: Array<[string, TargetRefKind]> = [
      ["commands/review", "command"],
      ["team//commands/review", "command"],
      ["scripts/build.sh", "script"],
      ["team//scripts/build.sh", "script"],
      ["tasks/nightly", "task"],
      ["team//tasks/review", "task"],
      ["workflows/release", "workflow"],
      ["team//workflows/release", "workflow"],
    ];
    for (const [value, kind] of matrix) {
      const result = classifyTargetRef(value);
      // Per-property assertions rather than a whole-object toEqual: mostly a style
      // choice, since `kind` is typed as the real `TargetRefKind` and a strict
      // toEqual<ClassifiedTargetRef> overload would type-check fine too.
      expect(result.kind).toBe(kind);
      expect(result.ref).toBe(value);
      expect(Object.isFrozen(result)).toBe(true);
    }
  });

  // No `akm/command` special case inside classifyTargetRef itself — it is the
  // bare canonical-ref classifier; callers (classifyWorkflowSourceUses) layer
  // builtin detection on top.
  test("'akm/command' is rejected — classifyTargetRef has no builtin special case", async () => {
    const { classifyTargetRef } = await targetRefApi();
    const error = thrown(() => classifyTargetRef("akm/command"));
    expect(error).toBeInstanceOf(UsageError);
    expect((error as UsageError).code).toBe("TARGET_REF_INVALID");
    expect((error as Error).message).toBe(
      `Target ref ${JSON.stringify("akm/command")} must be a canonical commands/, scripts/, tasks/, or workflows/ asset ref.`,
    );
  });

  // Malformed / fragment / empty / whitespace / github-locator-shaped values all
  // reject with the exact message. No GitHub locator grammar lives here —
  // "owner/repo@v1" is just an unrecognized family, same as any other
  // non-canonical shape.
  test("rejects malformed, fragment, empty, whitespace, and github-locator-shaped values with TARGET_REF_INVALID", async () => {
    const { classifyTargetRef } = await targetRefApi();
    const rejected = [
      "commands/review#fragment",
      "akm:commands/review",
      "bad.bundle//commands/review",
      "agents/reviewer",
      "review",
      "",
      " commands/review ",
      "owner/repo@v1",
      "docker://alpine:latest",
      "./x",
    ];
    for (const value of rejected) {
      const error = thrown(() => classifyTargetRef(value));
      expect(error).toBeInstanceOf(UsageError);
      expect((error as UsageError).code).toBe("TARGET_REF_INVALID");
      expect((error as Error).message).toBe(
        `Target ref ${JSON.stringify(value)} must be a canonical commands/, scripts/, tasks/, or workflows/ asset ref.`,
      );
    }
  });
});

// ── classifyWorkflowStepUses through the REAL default classifier — the ─────
// ── parity table, exercised without a spy ──────────────────────────────────

describe("classifyWorkflowStepUses — identical observable results through the new seam", () => {
  // "workflows/child" is in this accepted table as ["workflows/child",
  // "workflow"], matching TargetRefKind (src/execution/target-ref.ts).
  test("accepts every accepted kind through the real default classifier", () => {
    const accepted: Array<[string, "command" | "script" | "task" | "builtin-command" | "workflow"]> = [
      ["commands/review", "command"],
      ["team//commands/review", "command"],
      ["scripts/build.sh", "script"],
      ["tasks/review", "task"],
      ["team//tasks/review", "task"],
      ["akm/command", "builtin-command"],
      ["workflows/child", "workflow"],
    ];
    for (const [value, kind] of accepted) {
      const result = classifyWorkflowStepUses(value);
      // Per-property assertions rather than a whole-object toEqual: `kind`
      // here is a plain `string` (widened across this heterogeneous table's
      // rows, an ordinary TS loop-variable limitation), which a strict
      // toEqual<WorkflowSourceUsesTarget> overload would reject as not
      // narrow enough — string-to-string equality has no such constraint.
      expect(result.kind).toBe(kind);
      expect(result.ref).toBe(value);
    }
  });

  // Message text may drift for the classifyTargetRef-derived rows — only `code`
  // is pinned here.
  //
  // `workflows/child` is not in this rejected table: it classifies as accepted
  // (see the accepted table above).
  //
  // Every github-locator-shaped value below is just an unrecognized ref shape —
  // there is no locator grammar — so each of these rows is
  // unsupported-uses-target.
  test("rejects every non-accepted kind with its listed WorkflowSourceSemanticError code", () => {
    const rejected: Array<[string, string]> = [
      ["actions/checkout@v4", "unsupported-uses-target"],
      ["./actions/review", "local-action-path-unsupported"],
      ["docker://alpine:latest", "docker-action-unsupported"],
      ["agents/reviewer", "non-executable-asset-ref"],
      ["akm:commands/review", "unsupported-uses-target"],
      ["bad.bundle//commands/review", "unsupported-uses-target"],
      ["commands/review#fragment", "unsupported-uses-target"],
      ["actions/checkout@bad:ref", "unsupported-uses-target"],
      ["review", "unsupported-uses-target"],
      // Locator-shaped values — kept as regression coverage for these exact values,
      // which all land on the one generic code.
      ["owner/.github@v1", "unsupported-uses-target"],
      ["owner/_repo@v1", "unsupported-uses-target"],
      ["owner/-repo@v1", "unsupported-uses-target"],
      ["owner/repo@v1.0+meta", "unsupported-uses-target"],
      ["owner/repo@%40", "unsupported-uses-target"],
      ["owner/repo/../x@v1", "unsupported-uses-target"],
      ["owner/repo/.@v1", "unsupported-uses-target"],
      ["o.wner/repo@v1", "unsupported-uses-target"],
      ["own_er/repo@v1", "unsupported-uses-target"],
      ["a234567890123456789012345678901234567890/repo@v1", "unsupported-uses-target"],
    ];
    for (const [value, code] of rejected) {
      const error = thrown(() => classifyWorkflowStepUses(value));
      expect(error).toBeInstanceOf(WorkflowSourceSemanticError);
      expect((error as WorkflowSourceSemanticError).code).toBe(code);
    }
  });

  // A github-locator-shaped value gets no code or message of its own:
  // classifyTargetRef has no locator grammar, so it falls to the same generic
  // unsupported-uses-target rejection as any other unrecognized shape.
  test("a github-locator-shaped step uses now falls to the generic unsupported-uses-target rejection", () => {
    const error = thrown(() => classifyWorkflowStepUses("actions/checkout@v4"));
    expect(error).toBeInstanceOf(WorkflowSourceSemanticError);
    expect((error as WorkflowSourceSemanticError).code).toBe("unsupported-uses-target");
    expect((error as Error).message).toBe(
      'Target ref "actions/checkout@v4" must be a canonical commands/, scripts/, tasks/, or workflows/ asset ref.',
    );
  });
});

// ── Import boundary: the workflow uses-classification seam owns zero ───────
// ── import from src/tasks/source-v3.ts ─────────────────────────────────────

/** Top-level `import ... from "..."` module specifiers in a TypeScript source file. */
function importedModuleSpecifiers(filePath: string): string[] {
  const source = ts.createSourceFile(filePath, fs.readFileSync(filePath, "utf8"), ts.ScriptTarget.Latest, true);
  const specifiers: string[] = [];
  source.forEachChild((node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      specifiers.push(node.moduleSpecifier.text);
    }
  });
  return specifiers;
}

/** True when a module specifier resolves to src/tasks/source-v3(.ts), in any relative spelling. */
function isSourceV3Specifier(specifier: string): boolean {
  return /(?:^|\/)tasks\/source-v3(?:\.ts)?$/.test(specifier);
}

describe("import boundary — the workflow uses-classification seam imports nothing from tasks/source-v3", () => {
  test("src/workflows/source-semantics.ts imports nothing from tasks/source-v3", () => {
    const specifiers = importedModuleSpecifiers(path.join(ROOT, "src/workflows/source-semantics.ts"));
    expect(specifiers.filter(isSourceV3Specifier)).toEqual([]);
  });
});
