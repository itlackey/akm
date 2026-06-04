/**
 * Lint rules for deterministic, isolated tests.
 *
 * Rule 1 (mkdtempSync + env): flag test files that use raw `mkdtempSync`
 * **and** also set AKM-specific env vars in the same file. Such a file should
 * use the `tests/_helpers/sandbox.ts` helpers instead. Raw `mkdtempSync` for
 * generic fixture data (not an AKM path) is fine and is intentionally NOT
 * flagged.
 *
 * Rule 2 (unguarded env assignment): flag any test file that *assigns* an
 * AKM-/XDG-/HOME env var (`process.env.AKM_STASH_DIR = …`) without routing
 * through a sanctioned restoring wrapper (`withEnv` / `sandbox*` helpers).
 * Under `bun test` the whole suite shares ONE `process.env`; a stray
 * assignment that survives past a yield point (or a forgotten restore) silently
 * pollutes every other file's tests. This is the CLASS behind the two
 * release/0.8.0 flakes (scoring-pipeline Issue #14 read the wrong DB when a
 * sibling mutated XDG_DATA_HOME). Rule 1's `mkdtempSync` precondition meant
 * files that set env from a *literal* path or a *helper* temp dir were never
 * even considered — Rule 2 closes that blind spot. Files that legitimately set
 * literal sentinel paths for pure path-resolution tests (and restore via their
 * own save/restore wrapper) are listed in ENV_ASSIGN_ALLOWED with a reason.
 *
 * Rule 3 (elapsed-time assertion): flag `expect(<elapsed|durationMs|…>)` upper-
 * or lower-bound comparisons against a wall-clock delta (`Date.now() - start`).
 * These race the scheduler under load — assert the *observable result* (the
 * timeout fired, the reason is "timeout") and/or drive time with fake timers
 * instead. `toBeGreaterThanOrEqual(0)` and exact `toBe(<n>)` against an injected
 * timestamp are deterministic and NOT flagged.
 *
 * Exit codes:
 *   0 — no violations
 *   1 — violations found (or internal error)
 *
 * Usage:
 *   bun scripts/lint-tests-isolation.ts [--fix-hints]
 *
 * The `--fix-hints` flag prints a suggested import line per file.
 */

import fs from "node:fs";
import path from "node:path";

// ── Configuration ────────────────────────────────────────────────────────────

/** AKM-specific env vars that should be managed via sandbox helpers. */
const AKM_ENV_VARS: readonly string[] = [
  "AKM_STASH_DIR",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "HOME",
];

/**
 * Rule 2 exemptions: files that assign AKM/XDG/HOME env vars without going
 * through the sandbox helpers, but do so SAFELY (own save/restore wrapper,
 * synchronous tests, no real I/O). Each entry must be justified. The list may
 * only shrink as files migrate to the sanctioned helpers.
 */
const ENV_ASSIGN_ALLOWED = new Set<string>([
  // paths.test.ts: pure path-resolution unit tests. They set LITERAL sentinel
  // paths (e.g. "/test-xdg", "/home/user") to exercise getConfigDir/getDbPath
  // env precedence — real sandbox temp dirs would defeat the purpose. A
  // module-level saveEnv()/afterEach(restoreEnv) snapshots and restores every
  // env key; tests are synchronous so nothing leaks across a yield point.
  "tests/paths.test.ts",

  // registry-resolve.test.ts: sets AKM_NPM_REGISTRY to literal URLs to test
  // registry URL resolution precedence. beforeEach deletes it, afterEach
  // restores the captured original. Synchronous, no real I/O.
  "tests/registry-resolve.test.ts",

  // fixtures/stashes/load.test.ts: sets AKM_STASH_DIR to a sentinel string to
  // verify the fixture loader's env handling; captures and restores the prior
  // value in afterEach (both branches). No temp dir, no leak.
  "tests/fixtures/stashes/load.test.ts",
]);

/**
 * Files that are KNOWN good exemptions.  Each entry must be justified.
 * This list must only shrink over time as files are migrated.
 */
const ALLOWED_FILES = new Set<string>([
  // e2e.test.ts: extremely complex multi-scenario test; full migration is
  // deferred — the env vars are set via per-subprocess env objects, not
  // process.env mutation in the caller process.
  "tests/e2e.test.ts",
  "tests/integration/e2e.test.ts",

  // workflow-path-escape.test.ts: sets AKM_STASH_DIR per-test for symlink
  // path testing; each test creates a specific stash/symlink pair and the
  // afterEach correctly deletes all env vars. Per-test pattern, not beforeEach.
  "tests/workflow-path-escape.test.ts",

  // tests/_helpers/sandbox.ts itself: defines the helpers.
  "tests/_helpers/sandbox.ts",

  // source-clone.test.ts: one test overrides AKM_STASH_DIR to a nonexistent
  // path to verify --dest works without a working stash. The assignment is a
  // deliberate semantics override inside the test body; beforeEach/afterEach
  // still use the sandbox helper for all other isolation.
  "tests/source-clone.test.ts",

  // indexer.test.ts: multi-stash tests set AKM_STASH_DIR = primaryStash
  // inside test bodies to configure cross-stash scenarios. This is intentional
  // test-body logic (not isolation boilerplate); the sandbox handles restore
  // via afterEach. Only the multi-stash describe blocks need per-test overrides.
  "tests/indexer.test.ts",

  // issue-36-repro.test.ts: three tests set AKM_STASH_DIR in test bodies for
  // cross-source and incremental-index tests. These are deliberate per-test
  // overrides; beforeEach/afterEach use the sandbox helper for outer isolation.
  "tests/issue-36-repro.test.ts",

  // source.test.ts: ~50 tests each create a dedicated stash with specific file
  // content and set AKM_STASH_DIR so akmSearch/akmIndex/akmShow read that stash.
  // These are per-test content fixtures, not isolation boilerplate; XDG vars are
  // now properly sandboxed via beforeEach/afterEach.
  "tests/source.test.ts",

  // search-include-proposed-cli.test.ts: one test creates a custom stash with
  // specific quality-marked skills and sets AKM_STASH_DIR to that stash so the
  // spawned CLI subprocess reads it. Deliberate fixture setup; XDG vars are
  // sandboxed via beforeEach/afterEach.
  "tests/search-include-proposed-cli.test.ts",

  // ripgrep.test.ts: one integration test creates a stash with specific script
  // content and sets AKM_STASH_DIR to that stash for the index+search pipeline.
  // All other tests only manipulate PATH (not an AKM env var); XDG vars are
  // sandboxed via beforeEach/afterEach.
  "tests/ripgrep.test.ts",

  // common.test.ts: resolveStashDir tests intentionally set/delete AKM_STASH_DIR
  // to verify the function's env-var lookup precedence (nonexistent path, file vs
  // dir, config.json fallback, default HOME/akm). These are semantic tests of the
  // env var behaviour itself; HOME and XDG_CONFIG_HOME are sandboxed.
  "tests/common.test.ts",

  // semantic-search-e2e.test.ts: two nested describe blocks each use beforeAll +
  // beforeEach to set up an isolated embedding environment. The outer gated block
  // uses the sandbox helpers; the inner "graceful degradation" block (always runs)
  // sets env vars manually in its own beforeAll/beforeEach because it needs a
  // different stash from the gated block. Full migration would require deep
  // refactoring of the cross-describe env sharing pattern.
  "tests/semantic-search-e2e.test.ts",

  // wiki.test.ts: a few tests set XDG_CONFIG_HOME or AKM_STASH_DIR in their bodies
  // to configure wiki registration (external sources / config-based detection) or
  // to point searchInWiki at a specific stash. These are deliberate fixture setups;
  // the module-level beforeEach/afterEach now use the sandbox for outer isolation.
  "tests/wiki.test.ts",

  // scoring-pipeline.test.ts: buildTestIndex sets AKM_STASH_DIR to the per-test
  // tmpStash() dir so akmIndex and akmSearch read the right fixture stash. Each
  // test creates its own isolated stash with specific content; XDG vars are
  // sandboxed via beforeEach/afterEach.
  "tests/scoring-pipeline.test.ts",

  // commands/search.test.ts: buildTestIndex and several tests set AKM_STASH_DIR
  // to per-test fixture stash dirs so akmIndex and akmSearch read the right content.
  // XDG vars are sandboxed via beforeEach/afterEach.
  "tests/commands/search.test.ts",

  // parallel-search.test.ts: buildTestIndex sets AKM_STASH_DIR to the per-test
  // tmpStash() so akmIndex and akmSearch read the right fixture stash.
  // XDG vars are sandboxed via beforeEach/afterEach.
  "tests/parallel-search.test.ts",

  // proposed-quality.test.ts: buildTestIndex sets AKM_STASH_DIR to the per-test
  // tmpStash() dir so akmSearch resolves the indexed content correctly.
  // XDG vars are sandboxed via beforeEach/afterEach.
  "tests/proposed-quality.test.ts",

  // The following files were not migrated by QW3 (#493) due to API drift
  // between the migration base commit and release/0.8.0. They are grandfathered
  // here; the list is allowed to shrink as follow-up migrations land.
  "tests/agent/agent-config-loader.test.ts",
  "tests/belief-state-phase1a.test.ts",
  "tests/commands/events.test.ts",
  "tests/commands/graph-cli-negative.test.ts",
  "tests/commands/graph.test.ts",
  "tests/commands/graph-update.test.ts",
  "tests/commands/history.test.ts",
  "tests/commands/improve-distill-planner-skip-lessons.test.ts",
  "tests/commands/improve-ensure-index-first.test.ts",
  "tests/commands/improve-memory.test.ts",
  "tests/commands/improve-path-exists-guard.test.ts",
  "tests/commands/improve-reflect-unsupported-type-skip.test.ts",
  "tests/commands/improve-result-to-file.test.ts",
  "tests/commands/reflect-response-schema.test.ts",
  "tests/config-auto-migrate.test.ts",
  "tests/config-sanitize-secrets.test.ts",
  "tests/config.test.ts",
  "tests/consolidate-promote-dedup.test.ts",
  "tests/contracts/v1-spec-section-11-proposal-queue.test.ts",
  "tests/core/write-source.test.ts",
  "tests/distill-cli-flag.test.ts",
  "tests/distill-response-schema.test.ts",
  "tests/distill.test.ts",
  "tests/graph-extraction-batch.test.ts",
  "tests/graph-extraction.test.ts",
  "tests/health-command.test.ts",
  "tests/improve-dry-run-side-effects.test.ts",
  "tests/improve-no-hang.test.ts",
  "tests/index-clean.test.ts",
  "tests/lessons-coverage.test.ts",
  "tests/llm-enrichment-cache.test.ts",
  "tests/proposals.test.ts",
  "tests/reflect-completed-on-failure.test.ts",
  "tests/reflect-pipeline-fixes.test.ts",
  "tests/registry-cli.test.ts",
  "tests/integration/registry-install.test.ts",
  "tests/search-source-filter.test.ts",
  "tests/setup-tmp-stash-guard.test.ts",
  "tests/source-qa-fixes.test.ts",
  "tests/source-source.test.ts",
  "tests/state-db-events-purge.test.ts",
  "tests/state-db/improve-runs.test.ts",
  "tests/tasks-legacy-md-warning.test.ts",
  "tests/test-isolation-no-swallow.test.ts",

  // The following files were not yet migrated (grandfathered alongside the
  // QW3 batch above). Each uses mkdtempSync + direct process.env assignment;
  // migration is deferred to a follow-up PR.
  "tests/commands/improve-memory-misc.test.ts",
  "tests/commands/improve-planner-profile-prefilter.test.ts",
  "tests/commands/health-distill-skipped-by-reason.test.ts",
  "tests/extract-command.test.ts",
  "tests/extract-session-tracking.test.ts",
  "tests/health-command-window.test.ts",
  "tests/improve-eligibility.test.ts",
  "tests/integration/indexer.test.ts",
]);

// ── Helpers ──────────────────────────────────────────────────────────────────

const repoRoot = path.resolve(import.meta.dir, "..");

function collectTestFiles(dir: string): string[] {
  const results: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // Skip node_modules, dist, fixtures (fixture data legitimately uses mkdtempSync)
      if (["node_modules", "dist", ".git"].includes(entry.name)) continue;
      results.push(...collectTestFiles(full));
    } else if (entry.isFile() && (entry.name.endsWith(".test.ts") || entry.name.endsWith(".test.js"))) {
      results.push(full);
    }
  }
  return results;
}

type Rule = "mkdtemp-env" | "unguarded-env" | "elapsed-assertion";

interface Violation {
  file: string;
  rule: Rule;
  detail: string;
  line: number;
  envVars?: string[];
}

/**
 * Find every AKM/XDG/HOME env var that is *assigned* (not merely deleted or
 * compared) anywhere in the source. Returns the var name + 1-based line.
 */
function findEnvAssignments(src: string): Array<{ envVar: string; line: number }> {
  const lines = src.split("\n");
  const found: Array<{ envVar: string; line: number }> = [];
  for (const envVar of AKM_ENV_VARS) {
    // Assignment only: `process.env.X =` / `process.env["X"] =`, NOT `== `,
    // `=== `, or `delete process.env.X`. The negative lookahead on `=` rules
    // out comparison operators.
    const pattern = new RegExp(`process\\.env(?:\\[["']${envVar}["']\\]|\\.${envVar})\\s*=(?!=)`);
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (/^\s*(\/\/|\*)/.test(l)) continue; // skip comment lines
      if (pattern.test(l)) found.push({ envVar, line: i + 1 });
    }
  }
  return found;
}

/** True when the file routes env mutation through a sanctioned restoring wrapper. */
function usesSanctionedWrapper(src: string): boolean {
  return /\bwithEnv\s*\(/.test(src) || /\bsandbox(StashDir|Xdg\w+|Home)\s*\(/.test(src);
}

function lintFile(filePath: string): Violation[] {
  const rel = path.relative(repoRoot, filePath).replace(/\\/g, "/");
  const src = fs.readFileSync(filePath, "utf8");
  const violations: Violation[] = [];

  // ── Rule 1: mkdtempSync + AKM env var ──────────────────────────────────────
  if (!ALLOWED_FILES.has(rel) && src.includes("mkdtempSync")) {
    const foundVars: string[] = [];
    for (const envVar of AKM_ENV_VARS) {
      const pattern = new RegExp(`process\\.env(?:\\[["']${envVar}["']\\]|\\.)${envVar}\\s*=`, "g");
      if (pattern.test(src)) foundVars.push(envVar);
    }
    if (foundVars.length > 0) {
      const lines = src.split("\n");
      const lineNum = lines.findIndex((l) => l.includes("mkdtempSync")) + 1;
      violations.push({ file: rel, rule: "mkdtemp-env", detail: `env vars: ${foundVars.join(", ")}`, line: lineNum, envVars: foundVars });
    }
  }

  // ── Rule 2: unguarded AKM/XDG/HOME env assignment (no mkdtempSync needed) ───
  // A Rule-1 hit already covers the same hazard, so only fire Rule 2 when the
  // file is NOT a Rule-1 candidate (no mkdtempSync) — that's the blind spot.
  if (!ALLOWED_FILES.has(rel) && !ENV_ASSIGN_ALLOWED.has(rel) && !src.includes("mkdtempSync")) {
    const assigns = findEnvAssignments(src);
    if (assigns.length > 0 && !usesSanctionedWrapper(src)) {
      const vars = [...new Set(assigns.map((a) => a.envVar))];
      violations.push({
        file: rel,
        rule: "unguarded-env",
        detail: `assigns ${vars.join(", ")} without a restoring wrapper (use withEnv/sandbox* or add a justified ENV_ASSIGN_ALLOWED entry)`,
        line: assigns[0].line,
        envVars: vars,
      });
    }
  }

  // ── Rule 3: wall-clock elapsed-time assertion ──────────────────────────────
  // Targets the precise flaky shape: a LOCAL variable assigned a measured
  // wall-clock delta (`const elapsed = Date.now() - start`) then bounded with
  // toBeLessThan/toBeGreaterThan. We require BOTH (a) a bare-identifier subject
  // (no `.` — so `result.improve.wallTime.minMs`, an aggregate over fixture
  // rows, is NOT flagged) AND (b) that identifier being assigned from a
  // `Date.now()`/`performance.now()` subtraction somewhere in the file. This
  // keeps the rule from firing on deterministic duration fields computed from
  // injected fixtures.
  {
    const lines = src.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (/^\s*(\/\/|\*)/.test(l)) continue;
      const m = l.match(/expect\(\s*([A-Za-z_$][\w$]*)\s*\)\.toBe(LessThan|GreaterThan)(OrEqual)?\(/);
      if (!m) continue;
      const subject = m[1];
      // The subject must be a locally-measured wall-clock delta.
      const measured = new RegExp(
        `(?:const|let|var)\\s+${subject}\\s*=\\s*[^;\\n]*(?:Date\\.now\\(\\)|performance\\.now\\(\\))[^;\\n]*-`,
      );
      const measuredReverse = new RegExp(
        `(?:const|let|var)\\s+${subject}\\s*=\\s*[^;\\n]*-[^;\\n]*(?:Date\\.now\\(\\)|performance\\.now\\(\\))`,
      );
      if (!measured.test(src) && !measuredReverse.test(src)) continue;
      violations.push({
        file: rel,
        rule: "elapsed-assertion",
        detail: `wall-clock assertion on measured delta \`${subject}\` — assert the observable result (e.g. result.reason === "timeout") or drive time with fake timers instead`,
        line: i + 1,
      });
    }
  }

  return violations;
}

// ── Main ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const showFixHints = args.includes("--fix-hints");

const testsDir = path.join(repoRoot, "tests");
const allTestFiles = collectTestFiles(testsDir);

const violations: Violation[] = [];

for (const f of allTestFiles) {
  violations.push(...lintFile(f));
}

if (violations.length === 0) {
  console.log("lint-tests-isolation: OK — no isolation / determinism violations found");
  process.exit(0);
}

const RULE_LABEL: Record<Rule, string> = {
  "mkdtemp-env": "raw mkdtempSync + AKM env var",
  "unguarded-env": "unguarded AKM/XDG/HOME env assignment",
  "elapsed-assertion": "wall-clock elapsed-time assertion",
};

console.error(`lint-tests-isolation: ${violations.length} violation(s) found\n`);
for (const v of violations) {
  console.error(`  ${v.file}:${v.line}  [${RULE_LABEL[v.rule]}]`);
  console.error(`    ${v.detail}`);
  if (showFixHints && v.envVars && (v.rule === "mkdtemp-env" || v.rule === "unguarded-env")) {
    const importPath = v.file.startsWith("tests/") ? "../_helpers/sandbox" : "./_helpers/sandbox";
    const helpers = v.envVars.map((e) => {
      if (e === "AKM_STASH_DIR") return "sandboxStashDir";
      if (e === "XDG_CONFIG_HOME") return "sandboxXdgConfigHome";
      if (e === "XDG_DATA_HOME") return "sandboxXdgDataHome";
      if (e === "XDG_CACHE_HOME") return "sandboxXdgCacheHome";
      if (e === "HOME") return "sandboxHome";
      return "withEnv";
    });
    const unique = [...new Set(helpers)];
    console.error(`    hint: import { ${unique.join(", ")} } from "${importPath}";`);
  }
  console.error("");
}

process.exit(1);
