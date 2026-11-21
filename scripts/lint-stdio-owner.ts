// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * lint-stdio-owner.ts
 *
 * Fails when `process.stdout`, `process.stderr` or `process.stdin` is named anywhere in `src/` outside
 * `src/core/stdio.ts`.
 *
 * On Bun the first read of any property of those streams, `isTTY` included, puts an inherited pipe or socket
 * into non-blocking mode: a program akm runs loses output written to a full pipe, and the caller's pipe stays
 * non-blocking after akm exits. `src/core/stdio.ts` is the one place that touches the streams, and only when akm
 * writes; everything else asks it (`stdout()`, `stderr()`, `stdin()`, `isTerminal(fd)`).
 *
 * The check reads the syntax tree, so comments and strings never match, and `process.stdout`,
 * `process["stdout"]` and `const { stdout } = process` all do.
 *
 * Exit codes: 0 no violations, 1 violations found.
 *
 * Usage: bun scripts/lint-stdio-owner.ts
 */

import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const repoRoot = path.resolve(import.meta.dir, "..");
const srcDir = path.join(repoRoot, "src");
const owner = path.join(srcDir, "core", "stdio.ts");
const STREAMS = new Set(["stdout", "stderr", "stdin"]);

function collectTs(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) results.push(...collectTs(full));
    else if (entry.isFile() && /\.(ts|tsx|mts|cts)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
      results.push(full);
    }
  }
  return results;
}

const isProcess = (node: ts.Node): boolean => ts.isIdentifier(node) && node.text === "process";

/** The stream a node reaches through `process`, or undefined. */
function streamOf(node: ts.Node): string | undefined {
  if (ts.isPropertyAccessExpression(node) && isProcess(node.expression) && STREAMS.has(node.name.text)) {
    return node.name.text;
  }
  if (
    ts.isElementAccessExpression(node) &&
    isProcess(node.expression) &&
    ts.isStringLiteralLike(node.argumentExpression) &&
    STREAMS.has(node.argumentExpression.text)
  ) {
    return node.argumentExpression.text;
  }
  if (ts.isVariableDeclaration(node) && node.initializer && isProcess(node.initializer)) {
    if (ts.isObjectBindingPattern(node.name)) {
      for (const el of node.name.elements) {
        const key = el.propertyName ?? el.name;
        if (ts.isIdentifier(key) && STREAMS.has(key.text)) return key.text;
      }
    }
  }
  return undefined;
}

const violations: string[] = [];
for (const file of collectTs(srcDir)) {
  if (file === owner) continue;
  const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const visit = (node: ts.Node): void => {
    const stream = streamOf(node);
    if (stream) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
      violations.push(`${path.relative(repoRoot, file)}:${line + 1}: process.${stream}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

if (violations.length > 0) {
  console.error("lint-stdio-owner: src/ outside src/core/stdio.ts must not touch the process streams.");
  console.error("Use stdout(), stderr(), stdin() or isTerminal(fd) from src/core/stdio.ts.");
  for (const v of violations) console.error(`  ${v}`);
  process.exit(1);
}
console.log("lint-stdio-owner: ok");
