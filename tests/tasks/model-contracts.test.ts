// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Contract for `src/tasks/model/invocation.ts` (spec
 * docs/plans/specs/p1b-model-extraction.md §1.1 D4 module map, §3.1) — the
 * one surviving module of P1b's original three-file `src/tasks/model/**`
 * package.
 *
 * P4 (docs/plans/specs/p4-deletions-closeout.md §3.2.7, F-A2.4) deleted
 * `src/tasks/model/definition.ts` and `src/tasks/model/schedule.ts` along
 * with `src/tasks/source/parse-v3-adapter.ts`, the v3-to-model transition
 * adapter that was their only importer (D11's "transition period" ends with
 * task source v3 itself). This file's `createTaskDefinition`
 * construction/validation blocks and its `TaskScheduleBinding` export-
 * presence check went with them. `TaskInvocation`/`ExecutionProvenanceContext`
 * stay pinned below — `model/invocation.ts` has six live importers untouched
 * by the deletion (spec §3.2.7's disposition table) — and the purity ratchet
 * that used to cover all four now-deleted-or-surviving files from
 * `tests/tasks/parse-v3-adapter.test.ts` moves here, scoped to this one
 * surviving file, so `model/invocation.ts`'s "no fs/db/subprocess/network
 * import, no dynamic import or require" invariant (spec §3.2) keeps real
 * coverage.
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const ROOT = path.resolve(import.meta.dir, "../..");
const MODEL_INVOCATION_FILE = path.join(ROOT, "src/tasks/model/invocation.ts");

// ── invocation.ts — a pure type module (P1b spec §1.1, design decision 1) ──
// ── Nothing runtime to import, so coverage is a text-level export-presence ──
// ── scan rather than a construction test. ───────────────────────────────────

function isExportedDeclaration(node: ts.Node): boolean {
  if (!ts.canHaveModifiers(node)) return false;
  return ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

/** True when `filePath` has a top-level `export interface <name>` or `export type <name>`. */
function exportsTypeNamed(filePath: string, name: string): boolean {
  const source = ts.createSourceFile(filePath, fs.readFileSync(filePath, "utf8"), ts.ScriptTarget.Latest, true);
  let found = false;
  source.forEachChild((node) => {
    if (!isExportedDeclaration(node)) return;
    if (ts.isInterfaceDeclaration(node) && node.name.text === name) found = true;
    if (ts.isTypeAliasDeclaration(node) && node.name.text === name) found = true;
  });
  return found;
}

describe("model/invocation.ts — pure type exports (P1b spec §1.1, design decision 1)", () => {
  test("invocation.ts exports TaskInvocation and the D5 ExecutionProvenanceContext type", () => {
    expect(exportsTypeNamed(MODEL_INVOCATION_FILE, "TaskInvocation")).toBe(true);
    // D5 (p1b-model-extraction.md §1.2/§5.2, verbatim): ExecutionProvenanceContext
    // = Readonly<{eventSource: "user"|"task"; scheduled: boolean}>. The runtime
    // factory lives in run/provenance.ts (Lane C, §5.1) — this file only needs
    // the bare type to exist here.
    expect(exportsTypeNamed(MODEL_INVOCATION_FILE, "ExecutionProvenanceContext")).toBe(true);
  });

  // Not pinned here: TaskInvocation's exact field shape (taskRef/caller/overrides)
  // and the "schedule"/"workflow" caller variants' extra fields, which the spec
  // itself leaves as "..." (unspecified). Doing so would require either a static
  // `import type` against a not-yet-existing file (breaks the tsc-clean
  // convention this file follows, see header) or a locally-declared shape that
  // references nothing in the real module (a vacuous self-check). Once
  // invocation.ts exists and something else in this phase (D5's
  // run/provenance.ts, Lane C) statically imports TaskInvocation/
  // ExecutionProvenanceContext, tsc pins the real shape for free.
});

// ── Purity ratchet (spec §3.2), scoped to the one surviving file — moved ───
// ── here from tests/tasks/parse-v3-adapter.test.ts (deleted, P4 §3.2.7, ────
// ── F-A2.3) when parse-v3-adapter.ts and its two sibling model files were ──
// ── deleted alongside it. Mirrors tests/architecture/diagnostic-codes.test.ts. ──

// Spec §3.2's forbidden list. node:path and node:crypto are explicitly
// PERMITTED ("pure string/hash helpers") and deliberately absent here.
const FORBIDDEN_BARE_SPECIFIERS = new Set([
  "fs",
  "node:fs",
  "child_process",
  "node:child_process",
  "os",
  "node:os",
  "http",
  "node:http",
  "https",
  "node:https",
]);
const FORBIDDEN_PATH_SUBSTRINGS = [
  "/storage/",
  "core/state-db",
  "core/logs-db",
  "/sources/",
  "/integrations/",
  "/llm/",
  "/indexer/",
];

interface ModuleScan {
  readonly staticSpecifiers: readonly string[];
  readonly hasDynamicImportOrRequire: boolean;
}

/** Static import/re-export specifiers (top-level only — imports cannot nest) plus a whole-tree scan for dynamic `import(...)`/`require(...)` (which CAN nest inside a function). */
function scanModule(filePath: string): ModuleScan {
  const source = ts.createSourceFile(filePath, fs.readFileSync(filePath, "utf8"), ts.ScriptTarget.Latest, true);
  const staticSpecifiers: string[] = [];
  let hasDynamicImportOrRequire = false;
  function visit(node: ts.Node): void {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      staticSpecifiers.push(node.moduleSpecifier.text);
    }
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) hasDynamicImportOrRequire = true;
      if (ts.isIdentifier(node.expression) && node.expression.text === "require") hasDynamicImportOrRequire = true;
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return { staticSpecifiers, hasDynamicImportOrRequire };
}

function forbiddenSpecifier(specifier: string): boolean {
  if (FORBIDDEN_BARE_SPECIFIERS.has(specifier)) return true;
  return FORBIDDEN_PATH_SUBSTRINGS.some((needle) => specifier.includes(needle));
}

describe("purity ratchet — src/tasks/model/invocation.ts (P1b spec §3.2)", () => {
  test("imports no fs/db/network/storage/integration module and contains no dynamic import or require", () => {
    const scan = scanModule(MODEL_INVOCATION_FILE);
    const offending = scan.staticSpecifiers.filter(forbiddenSpecifier);
    expect(offending).toEqual([]);
    expect(scan.hasDynamicImportOrRequire).toBe(false);
  });
});
