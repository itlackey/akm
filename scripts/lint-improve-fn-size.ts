// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * God-function size gate for `src/commands/improve/**` (R31, chunk-7 DoD 5).
 *
 * A TS-AST scan flags every function-like node (declarations, expressions,
 * arrows, methods, accessors, constructors — including nested anonymous ones)
 * whose inclusive line span exceeds {@link IMPROVE_FN_SIZE_BAR}.
 *
 * WI-7.8 emptied the original shrink-only decomposition baseline — all 13
 * god-functions measured at the chunk-7 HEAD are decomposed — so the gate is
 * now ABSOLUTE: the paired meta-test
 * (`tests/architecture/improve-fn-size-ratchet.test.ts`) asserts the offender
 * list is EMPTY, with no allowlist to consult. A new function over the bar
 * fails immediately; decompose it into named passes instead of growing it.
 *
 * Pattern: `scripts/lint-tests-isolation.ts` (AST lint gate) +
 * `tests/integration/architecture/agent-runner-seam.test.ts` (TS-AST scan).
 */

import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

/** Inclusive-line-span ceiling. "~200 LOC" (plan DoD 5) with tolerance. */
export const IMPROVE_FN_SIZE_BAR = 220;

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const IMPROVE_ROOT = path.join(REPO_ROOT, "src", "commands", "improve");

/** One over-bar function-like node: a stable id and its inclusive line span. */
export interface ImproveFnOffender {
  /** `<repo-relative path> :: <name>`; anonymous nodes borrow their binding/call context. */
  id: string;
  /** Inclusive line span (`endLine - startLine + 1`). */
  lines: number;
}

function isFunctionLike(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}

/**
 * Derive a stable, human-legible name for a function-like node. Named
 * declarations/methods use their own name; anonymous expressions borrow the
 * variable / property they are bound to, or the call + argument index they are
 * passed to, so the id survives edits elsewhere in the file.
 */
function localName(node: ts.Node, sf: ts.SourceFile): string {
  if (
    (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isFunctionExpression(node)) &&
    node.name
  ) {
    return node.name.getText(sf);
  }
  const parent = node.parent;
  if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.getText(sf);
  if (parent && ts.isPropertyAssignment(parent)) return parent.name.getText(sf);
  if (parent && ts.isPropertyDeclaration(parent) && parent.name) return parent.name.getText(sf);
  if (parent && ts.isCallExpression(parent)) {
    const callee = parent.expression.getText(sf).split("\n")[0].slice(0, 40);
    const idx = parent.arguments.indexOf(node as ts.Expression);
    return `${callee}#arg${idx}`;
  }
  return "«anonymous»";
}

function nearestNamedAncestor(node: ts.Node, sf: ts.SourceFile): string | null {
  let p: ts.Node | undefined = node.parent;
  while (p) {
    if (isFunctionLike(p)) {
      const n = localName(p, sf);
      if (n !== "«anonymous»") return n;
    }
    p = p.parent;
  }
  return null;
}

function* improveTsFiles(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* improveTsFiles(full);
    else if (entry.isFile() && entry.name.endsWith(".ts")) yield full;
  }
}

/**
 * Scan `src/commands/improve/**` and return every function-like node over the
 * bar, sorted by descending size then id (deterministic, worklist-friendly).
 */
export function measureImproveFnOffenders(): ImproveFnOffender[] {
  const offenders: ImproveFnOffender[] = [];
  for (const file of improveTsFiles(IMPROVE_ROOT)) {
    const src = fs.readFileSync(file, "utf8");
    const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const rel = path.relative(REPO_ROOT, file).replace(/\\/g, "/");
    const visit = (node: ts.Node): void => {
      if (isFunctionLike(node)) {
        const start = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line;
        const end = sf.getLineAndCharacterOfPosition(node.getEnd()).line;
        const lines = end - start + 1;
        if (lines > IMPROVE_FN_SIZE_BAR) {
          let name = localName(node, sf);
          if (name === "«anonymous»") {
            const ancestor = nearestNamedAncestor(node, sf);
            name = ancestor ? `${ancestor} > «anonymous»` : "«anonymous»";
          }
          offenders.push({ id: `${rel} :: ${name}`, lines });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  offenders.sort((a, b) => b.lines - a.lines || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return offenders;
}
