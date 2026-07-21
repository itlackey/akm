// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * lint-runtime-boundary.ts
 *
 * Enforces the runtime boundary (#560, coding-constitution §25/§33): the
 * SQLite drivers (`bun:sqlite`, `better-sqlite3`) and the Bun-specific runtime
 * primitives (`Bun.*`, `import.meta.dir`) may ONLY appear in the two boundary
 * files:
 *
 *   - src/storage/database.ts  (SQLite driver boundary)
 *   - src/runtime.ts           (Bun.* / import.meta.dir boundary)
 *
 * Every other src/**\/*.ts file must go through those modules' named exports.
 * This guard stops the sprawl that the runtime-boundary refactor removed from
 * regrowing: a stray `Bun.spawn`, `import.meta.dir`, or `import 'bun:sqlite'`
 * outside the boundary fails the build.
 *
 * Comments and string literals are stripped before matching, so prose that
 * merely *mentions* these primitives (e.g. a doc comment explaining the
 * boundary) does NOT trip the guard — only real code does.
 *
 * Exit codes:
 *   0 — no violations
 *   1 — violations found (or internal error)
 *
 * Usage:
 *   bun scripts/lint-runtime-boundary.ts
 */

import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");
const srcDir = path.join(repoRoot, "src");

/**
 * The ONLY files permitted to touch the runtime primitives. Relative to the
 * repo root, POSIX separators. This allowlist must NOT grow.
 */
const BOUNDARY_FILES: ReadonlySet<string> = new Set(["src/storage/database.ts", "src/runtime.ts"]);

interface Rule {
  id: string;
  /** Matches real (comment-stripped) code that uses a forbidden primitive. */
  pattern: RegExp;
  message: string;
  /**
   * When true, the rule is matched against text with string literals PRESERVED
   * (comments still stripped) — required for module-specifier rules whose token
   * lives inside the import string (e.g. `"bun:sqlite"`). When false/omitted,
   * string contents are stripped too, so prose in template/string literals can't
   * trip the namespace rules.
   */
  keepStrings?: boolean;
}

const RULES: readonly Rule[] = [
  {
    id: "sqlite-driver-import",
    // import ... from 'bun:sqlite' | "better-sqlite3", or require('better-sqlite3')
    pattern: /(?:from\s*|require\s*\(\s*)["'](?:bun:sqlite|better-sqlite3)["']/,
    message:
      "imports a SQLite driver directly — import { openDatabase, type Database } from src/storage/database instead",
    keepStrings: true,
  },
  {
    id: "bun-namespace",
    // Any Bun.<member> reference: Bun.spawn, Bun.write, Bun.main, etc.
    pattern: /\bBun\.[A-Za-z_$]/,
    message: "references the Bun.* global — use the named exports in src/runtime.ts instead",
  },
  {
    id: "import-meta-dir",
    pattern: /\bimport\.meta\.dir\b/,
    message: "uses import.meta.dir — use getDirname(import.meta.url) from src/runtime.ts instead",
  },
];

/** Recursively collect non-declaration .ts files under a directory. */
function collectTs(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "dist" || entry.name === "schemas") continue;
      results.push(...collectTs(full));
    } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
      results.push(full);
    }
  }
  return results;
}

/**
 * Strip line comments, block comments, and string/template literal *contents*
 * so that prose mentioning a forbidden primitive is not matched — only real
 * code is. Replaces stripped regions with spaces to preserve line numbers.
 */
function stripCommentsAndStrings(src: string, keepStrings = false): string {
  let out = "";
  let i = 0;
  const n = src.length;
  type State = "code" | "line" | "block" | "sq" | "dq" | "tpl";
  let state: State = "code";

  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (state === "code") {
      if (c === "/" && c2 === "/") {
        state = "line";
        out += "  ";
        i += 2;
      } else if (c === "/" && c2 === "*") {
        state = "block";
        out += "  ";
        i += 2;
      } else if (c === "'") {
        state = "sq";
        out += keepStrings ? c : " ";
        i += 1;
      } else if (c === '"') {
        state = "dq";
        out += keepStrings ? c : " ";
        i += 1;
      } else if (c === "`") {
        state = "tpl";
        out += keepStrings ? c : " ";
        i += 1;
      } else {
        out += c;
        i += 1;
      }
    } else if (state === "line") {
      if (c === "\n") {
        state = "code";
        out += "\n";
      } else {
        out += " ";
      }
      i += 1;
    } else if (state === "block") {
      if (c === "*" && c2 === "/") {
        state = "code";
        out += "  ";
        i += 2;
      } else {
        out += c === "\n" ? "\n" : " ";
        i += 1;
      }
    } else if (state === "sq" || state === "dq" || state === "tpl") {
      const quote = state === "sq" ? "'" : state === "dq" ? '"' : "`";
      if (c === "\\") {
        // Escape sequence: preserve both chars when keeping strings, else blank.
        out += keepStrings ? src.slice(i, i + 2) : "  ";
        i += 2;
      } else if (c === quote) {
        state = "code";
        out += keepStrings ? c : " ";
        i += 1;
      } else {
        out += keepStrings || c === "\n" ? c : " ";
        i += 1;
      }
    }
  }
  return out;
}

interface Violation {
  file: string;
  line: number;
  ruleId: string;
  message: string;
  snippet: string;
}

function lintFile(filePath: string): Violation[] {
  const rel = path.relative(repoRoot, filePath).replace(/\\/g, "/");
  if (BOUNDARY_FILES.has(rel)) return [];

  const raw = fs.readFileSync(filePath, "utf-8");
  // Two views: comments+strings stripped (for namespace rules), and
  // comments-only stripped with strings preserved (for import-specifier rules).
  const noStrings = stripCommentsAndStrings(raw, false).split("\n");
  const withStrings = stripCommentsAndStrings(raw, true).split("\n");
  const rawLines = raw.split("\n");

  const violations: Violation[] = [];
  for (let i = 0; i < rawLines.length; i++) {
    for (const rule of RULES) {
      const subject = rule.keepStrings ? withStrings[i] : noStrings[i];
      if (subject !== undefined && rule.pattern.test(subject)) {
        violations.push({
          file: rel,
          line: i + 1,
          ruleId: rule.id,
          message: rule.message,
          snippet: rawLines[i]!.trim(),
        });
      }
    }
  }
  return violations;
}

/** Lint every src file and return all violations (also usable programmatically). */
export function lintRuntimeBoundary(): Violation[] {
  const out: Violation[] = [];
  for (const f of collectTs(srcDir)) out.push(...lintFile(f));
  return out;
}

export { BOUNDARY_FILES, lintFile };

if (import.meta.main) {
  const violations = lintRuntimeBoundary();

  if (violations.length === 0) {
    console.log(
      "lint-runtime-boundary: OK — runtime primitives are confined to src/storage/database.ts and src/runtime.ts",
    );
    process.exit(0);
  }

  console.error(
    `lint-runtime-boundary: ${violations.length} violation(s) — runtime primitives leaked outside the boundary\n`,
  );
  console.error(
    "Only src/storage/database.ts and src/runtime.ts may touch bun:sqlite / better-sqlite3 / Bun.* / import.meta.dir.\n",
  );
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  [${v.ruleId}]`);
    console.error(`    ${v.message}`);
    console.error(`    > ${v.snippet}`);
    console.error("");
  }
  process.exit(1);
}
