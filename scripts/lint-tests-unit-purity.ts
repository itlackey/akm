/**
 * Unit-tier purity lint (#664 Step 0 / C0.2).
 *
 * The unit tier (`test:unit` = `./tests` minus `tests/integration`) must do NO
 * real I/O, so it is safe to run under `bun test --parallel>1` once the seams
 * land (real subprocesses / HTTP servers are the fd churn that triggers the Bun
 * `--isolate` epoll race). This lint is the shrink-only ratchet that drives the
 * unit tier toward that purity:
 *
 *   Rule `real-serve`  — a unit-tier test file stands up `Bun.serve`.
 *   Rule `real-spawn`  — a unit-tier test file spawns a real subprocess
 *                        (`spawnSync` / `Bun.spawn(Sync)` / `node:child_process`).
 *   Rule `full-index-in-test-body` — a unit-tier test calls
 *                        `akmIndex({ full: true })` DIRECTLY inside a `test()` /
 *                        `it()` callback body (an on-disk FTS/vector rebuild,
 *                        ~250ms + fd churn). A call in a `beforeAll`/`beforeEach`
 *                        hook or a named helper function is NOT flagged — the
 *                        rule targets the per-test rebuild that Seam 2's
 *                        `seedEntries(...)` / Seam 3's `:memory:` search replace.
 *
 * Every CURRENT offender is grandfathered in {@link ALLOWED_SERVE} /
 * {@link ALLOWED_SPAWN} / {@link ALLOWED_FULL_INDEX}. A NEW offender (not on the
 * list) fails the lint. As a file is migrated onto the injected `fetch` seam
 * (#664 Seam 1), the `seedEntries`/`:memory:` seam (Seam 2/3), or relocated to
 * `tests/integration/`, it is removed from the list and {@link UNIT_PURITY_BASELINE}
 * is lowered to match — the list can only ever shrink. The meta-test in
 * `tests/lint-unit-purity-ratchet.test.ts` asserts `combinedAllowlistSize() ===
 * UNIT_PURITY_BASELINE`, so the baseline cannot drift from the live list.
 *
 * Comments and `//`-trailing comments are stripped before matching so a mention
 * of `Bun.serve` in prose is not a violation. Scope is the unit glob; files that
 * legitimately MUST spawn (stdin / inherited-fd boundary) stay grandfathered
 * until Phase 4 relocates them to `tests/integration/` (out of unit scope).
 *
 * Usage: bun scripts/lint-tests-unit-purity.ts
 * Exit 0 — clean; 1 — a non-grandfathered violation (or internal error).
 */

import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");

// ── Grandfather allowlists (shrink-only) ─────────────────────────────────────

/**
 * Unit-tier files that currently stand up `Bun.serve`. Shrink-only.
 *
 * EMPTY — every unit-tier `Bun.serve` has been migrated onto an injected
 * `HttpClient` seam (#664 Seam 1) or relocated to `tests/integration/`. A NEW
 * `Bun.serve` in a unit file now fails the lint with no grandfather escape.
 */
const ALLOWED_SERVE = new Set<string>([]);

/** Unit-tier files that currently spawn a real subprocess. Shrink-only. */
const ALLOWED_SPAWN = new Set<string>([
  "tests/commands/distill/distill-cli-flag.test.ts",
  "tests/commands/events.test.ts",
  "tests/commands/improve-cli-flags.test.ts",
  "tests/commands/improve-result-to-file.test.ts",
  "tests/completions.test.ts",
  "tests/contracts/config-schema-drift.test.ts",
  "tests/env.test.ts",
  "tests/wiki.test.ts",
]);

/**
 * Unit-tier files that currently call `akmIndex({ full: true })` directly inside
 * a `test()` / `it()` body (an on-disk FTS/vector rebuild per test). Shrink-only.
 *
 * Each is migrated by replacing the per-test rebuild with Seam 2's
 * `seedEntries(...)` (`:memory:` `entries`) or Seam 3's `searchLocal({ db })` /
 * `searchOnDb` (`:memory:` FTS5+vec), or by hoisting the build into a `beforeAll`
 * fixture, or — when the index build IS the subject (`ensureIndex` staleness, the
 * DB file lock, the indexer/e2e cluster) — relocated to `tests/integration/`.
 */
const ALLOWED_FULL_INDEX = new Set<string>([
  "tests/commands/history.test.ts",
  "tests/commands/improve-ensure-index-first.test.ts",
  "tests/commands/improve-memory.test.ts",
  "tests/commands/improve/improve-dry-run-side-effects.test.ts",
  "tests/commands/improve/improve-sync.test.ts",
  "tests/commands/scope-flags.test.ts",
  "tests/env.test.ts",
  "tests/index-clean.test.ts",
  "tests/issue-36-repro.test.ts",
  "tests/secret-indexing.test.ts",
  "tests/semantic-search-e2e.test.ts",
  "tests/session-indexing.test.ts",
  "tests/source.test.ts",
  "tests/wiki.test.ts",
  "tests/workflows/indexer-rejection.test.ts",
]);

/**
 * Shrink-only ratchet baseline = combined allowlist size. LOWER this in the same
 * change whenever you remove an entry; never raise it. Meta-test:
 * `tests/lint-unit-purity-ratchet.test.ts`.
 */
export const UNIT_PURITY_BASELINE = 23;

export function combinedAllowlistSize(): number {
  return ALLOWED_SERVE.size + ALLOWED_SPAWN.size + ALLOWED_FULL_INDEX.size;
}

export { ALLOWED_SERVE, ALLOWED_SPAWN, ALLOWED_FULL_INDEX };

// ── Detection ────────────────────────────────────────────────────────────────

/** Strip block comments and `//`-line comments so prose mentions don't match. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((l) => l.replace(/\/\/.*$/, ""))
    .join("\n");
}

/**
 * Replace comment AND string/template-literal CONTENTS with spaces (preserving
 * length + newlines) so that braces, keywords, and `akmIndex(...)` text appearing
 * inside a comment or a string (e.g. a `test("... akmIndex({ full: true }) ...")`
 * name) are never parsed as code. Needed by the `full-index-in-test-body`
 * structural scanner, whose brace-depth + callback-frame tracking would
 * otherwise be thrown off by a `{` inside a test-name string.
 */
function blankNonCode(src: string): string {
  const out = src.split("");
  const n = src.length;
  type State = "code" | "line" | "block" | "sq" | "dq" | "tpl";
  let st: State = "code";
  let i = 0;
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (st === "code") {
      if (c === "/" && c2 === "/") {
        st = "line";
        out[i] = " ";
        out[i + 1] = " ";
        i += 2;
        continue;
      }
      if (c === "/" && c2 === "*") {
        st = "block";
        out[i] = " ";
        out[i + 1] = " ";
        i += 2;
        continue;
      }
      if (c === "'") st = "sq";
      else if (c === '"') st = "dq";
      else if (c === "`") st = "tpl";
      i++;
      continue;
    }
    if (st === "line") {
      if (c === "\n") st = "code";
      else out[i] = " ";
      i++;
      continue;
    }
    if (st === "block") {
      if (c === "*" && c2 === "/") {
        out[i] = " ";
        out[i + 1] = " ";
        st = "code";
        i += 2;
        continue;
      }
      if (c !== "\n") out[i] = " ";
      i++;
      continue;
    }
    // string / template states: blank contents, honor escapes, exit on the quote.
    if (c === "\\") {
      out[i] = " ";
      if (i + 1 < n) out[i + 1] = " ";
      i += 2;
      continue;
    }
    if ((st === "sq" && c === "'") || (st === "dq" && c === '"') || (st === "tpl" && c === "`")) {
      st = "code";
      i++;
      continue;
    }
    if (c !== "\n") out[i] = " ";
    i++;
  }
  return out.join("");
}

const SERVE_RE = /\bBun\.serve\s*\(/;
const SPAWN_RE = /\bspawnSync\s*\(|\bBun\.spawn(?:Sync)?\s*\(|from\s+["']node:child_process["']/;

type Rule = "real-serve" | "real-spawn" | "full-index-in-test-body";
interface Violation {
  file: string;
  rule: Rule;
}

type FrameKind = "test" | "hook" | "other";

/**
 * True iff the file calls `akmIndex({ ... full: true ... })` directly inside a
 * `test()` / `it()` callback body. A call in a `beforeAll`/`beforeEach`/
 * `afterAll`/`afterEach` hook, a `describe` block top level, or a named helper
 * `function` is NOT a hit — those are the sanctioned places to build once.
 *
 * Implementation: blank out comments + string literals, then forward-scan,
 * tracking brace depth and a stack of callback frames. Each `test(`/`it(` (or a
 * hook / `describe`) introducer claims the NEXT `{` as its frame. A matched
 * `akmIndex(... full: true ...)` is a hit when the innermost enclosing
 * test-or-hook frame is a `test`/`it`.
 */
function hasFullIndexInTestBody(src: string): boolean {
  const code = blankNonCode(src);
  const introRe = /\b(test|it|beforeAll|beforeEach|afterAll|afterEach|describe)\b\s*\(/g;
  const intros: Array<{ idx: number; kind: FrameKind }> = [];
  let im: RegExpExecArray | null = introRe.exec(code);
  while (im !== null) {
    const name = im[1];
    const kind: FrameKind = name === "test" || name === "it" ? "test" : name === "describe" ? "other" : "hook";
    intros.push({ idx: im.index, kind });
    im = introRe.exec(code);
  }

  const stack: Array<{ kind: FrameKind; brace: number }> = [];
  let brace = 0;
  let ptr = 0;
  let pending: FrameKind | null = null;

  for (let i = 0; i < code.length; i++) {
    while (ptr < intros.length && intros[ptr].idx <= i) {
      pending = intros[ptr].kind;
      ptr++;
    }
    const ch = code[i];
    if (ch === "{") {
      stack.push({ kind: pending ?? "other", brace: brace + 1 });
      pending = null;
      brace++;
    } else if (ch === "}") {
      if (stack.length > 0 && stack[stack.length - 1].brace === brace) stack.pop();
      brace--;
    } else if (code.startsWith("akmIndex", i) && /\W/.test(code[i - 1] ?? " ")) {
      let j = i + "akmIndex".length;
      while (j < code.length && /\s/.test(code[j])) j++;
      if (code[j] !== "(") continue;
      let depth = 0;
      let k = j;
      for (; k < code.length; k++) {
        if (code[k] === "(") depth++;
        else if (code[k] === ")") {
          depth--;
          if (depth === 0) {
            k++;
            break;
          }
        }
      }
      if (!/full\s*:\s*true/.test(code.slice(j, k))) continue;
      for (let s = stack.length - 1; s >= 0; s--) {
        const kind = stack[s].kind;
        if (kind === "test") return true;
        if (kind === "hook") break; // innermost test/hook frame is a hook → not a hit
      }
    }
  }
  return false;
}

/** Collect *.test.ts under tests/, EXCLUDING tests/integration (the unit glob). */
function collectUnitTestFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (["node_modules", "dist", ".git"].includes(entry.name)) continue;
      if (path.resolve(full) === path.resolve(repoRoot, "tests", "integration")) continue;
      out.push(...collectUnitTestFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

export function lintAllUnitFiles(): Violation[] {
  const violations: Violation[] = [];
  for (const file of collectUnitTestFiles(path.join(repoRoot, "tests"))) {
    const rel = path.relative(repoRoot, file).replace(/\\/g, "/");
    const raw = fs.readFileSync(file, "utf8");
    const code = stripComments(raw);
    if (SERVE_RE.test(code) && !ALLOWED_SERVE.has(rel)) violations.push({ file: rel, rule: "real-serve" });
    if (SPAWN_RE.test(code) && !ALLOWED_SPAWN.has(rel)) violations.push({ file: rel, rule: "real-spawn" });
    // The structural scanner does its own comment+string blanking, so feed it raw.
    if (!ALLOWED_FULL_INDEX.has(rel) && hasFullIndexInTestBody(raw)) {
      violations.push({ file: rel, rule: "full-index-in-test-body" });
    }
  }
  return violations;
}

// ── Main ─────────────────────────────────────────────────────────────────────

if (import.meta.main) {
  const violations = lintAllUnitFiles();
  if (violations.length === 0) {
    console.log(
      `lint-tests-unit-purity: OK — no new unit-tier impurity (${combinedAllowlistSize()} grandfathered, baseline ${UNIT_PURITY_BASELINE})`,
    );
    process.exit(0);
  }
  console.error(`lint-tests-unit-purity: ${violations.length} new violation(s):\n`);
  for (const v of violations) {
    let hint: string;
    if (v.rule === "real-serve") {
      hint = "inject an HttpClient (#664 Seam 1) instead of Bun.serve, or move this file to tests/integration/";
    } else if (v.rule === "real-spawn") {
      hint =
        "use the in-process runCliCapture harness, or move this file to tests/integration/ if a real process boundary is required";
    } else {
      hint =
        "replace the per-test akmIndex({ full: true }) with seedEntries(...) (#664 Seam 2) or searchLocal({ db: openDatabase(\":memory:\") }) (Seam 3), hoist it into a beforeAll fixture, or move this file to tests/integration/ if the index build IS the subject";
    }
    console.error(`  ${v.file}  [${v.rule}]\n    ${hint}\n`);
  }
  process.exit(1);
}
