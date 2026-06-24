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
 *
 * Every CURRENT offender is grandfathered in {@link ALLOWED_SERVE} /
 * {@link ALLOWED_SPAWN}. A NEW offender (not on the list) fails the lint. As a
 * file is migrated onto the injected `fetch` seam (#664 Seam 1) or relocated to
 * `tests/integration/`, it is removed from the list and {@link UNIT_PURITY_BASELINE}
 * is lowered to match — the list can only ever shrink. The meta-test in
 * `tests/lint-unit-purity-ratchet.test.ts` asserts `combinedAllowlistSize() ===
 * UNIT_PURITY_BASELINE`, so the baseline cannot drift from the live list.
 *
 * NOTE: the third planned rule — `akmIndex({full:true})` inside a `test()` body —
 * lands in Phase 2 (Seam 2 `:memory:` work), not here.
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

/** Unit-tier files that currently stand up `Bun.serve`. Shrink-only. */
const ALLOWED_SERVE = new Set<string>([
  "tests/commands/search.test.ts",
  "tests/commands/show-indexer-parity.test.ts",
  "tests/registry-build-index.test.ts",
  "tests/source-qa-fixes.test.ts",
]);

/** Unit-tier files that currently spawn a real subprocess. Shrink-only. */
const ALLOWED_SPAWN = new Set<string>([
  "tests/commands/distill/distill-cli-flag.test.ts",
  "tests/commands/events.test.ts",
  "tests/commands/improve-cli-flags.test.ts",
  "tests/commands/improve-result-to-file.test.ts",
  "tests/completions.test.ts",
  "tests/contracts/config-schema-drift.test.ts",
  "tests/env.test.ts",
  "tests/file-lock.test.ts",
  "tests/git-source-safety.test.ts",
  "tests/github.test.ts",
  "tests/index-writer-lock.test.ts",
  "tests/registry-build-index.test.ts",
  "tests/save-command.test.ts",
  "tests/source-providers/git.test.ts",
  "tests/tar-utils-scan.test.ts",
  "tests/walker.test.ts",
  "tests/wiki.test.ts",
]);

/**
 * Shrink-only ratchet baseline = combined allowlist size. LOWER this in the same
 * change whenever you remove an entry; never raise it. Meta-test:
 * `tests/lint-unit-purity-ratchet.test.ts`.
 */
export const UNIT_PURITY_BASELINE = 21;

export function combinedAllowlistSize(): number {
  return ALLOWED_SERVE.size + ALLOWED_SPAWN.size;
}

export { ALLOWED_SERVE, ALLOWED_SPAWN };

// ── Detection ────────────────────────────────────────────────────────────────

/** Strip block comments and `//`-line comments so prose mentions don't match. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((l) => l.replace(/\/\/.*$/, ""))
    .join("\n");
}

const SERVE_RE = /\bBun\.serve\s*\(/;
const SPAWN_RE = /\bspawnSync\s*\(|\bBun\.spawn(?:Sync)?\s*\(|from\s+["']node:child_process["']/;

type Rule = "real-serve" | "real-spawn";
interface Violation {
  file: string;
  rule: Rule;
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
    const code = stripComments(fs.readFileSync(file, "utf8"));
    if (SERVE_RE.test(code) && !ALLOWED_SERVE.has(rel)) violations.push({ file: rel, rule: "real-serve" });
    if (SPAWN_RE.test(code) && !ALLOWED_SPAWN.has(rel)) violations.push({ file: rel, rule: "real-spawn" });
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
    const hint =
      v.rule === "real-serve"
        ? "inject an HttpClient (#664 Seam 1) instead of Bun.serve, or move this file to tests/integration/"
        : "use the in-process runCliCapture harness, or move this file to tests/integration/ if a real process boundary is required";
    console.error(`  ${v.file}  [${v.rule}]\n    ${hint}\n`);
  }
  process.exit(1);
}
