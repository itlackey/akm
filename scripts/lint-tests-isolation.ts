/**
 * Lint rule: flag test files that use raw `mkdtempSync` **and** also set
 * AKM-specific env vars in the same file.
 *
 * A file that creates a temp dir and immediately assigns it to
 * `process.env.AKM_STASH_DIR` (or XDG_CONFIG_HOME / XDG_DATA_HOME / HOME)
 * should use the `tests/_helpers/sandbox.ts` helpers instead.  Raw
 * `mkdtempSync` for generic fixture data (not an AKM path) is fine and is
 * intentionally NOT flagged.
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
  "tests/registry-install.test.ts",
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

interface Violation {
  file: string;
  envVars: string[];
  line: number;
}

function lintFile(filePath: string): Violation | null {
  const rel = path.relative(repoRoot, filePath).replace(/\\/g, "/");

  // Skip explicitly allowed files
  if (ALLOWED_FILES.has(rel)) return null;

  const src = fs.readFileSync(filePath, "utf8");

  // Must use mkdtempSync to be a candidate
  if (!src.includes("mkdtempSync")) return null;

  // Check which AKM env vars are set via process.env
  const foundVars: string[] = [];
  for (const envVar of AKM_ENV_VARS) {
    // Match:  process.env.AKM_STASH_DIR = ...
    //         process.env["AKM_STASH_DIR"] = ...
    const pattern = new RegExp(
      `process\\.env(?:\\[["']${envVar}["']\\]|\\.)${envVar}\\s*=`,
      "g",
    );
    if (pattern.test(src)) {
      foundVars.push(envVar);
    }
  }

  if (foundVars.length === 0) return null;

  // Find a representative line number (first mkdtempSync call)
  const lines = src.split("\n");
  const lineNum = lines.findIndex((l) => l.includes("mkdtempSync")) + 1;

  return { file: rel, envVars: foundVars, line: lineNum };
}

// ── Main ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const showFixHints = args.includes("--fix-hints");

const testsDir = path.join(repoRoot, "tests");
const allTestFiles = collectTestFiles(testsDir);

const violations: Violation[] = [];

for (const f of allTestFiles) {
  const v = lintFile(f);
  if (v) violations.push(v);
}

if (violations.length === 0) {
  console.log("lint-tests-isolation: OK — no raw-mkdtempSync+env-var violations found");
  process.exit(0);
}

console.error(`lint-tests-isolation: ${violations.length} violation(s) found\n`);
for (const v of violations) {
  console.error(`  ${v.file}:${v.line}`);
  console.error(`    env vars: ${v.envVars.join(", ")}`);
  if (showFixHints) {
    const importPath = v.file.startsWith("tests/") ? "../_helpers/sandbox" : "./_helpers/sandbox";
    const helpers = v.envVars.map((e) => {
      if (e === "AKM_STASH_DIR") return "sandboxStashDir";
      if (e === "XDG_CONFIG_HOME") return "sandboxXdgConfigHome";
      if (e === "XDG_DATA_HOME") return "sandboxXdgDataHome";
      if (e === "XDG_CACHE_HOME") return "sandboxXdgCacheHome";
      if (e === "HOME") return "sandboxHome";
      return "sandboxEnvDir";
    });
    const unique = [...new Set(helpers)];
    console.error(`    hint: import { ${unique.join(", ")} } from "${importPath}";`);
  }
  console.error("");
}

process.exit(1);
