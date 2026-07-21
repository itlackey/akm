// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * lint-repository-sql.ts  (X4 — architecture-refactor-plan)
 *
 * Architectural fitness function for the "repository owns the SQL" boundary.
 *
 * The registry and workflow-runtime subsystems must reach persistent storage
 * ONLY through `src/storage/repositories/**` — never by importing a DB-owner
 * module (`indexer/db`, `core/state-db`, `core/state/*`) or opening a database
 * directly. Both subsystems previously bypassed repositories to hit index.db
 * directly (registry providers `static-index.ts`/`skills-sh.ts`, and
 * `workflows/runtime/runs.ts`), and the registry path has a documented
 * cache-correctness regression history. R3 (registry cache → repository) and
 * D5 (WorkflowDocuments reader) removed those inversions; this guard ratchets
 * them shut so they cannot regrow.
 *
 * Scope is intentionally NARROW. Raw SQL legitimately lives in many other
 * modules (health, indexer, usage-telemetry, the improve read-side, …) and the
 * codebase does NOT funnel all SQL through one repository directory — so a
 * blanket "no SQL outside repositories" rule would be a large status-quo
 * allowlist, not a real boundary. This guard enforces only the boundary that
 * was actually inverted and actually regressed.
 *
 * Comments and string literals are stripped before matching, so prose that
 * merely mentions these names does not trip the guard — only real code does.
 *
 * Exit codes: 0 — clean; 1 — violations (or internal error).
 * Usage: bun scripts/lint-repository-sql.ts
 */

import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");
const srcDir = path.join(repoRoot, "src");

/**
 * Subsystems that must use repositories rather than DB internals. POSIX-relative
 * directory prefixes. Add a new boundary here only when its inversions are
 * already cleared (the guard must stay at 0 violations).
 */
const GUARDED_PREFIXES: readonly string[] = ["src/registry/", "src/workflows/runtime/"];

interface Rule {
  id: string;
  pattern: RegExp;
  message: string;
  /** Match against string-preserving text (for import-specifier rules). */
  keepStrings?: boolean;
}

const RULES: readonly Rule[] = [
  {
    id: "db-owner-import",
    // import ... from "…/indexer/db…" | "…/core/state-db" | "…/core/state/…"
    pattern: /from\s*["'][^"']*(?:indexer\/db|core\/state-db|core\/state\/)[^"']*["']/,
    message:
      "imports a DB-owner module directly — go through src/storage/repositories/** instead (repository-owns-SQL boundary)",
    keepStrings: true,
  },
  {
    id: "db-open-call",
    pattern:
      /\b(?:openExistingDatabase|openIndexDatabase|openStateDatabase|openManagedDatabase)\s*\(|\bnew\s+Database\s*\(/,
    message:
      "opens a database directly — registry/workflow-runtime code must query through a repository in src/storage/repositories/**",
  },
];

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

/** Strip comments + (optionally) string contents, preserving line numbers. */
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
      } else out += " ";
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
    } else {
      const quote = state === "sq" ? "'" : state === "dq" ? '"' : "`";
      if (c === "\\") {
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

/** Pure matcher: lint one file's content given its repo-relative POSIX path. */
export function lintContent(rel: string, raw: string): Violation[] {
  if (!GUARDED_PREFIXES.some((p) => rel.startsWith(p))) return [];

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

function lintFile(filePath: string): Violation[] {
  const rel = path.relative(repoRoot, filePath).replace(/\\/g, "/");
  return lintContent(rel, fs.readFileSync(filePath, "utf-8"));
}

export function lintRepositorySql(): Violation[] {
  const out: Violation[] = [];
  for (const f of collectTs(srcDir)) out.push(...lintFile(f));
  return out;
}

export { GUARDED_PREFIXES, lintFile };

if (import.meta.main) {
  const violations = lintRepositorySql();
  if (violations.length === 0) {
    console.log(
      "lint-repository-sql: OK — registry + workflow-runtime reach storage only through src/storage/repositories",
    );
    process.exit(0);
  }
  console.error(
    `lint-repository-sql: ${violations.length} violation(s) — DB internals reached outside the repository boundary\n`,
  );
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  [${v.ruleId}]`);
    console.error(`    ${v.message}`);
    console.error(`    > ${v.snippet}`);
    console.error("");
  }
  process.exit(1);
}
