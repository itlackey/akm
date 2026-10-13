// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The target-ref classifier seam (`src/execution/target-ref.ts`): the
 * `classifyTargetRef` accept/reject matrix, plus an import boundary pinning that
 * the workflow semantics module imports nothing from `tasks/source-v3`.
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { UsageError } from "../../src/core/errors";
import type { TargetRefKind } from "../../src/execution/target-ref";

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
