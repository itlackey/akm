// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * lint-process-argv.ts
 *
 * Enforces the single-argv-parse boundary (plan §10.7, chunk-9 WI-9.9):
 * `process.argv` may ONLY be read in `src/cli.ts` (the entry point, which
 * mints the {@link ParsedInvocation} singleton) and `src/cli/invocation.ts`
 * (the module that defines it — see its module docstring for the singleton /
 * lazy-fallback design). Every other `src/**\/*.ts` file must go through
 * `getParsedInvocation()` instead of re-scanning `process.argv` itself.
 *
 * ABSOLUTE gate (no baseline): at WI-9.9 landing every out-of-boundary
 * `process.argv` read site in `src/` was converted, so this is armed as a
 * flat allowlist, not a shrink-only ratchet like `lint-import-cycles.ts` /
 * `lint-src-fn-size.ts`. A new violation must be fixed, not baselined.
 *
 * One narrow, file-scoped exception: `src/runtime.ts`'s `process.argv[1]`
 * resolves the OS-level script path for Node's main-module detection
 * (mirrors `Bun.main`) — a different semantic domain than the CLI
 * flag/positional/`--`-passthrough parsing `ParsedInvocation` normalizes, and
 * it runs at module-eval time before any command dispatch. Routing it through
 * `ParsedInvocation` would be a category error, not a fix, so it is exempted
 * by matching the exact `process.argv[1]` indexed-access form — narrow enough
 * that a genuine NEW flag-parsing use of `process.argv` anywhere else in that
 * file (or any other) still fails the gate.
 *
 * `scripts/**` and `tests/**` are out of scope: `scripts/**` is standalone
 * CLI tooling with its own argv (akm-eval, migration one-offs, other lint
 * scripts) and never goes through the `akm` CLI's citty command tree;
 * `tests/_preload.ts` and the in-process CLI test harness
 * (`tests/_helpers/cli.ts`) legitimately mutate `process.argv` to drive
 * `bun:test` runs — see that file's docstring.
 *
 * Comments and string literals are stripped before matching (mirrors
 * `lint-runtime-boundary.ts`), so prose that merely *mentions* `process.argv`
 * (e.g. this file's own docstring, or `output/context.ts`'s module comment)
 * does NOT trip the guard — only real code does.
 *
 * Exit codes:
 *   0 — no violations
 *   1 — violations found
 *
 * Usage:
 *   bun scripts/lint-process-argv.ts
 */

import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const SRC_ROOT = path.join(REPO_ROOT, "src");

/** The ONLY files permitted to read `process.argv`. Repo-relative, POSIX separators. */
const ALLOWED_FILES: ReadonlySet<string> = new Set(["src/cli.ts", "src/cli/invocation.ts"]);

const PROCESS_ARGV_PATTERN = /\bprocess\.argv\b/;

/** The single sanctioned non-flag-parsing exception — see module docstring. */
function isAllowedRuntimeMainPathAccess(file: string, line: string): boolean {
  return file === "src/runtime.ts" && /process\.argv\[1\]/.test(line);
}

/** Recursively collect .ts/.tsx files under a directory. */
function collectTs(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "dist" || entry.name === "schemas") continue;
      results.push(...collectTs(full));
    } else if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) && !entry.name.endsWith(".d.ts")) {
      results.push(full);
    }
  }
  return results;
}

/**
 * Strip line comments, block comments, and string/template literal contents
 * (replaced with spaces to preserve line numbers), so prose mentioning
 * `process.argv` is not matched — only real code is.
 */
function stripCommentsAndStrings(src: string): string {
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
        out += " ";
        i += 1;
      } else if (c === '"') {
        state = "dq";
        out += " ";
        i += 1;
      } else if (c === "`") {
        state = "tpl";
        out += " ";
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
        out += "  ";
        i += 2;
      } else if (c === quote) {
        state = "code";
        out += " ";
        i += 1;
      } else {
        out += c === "\n" ? "\n" : " ";
        i += 1;
      }
    }
  }
  return out;
}

export interface ProcessArgvViolation {
  file: string;
  line: number;
  snippet: string;
}

function lintFile(filePath: string): ProcessArgvViolation[] {
  const rel = path.relative(REPO_ROOT, filePath).replace(/\\/g, "/");
  if (ALLOWED_FILES.has(rel)) return [];

  const raw = fs.readFileSync(filePath, "utf-8");
  const stripped = stripCommentsAndStrings(raw).split("\n");
  const rawLines = raw.split("\n");

  const violations: ProcessArgvViolation[] = [];
  for (let i = 0; i < stripped.length; i++) {
    const subject = stripped[i];
    if (subject === undefined || !PROCESS_ARGV_PATTERN.test(subject)) continue;
    if (isAllowedRuntimeMainPathAccess(rel, subject)) continue;
    violations.push({ file: rel, line: i + 1, snippet: rawLines[i].trim() });
  }
  return violations;
}

/** Lint every src file and return all violations (also usable programmatically). */
export function lintProcessArgv(): ProcessArgvViolation[] {
  const out: ProcessArgvViolation[] = [];
  for (const f of collectTs(SRC_ROOT)) out.push(...lintFile(f));
  return out;
}

export { ALLOWED_FILES };

if (import.meta.main) {
  const violations = lintProcessArgv();

  if (violations.length === 0) {
    console.log(
      `lint-process-argv: OK — process.argv is confined to ${[...ALLOWED_FILES].join(" and ")} (plus the runtime.ts main-path exception).`,
    );
    process.exit(0);
  }

  console.error(`lint-process-argv: ${violations.length} violation(s) — process.argv read outside the allowed boundary\n`);
  console.error(
    `Only ${[...ALLOWED_FILES].join(" and ")} may read process.argv directly. Use getParsedInvocation() from src/cli/invocation.ts instead.\n`,
  );
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}`);
    console.error(`    > ${v.snippet}`);
    console.error("");
  }
  process.exit(1);
}
