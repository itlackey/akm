// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * P1a Lane B — the target-ref classifier seam.
 *
 * See docs/plans/specs/p1a-with-rejection-classifier.md §4 for the binding
 * design; row IDs (B-09…B-13) are this spec's §5 behavior table. Written
 * ahead of the Lane B implementation per the phase's test-first cycle:
 * `src/execution/target-ref.ts` (`classifyTargetRef`) does not exist on disk
 * yet, so the first group below is expected to be RED on missing module —
 * exactly like this repo's other pre-implementation `*-red.test.ts` files
 * (e.g. tests/workflows/guarded-execution-source-red.test.ts) resolve their
 * subject module dynamically per test rather than via a static top-level
 * import, so a not-yet-existing module fails EACH test as its own clear
 * rejection instead of one opaque "cannot find module" collection error that
 * would also take down the unrelated groups below.
 *
 * Three groups:
 *
 *   1. `classifyTargetRef` accept/reject matrix (B-09…B-13), including the
 *      frozen-result assertion on every accepted shape.
 *   2. `classifyWorkflowStepUses` exercised through its REAL default
 *      classifier (no injected spy) — the §4.5 parity table reproduced as a
 *      direct unit-level pin that the new seam produces identical observable
 *      results to today, independent of the untouched parity gate
 *      (tests/workflows/source-ir-contract.test.ts, which runs the same
 *      table through the heavier `compileGithubWorkflowSource` YAML
 *      pipeline) and of the two existing spy-based delegation tests in
 *      tests/workflows/characterization-classification.test.ts (the spec's
 *      F-03 row: the injected-classifier parameter itself is untouched by
 *      P1a, so those two tests are correctly left unchanged — "keep
 *      unchanged, rewriting should be avoided").
 *   3. Import boundary: `src/workflows/source-ir/{semantics,uses}.ts` must
 *      import nothing from `src/tasks/source-v3.ts` (§4.2/§4.3, §9 assertion
 *      2). RED when this group was written: `uses.ts` still delegated to
 *      `classifyTaskV3Uses` imported from that module, a genuine failing
 *      expectation rather than a module-resolution crash. GREEN since P1a's
 *      own implement step landed `classifyTargetRef` and re-pointed `uses.ts`
 *      at it. `compile.ts` carried the seam's one remaining exception
 *      (`classifyTaskV3Triggers`) until P4
 *      (docs/plans/specs/p4-deletions-closeout.md §3.2.3, P4-N3) re-homed it
 *      into `src/workflows/source-ir/triggers.ts` as
 *      `classifyWorkflowYamlTriggers` — the full three-file seam
 *      (`semantics.ts`, `uses.ts`, `compile.ts`) is asserted together in
 *      `tests/architecture/diagnostic-codes.test.ts`; this file's own two
 *      tests below cover `semantics.ts` and `uses.ts` only.
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

/**
 * Dynamically import the not-yet-implemented classifier module rather than a
 * static top-level import — see the file docstring. Bun/Node's ESM loader
 * caches the promise per specifier, so calling this once per test costs
 * nothing extra once the module exists.
 */
async function targetRefApi() {
  return import("../../src/execution/target-ref");
}

// ── classifyTargetRef: accept/reject matrix (B-09…B-13) ─────────────────────

describe("classifyTargetRef — canonical asset-ref classification (P1a §4.1, src/execution/target-ref.ts)", () => {
  test("B-09/B-10/B-11: classifies each of commands/scripts/tasks/workflows, bundle-qualified or not, and freezes the result", async () => {
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
      // Per-property assertions rather than a whole-object toEqual: this is
      // mostly a style choice here, since `kind` is now typed as the real
      // `TargetRefKind` (ClassifiedTargetRef.kind is pinned, spec §4.1 — no
      // widening at the production type), so a strict
      // toEqual<ClassifiedTargetRef> overload would type-check fine too.
      expect(result.kind).toBe(kind);
      expect(result.ref).toBe(value);
      expect(Object.isFrozen(result)).toBe(true);
    }
  });

  // B-12: no `akm/command` special case inside classifyTargetRef itself —
  // it is the bare canonical-ref classifier; callers (classifyWorkflowSourceUses,
  // §4.2) layer builtin detection on top.
  test("B-12: 'akm/command' is rejected — classifyTargetRef has no builtin special case", async () => {
    const { classifyTargetRef } = await targetRefApi();
    const error = thrown(() => classifyTargetRef("akm/command"));
    expect(error).toBeInstanceOf(UsageError);
    expect((error as UsageError).code).toBe("TARGET_REF_INVALID");
    expect((error as Error).message).toBe(
      `Target ref ${JSON.stringify("akm/command")} must be a canonical commands/, scripts/, tasks/, or workflows/ asset ref.`,
    );
  });

  // B-13: malformed / fragment / empty / whitespace / github-locator-shaped
  // values all reject with the exact §4.1 message. No GitHub locator
  // grammar lives here (explicit non-goal, §4.1) — "owner/repo@v1" is just
  // an unrecognized family, same as any other non-canonical shape.
  test("B-13: rejects malformed, fragment, empty, whitespace, and github-locator-shaped values with TARGET_REF_INVALID", async () => {
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
// ── §4.5 parity table, exercised without a spy (the "new seam") ────────────

describe("classifyWorkflowStepUses — identical observable results through the new seam (P1a §4.3/§4.5 parity)", () => {
  // P3a FLIP (docs/plans/specs/p3a-plan-v5-child-freeze.md §1.5/§6 F-B3, row
  // B-02): "workflows/child" joins this accepted table as
  // ["workflows/child", "workflow"], matching TargetRefKind
  // (src/execution/target-ref.ts:33) — the per-property assertion loop below
  // needs no change.
  test("accepts every §4.5 accepted kind through the real default classifier", () => {
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

  // Message text is authorized to drift for the classifyTargetRef-derived
  // rows (spec §4.5: "message drift here is authorized; code drift is not")
  // — only `code` is pinned here, matching the untouched parity gate
  // (source-ir-contract.test.ts), which asserts `code` only for this table.
  //
  // P3a FLIP (spec §1.5/§6 F-B3, row B-02): the
  // ["workflows/child", "nested-workflow-unsupported"] row is removed —
  // classification no longer rejects it, so it moved to the accepted table
  // above.
  //
  // P4 FLIP (docs/plans/specs/p4-deletions-closeout.md §3.1, row B-05,
  // F-A1.7): every github-locator-shaped value below used to earn its own
  // remote-action-acquisition-out-of-scope code via semantics.ts's local
  // isGithubLocatorShape override. That override — and the Accepted
  // deviation A-1 slack it existed to preserve — is deleted with the locator
  // grammar; a locator-shaped uses: is now just an unrecognized ref shape,
  // same as any other, so every one of these rows becomes
  // unsupported-uses-target.
  test("rejects every §4.5 non-accepted kind with its listed WorkflowSourceSemanticError code", () => {
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
      // Former locator-shape parity pins (spec Review log, round-1 parity
      // fix; A-1-authorized widenings) — kept as regression coverage for
      // these exact values, now that they all land on the one generic code.
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

  // P4 FLIP (row B-05): a github-locator-shaped value no longer earns its own
  // code/message through the new seam — classifyTargetRef (§4.1) has no
  // locator grammar and semantics.ts's shape override that used to promote
  // it is deleted, so it now falls to the same generic unsupported-uses-target
  // rejection as any other unrecognized shape.
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
// ── import from src/tasks/source-v3.ts (§4.2/§4.3, §9 assertion 2) ─────────

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

describe("import boundary — the workflow uses-classification seam imports nothing from tasks/source-v3 (P1a §4.2/§4.3)", () => {
  // GREEN since P1a's implement step re-pointed uses.ts at
  // classifyTargetRef — see the file docstring for the RED-phase history.
  test("src/workflows/source-semantics.ts imports nothing from tasks/source-v3", () => {
    const specifiers = importedModuleSpecifiers(path.join(ROOT, "src/workflows/source-semantics.ts"));
    expect(specifiers.filter(isSourceV3Specifier)).toEqual([]);
  });
});
