// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Shared TS-AST function-size measurement core.
 *
 * Consumed by two gates with different semantics:
 *   - `scripts/lint-improve-fn-size.ts` — the ABSOLUTE chunk-7 gate over
 *     `src/commands/improve/**` (empty offender list, no allowlist).
 *   - `scripts/lint-src-fn-size.ts` — the repo-wide SHRINK-TOLERANT ratchet
 *     over the rest of `src/**` (no new offenders, no growth; shrinking is
 *     silently allowed).
 *
 * The measurement itself is identical for both: flag every function-like node
 * (declarations, expressions, arrows, methods, accessors, constructors —
 * including nested anonymous ones) whose inclusive line span exceeds the bar.
 */

import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

export const REPO_ROOT = path.resolve(import.meta.dir, "..");

/** One over-bar function-like node: a stable id and its inclusive line span. */
export interface FnOffender {
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
  if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isFunctionExpression(node)) && node.name) {
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

export function* walkTsFiles(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walkTsFiles(full);
    else if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))) yield full;
  }
}

/**
 * Scan every `.ts` file under `rootDir` (skipping any file whose repo-relative
 * POSIX path starts with an `exclude` prefix) and return each function-like
 * node whose inclusive line span exceeds `bar`, sorted by descending size then
 * id (deterministic, worklist-friendly).
 */
export function measureFnOffenders(rootDir: string, bar: number, exclude: readonly string[] = []): FnOffender[] {
  const offenders: FnOffender[] = [];
  for (const file of walkTsFiles(rootDir)) {
    const rel = path.relative(REPO_ROOT, file).replace(/\\/g, "/");
    if (exclude.some((prefix) => rel.startsWith(prefix))) continue;
    const src = fs.readFileSync(file, "utf8");
    const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const visit = (node: ts.Node): void => {
      if (isFunctionLike(node)) {
        const start = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line;
        const end = sf.getLineAndCharacterOfPosition(node.getEnd()).line;
        const lines = end - start + 1;
        if (lines > bar) {
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
