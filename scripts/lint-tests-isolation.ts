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
 * Rule 4 (raw AKM-named temp root): flag `mkdtempSync("…akm-test…")` outside
 * tests/_helpers/ — minting AKM temp roots anywhere else bypasses the
 * single-temp-root/single-cleanup discipline of withIsolatedAkmStorage.
 *
 * Rule 5 (real process spawn in unit scope): flag `spawnSync(` / `spawn(` /
 * `execSync(` / `execFileSync(` / `Bun.spawn(` calls in test files OUTSIDE
 * tests/integration/. A synchronous spawn blocks the entire JS runtime, so a
 * stalled child freezes the shard past every JS-level timeout — bun's
 * per-test `--timeout` cannot fire while the runtime is stuck in a native
 * syscall. This is exactly how the 2026-07-02 release run lost unit shard 1
 * to two consecutive 300s hard-kills (an unmocked `gh auth token` spawn, then
 * a full-CLI subprocess). Unit tests must use the in-process harness
 * (tests/_helpers/cli.ts) or mock `node:child_process`; tests that genuinely
 * need a real subprocess belong in tests/integration/. `spyOn(...)` mock
 * setup lines are not flagged. Existing spawners are grandfathered in
 * SPAWN_ALLOWED (shrink-only).
 *
 * Rule 6 (mock.module ban): flag ANY `mock.module(` call in tests/. Bun's
 * mock.module is process-global and its registrations are NOT cleared by
 * mock.restore(), so a mocked module leaks into every later test file in the
 * same process — proven by a two-file probe during the DI-seam workstream.
 * The suite runs WITHOUT --isolate precisely because mock.module reached
 * zero (PR #689); one reintroduced call silently re-opens cross-file
 * poisoning. Use the swap-and-restore seams instead (tests/_helpers/seams.ts;
 * pattern: docs/architecture/specs/di-seams-plan.md). No allowlist — zero is the invariant.
 *
 * Rule 7 (non-atomic Date.now()): flag ≥2 `new Date(Date.now() …)` timestamp
 * constructions in ONE scope (test/it/describe/hook/function). Reading the wall
 * clock more than once for a set of related timestamps means the reads can
 * straddle a millisecond boundary under load, so any exact assertion on the
 * delta between the derived timestamps flakes. This is the verified root cause
 * of the #499 release-blocking health flake (a `22s`/22000ms task interval
 * intermittently measured 22001+). Capture the clock ONCE — `const now =
 * Date.now()` — and derive every timestamp from `now`. A single
 * `new Date(Date.now() …)` per scope is fine. No allowlist — zero is the invariant.
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
const AKM_ENV_VARS: readonly string[] = ["AKM_STASH_DIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "HOME"];

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
  "tests/integration/paths.test.ts",

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

  // workflow-path-escape.test.ts: sets AKM_STASH_DIR per-test for symlink
  // path testing; each test creates a specific stash/symlink pair and the
  // afterEach correctly deletes all env vars. Per-test pattern, not beforeEach.
  "tests/integration/workflow-path-escape.test.ts",

  // tests/_helpers/sandbox.ts itself: defines the helpers.
  "tests/_helpers/sandbox.ts",

  // source-clone.test.ts: one test overrides AKM_STASH_DIR to a nonexistent
  // path to verify --dest works without a working stash. The assignment is a
  // deliberate semantics override inside the test body; beforeEach/afterEach
  // still use the sandbox helper for all other isolation.
  "tests/integration/source-clone.test.ts",

  // indexer.test.ts: multi-stash tests set AKM_STASH_DIR = primaryStash
  // inside test bodies to configure cross-stash scenarios. This is intentional
  // test-body logic (not isolation boilerplate); the sandbox handles restore
  // via afterEach. Only the multi-stash describe blocks need per-test overrides.

  // issue-36-repro.test.ts: three tests set AKM_STASH_DIR in test bodies for
  // cross-source and incremental-index tests. These are deliberate per-test
  // overrides; beforeEach/afterEach use the sandbox helper for outer isolation.
  "tests/integration/issue-36-repro.test.ts",

  // source.test.ts: ~50 tests each create a dedicated stash with specific file
  // content and set AKM_STASH_DIR so akmSearch/akmIndex/akmShow read that stash.
  // These are per-test content fixtures, not isolation boilerplate; XDG vars are
  // now properly sandboxed via beforeEach/afterEach.
  "tests/integration/source.test.ts",

  // search-include-proposed-cli.test.ts: one test creates a custom stash with
  // specific quality-marked skills and sets AKM_STASH_DIR to that stash so the
  // spawned CLI subprocess reads it. Deliberate fixture setup; XDG vars are
  // sandboxed via beforeEach/afterEach.
  "tests/integration/search-include-proposed-cli.test.ts",

  // ripgrep.test.ts: one integration test creates a stash with specific script
  // content and sets AKM_STASH_DIR to that stash for the index+search pipeline.
  // All other tests only manipulate PATH (not an AKM env var); XDG vars are
  // sandboxed via beforeEach/afterEach.
  "tests/integration/ripgrep.test.ts",

  // common.test.ts: resolveStashDir tests intentionally set/delete AKM_STASH_DIR
  // to verify the function's env-var lookup precedence (nonexistent path, file vs
  // dir, config.json fallback, default HOME/akm). These are semantic tests of the
  // env var behaviour itself; HOME and XDG_CONFIG_HOME are sandboxed.
  "tests/integration/common.test.ts",

  // semantic-search-e2e.test.ts: two nested describe blocks each use beforeAll +
  // beforeEach to set up an isolated embedding environment. The outer gated block
  // uses the sandbox helpers; the inner "graceful degradation" block (always runs)
  // sets env vars manually in its own beforeAll/beforeEach because it needs a
  // different stash from the gated block. Full migration would require deep
  // refactoring of the cross-describe env sharing pattern.
  "tests/integration/semantic-search-e2e.test.ts",

  // wiki.test.ts: a few tests set XDG_CONFIG_HOME or AKM_STASH_DIR in their bodies
  // to configure wiki registration (external sources / config-based detection) or
  // to point searchInWiki at a specific stash. These are deliberate fixture setups;
  // the module-level beforeEach/afterEach now use the sandbox for outer isolation.

  // scoring-pipeline.test.ts: buildTestIndex sets AKM_STASH_DIR to the per-test
  // tmpStash() dir so akmIndex and akmSearch read the right fixture stash. Each
  // test creates its own isolated stash with specific content; XDG vars are
  // sandboxed via beforeEach/afterEach.
  "tests/integration/scoring-pipeline.test.ts",

  // commands/search.test.ts: buildTestIndex and several tests set AKM_STASH_DIR
  // to per-test fixture stash dirs so akmIndex and akmSearch read the right content.
  // XDG vars are sandboxed via beforeEach/afterEach.

  // parallel-search.test.ts: buildTestIndex sets AKM_STASH_DIR to the per-test
  // tmpStash() so akmIndex and akmSearch read the right fixture stash.
  // XDG vars are sandboxed via beforeEach/afterEach.
  "tests/integration/parallel-search.test.ts",

  // proposed-quality.test.ts: buildTestIndex sets AKM_STASH_DIR to the per-test
  // tmpStash() dir so akmSearch resolves the indexed content correctly.
  // XDG vars are sandboxed via beforeEach/afterEach.
  "tests/integration/proposed-quality.test.ts",

  // The following files were not migrated by QW3 (#493) due to API drift
  // between the migration base commit and release/0.8.0. They are grandfathered
  // here; the list is allowed to shrink as follow-up migrations land.
  "tests/integration/agent/agent-config-loader.test.ts",
  "tests/integration/belief-state-phase1a.test.ts",
  "tests/integration/commands/events.test.ts",
  "tests/integration/commands/graph-cli-negative.test.ts",
  "tests/integration/commands/graph.test.ts",
  "tests/integration/commands/graph-update.test.ts",
  "tests/integration/commands/history.test.ts",
  "tests/integration/commands/improve-distill-planner-skip-lessons.test.ts",
  "tests/integration/commands/improve-ensure-index-first.test.ts",
  "tests/integration/commands/improve-memory.test.ts",
  "tests/integration/commands/improve-path-exists-guard.test.ts",
  "tests/integration/commands/improve-reflect-unsupported-type-skip.test.ts",
  "tests/integration/commands/improve-result-to-file.test.ts",
  "tests/integration/commands/reflect-response-schema.test.ts",
  "tests/integration/config-sanitize-secrets.test.ts",
  "tests/integration/config.test.ts",
  "tests/integration/commands/consolidate/consolidate-promote-dedup.test.ts",
  "tests/integration/write-source.test.ts",
  "tests/integration/commands/distill/distill-cli-flag.test.ts",
  "tests/integration/commands/distill/distill-response-schema.test.ts",
  "tests/integration/distill.test.ts",
  "tests/integration/graph-extraction-batch.test.ts",
  "tests/integration/graph-extraction.test.ts",
  // tests/health-command.test.ts — migrated to withIsolatedAkmStorage (C2/#499).
  "tests/integration/commands/improve/improve-dry-run-side-effects.test.ts",
  "tests/integration/commands/improve/improve-no-hang.test.ts",
  "tests/integration/index-clean.test.ts",
  "tests/integration/lessons-coverage.test.ts",
  "tests/integration/llm-enrichment-cache.test.ts",
  "tests/integration/commands/reflect/reflect-completed-on-failure.test.ts",
  "tests/integration/commands/reflect/reflect-pipeline-fixes.test.ts",
  "tests/integration/registry-cli.test.ts",
  "tests/integration/search-source-filter.test.ts",
  "tests/integration/setup-tmp-stash-guard.test.ts",
  "tests/integration/source-qa-fixes.test.ts",
  "tests/integration/source-source.test.ts",
  "tests/integration/tasks-legacy-md-warning.test.ts",
  "tests/integration/test-isolation-no-swallow.test.ts",

  // The following files were not yet migrated (grandfathered alongside the
  // QW3 batch above). Each uses mkdtempSync + direct process.env assignment;
  // migration is deferred to a follow-up PR.
  "tests/integration/commands/improve-memory-misc.test.ts",
  "tests/integration/commands/improve/improve-eligibility.test.ts",
]);

/**
 * Rule 5 grandfather list: unit-scope test files that still spawn real
 * processes. Each is a single shared helper (`runCli`-style spawnSync of the
 * CLI, or a local tool) used by many tests in the file, so migration to the
 * in-process harness — or a move to tests/integration/ — is per-file work.
 * SHRINK-ONLY: entries are removed as files migrate; never add to this list —
 * new unit tests must use tests/_helpers/cli.ts or mock node:child_process.
 */
const SPAWN_ALLOWED = new Set<string>([]);

// ── Shrink-only ratchet ──────────────────────────────────────────────────────

/**
 * The combined grandfather allowlist (Rule-1 `ALLOWED_FILES` + Rule-2
 * `ENV_ASSIGN_ALLOWED` + Rule-5 `SPAWN_ALLOWED`) is a SHRINK-ONLY ratchet: as files migrate onto the
 * `withIsolatedAkmStorage` composite they are removed from these sets and this
 * baseline is lowered to match. The meta-test in
 * `tests/lint-isolation-ratchet.test.ts` asserts the live combined size never
 * exceeds this baseline — so the allowlist can only ever get smaller. If you
 * remove entries, LOWER this number in the same change; never raise it.
 *
 * KPI (WS4): drive this from ~73 toward ~5.
 *
 * 2026-07-02: baseline 64 → 77 when Rule 5 (no real process spawns in unit
 * scope) landed with its 13 pre-existing spawner files grandfathered in
 * SPAWN_ALLOWED — then back down to 64 the same day, when those 13 files were
 * drained (migrated onto the in-process harness or moved to
 * tests/integration/). SPAWN_ALLOWED is now empty and must stay empty.
 */
export const ALLOWLIST_RATCHET_BASELINE = 54;

/** Live size of the combined grandfather allowlist (all rule sets). */
export function combinedAllowlistSize(): number {
  return ALLOWED_FILES.size + ENV_ASSIGN_ALLOWED.size + SPAWN_ALLOWED.size;
}

// Expose the sets so the ratchet meta-test can assert against them directly.
export { ALLOWED_FILES, ENV_ASSIGN_ALLOWED, SPAWN_ALLOWED };

// ── Helpers ──────────────────────────────────────────────────────────────────

const repoRoot = path.resolve(import.meta.dir, "..");

/** Recursively collect *.test.ts / *.test.js files under a directory (shared with test-timing-report). */
export function collectTestFiles(dir: string): string[] {
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

type Rule =
  | "mkdtemp-env"
  | "unguarded-env"
  | "elapsed-assertion"
  | "raw-akm-mkdtemp"
  | "unit-real-spawn"
  | "mock-module"
  | "nonatomic-now";

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
      const l = lines[i]!;
      if (/^\s*(\/\/|\*)/.test(l)) continue; // skip comment lines
      if (pattern.test(l)) found.push({ envVar, line: i + 1 });
    }
  }
  return found;
}

/** True when the file routes env mutation through a sanctioned restoring wrapper. */
function usesSanctionedWrapper(src: string): boolean {
  return (
    /\bwithEnv\s*\(/.test(src) ||
    /\bsandbox(StashDir|Xdg\w+|Home)\s*\(/.test(src) ||
    /\bwithIsolatedAkmStorage\s*\(/.test(src)
  );
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
      violations.push({
        file: rel,
        rule: "mkdtemp-env",
        detail: `env vars: ${foundVars.join(", ")}`,
        line: lineNum,
        envVars: foundVars,
      });
    }
  }

  // ── Rule 4: raw mkdtempSync("…akm-test…") outside tests/_helpers/ ───────────
  // The only sanctioned place to mint an AKM-named temp root is the sandbox
  // helper module. A raw `mkdtempSync(..."akm-test"...)` elsewhere bypasses the
  // single-temp-root / single-cleanup discipline of withIsolatedAkmStorage and
  // is exactly the leak shape the preload tripwire guards against — block it at
  // lint time. Generic mkdtempSync (no `akm-test` prefix) is still allowed.
  if (!rel.startsWith("tests/_helpers/")) {
    const lines = src.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i]!;
      if (/^\s*(\/\/|\*)/.test(l)) continue;
      // mkdtempSync(...) whose call arguments contain an "akm-test" literal.
      if (/mkdtempSync\s*\([^)]*akm-test[^)]*\)/.test(l)) {
        violations.push({
          file: rel,
          rule: "raw-akm-mkdtemp",
          detail: `raw mkdtempSync("…akm-test…") — mint AKM temp roots via withIsolatedAkmStorage()/sandbox helpers in tests/_helpers/`,
          line: i + 1,
        });
      }
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
        line: assigns[0]!.line,
        envVars: vars,
      });
    }
  }

  // ── Rule 5: real process spawn in unit scope ────────────────────────────────
  // Unit shards run `./tests --path-ignore-patterns=tests/integration`, so
  // everything outside tests/integration/ is unit scope (tests/commands and
  // tests/workflows run in BOTH suites and must satisfy the unit invariant).
  // A stalled synchronous spawn freezes the whole shard past every JS-level
  // timeout; only the 300s(+) hard kill saves the job. `spyOn(...)` mock-setup
  // lines don't match (the API name appears as a string, not a call).
  if (!rel.startsWith("tests/integration/") && !SPAWN_ALLOWED.has(rel)) {
    const spawnCall = /(\b(?:spawnSync|execSync|execFileSync)\s*\(|(?:^|[^.\w])spawn\s*\(|Bun\.spawn(?:Sync)?\s*\()/;
    const lines = src.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i]!;
      if (/^\s*(\/\/|\*)/.test(l)) continue;
      if (/\bspyOn\s*\(/.test(l)) continue;
      if (spawnCall.test(l)) {
        violations.push({
          file: rel,
          rule: "unit-real-spawn",
          detail:
            "real process spawn in a unit-scope test — use the in-process harness (tests/_helpers/cli.ts), mock node:child_process, or move the test to tests/integration/",
          line: i + 1,
        });
      }
    }
  }

  // ── Rule 6: mock.module ban ─────────────────────────────────────────────────
  // Process-global, not cleared by mock.restore(), leaks across files without
  // --isolate (which the suite no longer uses). Zero-tolerance, no allowlist.
  {
    const lines = src.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i]!;
      if (/^\s*(\/\/|\*)/.test(l)) continue;
      if (/\bmock\.module\s*\(/.test(l)) {
        violations.push({
          file: rel,
          rule: "mock-module",
          detail:
            "mock.module is banned — it leaks across test files now that the suite runs without --isolate; use the swap-and-restore seams (tests/_helpers/seams.ts)",
          line: i + 1,
        });
      }
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
      const l = lines[i]!;
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

  // ── Rule 7: non-atomic Date.now() timestamp construction ───────────────────
  // Building ≥2 `new Date(Date.now() …)` timestamps in ONE scope reads the wall
  // clock more than once; if the reads straddle a millisecond boundary (a loaded
  // CI shard scheduler), any exact assertion on the delta between the derived
  // timestamps flakes. This is the verified root cause of the #499 release-
  // blocking health flake — its `22s` (22000ms) task interval intermittently
  // measured 22001+ because `taskStart`/`taskEnd` came from two `Date.now()`
  // calls. Fix: capture the clock ONCE (`const now = Date.now()`) and derive
  // every timestamp from `now` (skew-immune by construction). A single
  // `new Date(Date.now() …)` per scope is fine. No allowlist — zero is the
  // invariant. Scopes are delimited by test/it/describe/hook/function starts.
  {
    const lines = src.split("\n");
    const SCOPE_START = /\b(?:test|it|describe|beforeEach|afterEach|beforeAll|afterAll)\s*\(|\bfunction\b/;
    const NOW_TS = /new Date\(\s*Date\.now\(\)/g;
    let hits: number[] = [];
    const flush = () => {
      if (hits.length >= 2) {
        violations.push({
          file: rel,
          rule: "nonatomic-now",
          detail: `${hits.length} \`new Date(Date.now() …)\` reads in one scope (lines ${hits.join(", ")}) — capture the clock once (\`const now = Date.now()\`) and derive every timestamp from \`now\`, else an exact delta assertion flakes under CI load (#499 class)`,
          line: hits[0]!,
        });
      }
      hits = [];
    };
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i]!;
      if (/^\s*(\/\/|\*)/.test(l)) continue; // skip comment lines
      if (SCOPE_START.test(l)) flush();
      const matches = l.match(NOW_TS);
      if (matches) for (let k = 0; k < matches.length; k++) hits.push(i + 1);
    }
    flush();
  }

  return violations;
}

// ── Programmatic API ─────────────────────────────────────────────────────────

/** Lint every test file and return all violations (used by the ratchet meta-test). */
export function lintAllTestFiles(): Violation[] {
  const testsDir = path.join(repoRoot, "tests");
  const out: Violation[] = [];
  for (const f of collectTestFiles(testsDir)) out.push(...lintFile(f));
  return out;
}

export { lintFile };

// ── Main ─────────────────────────────────────────────────────────────────────

if (import.meta.main) {
  const args = process.argv.slice(2);
  const showFixHints = args.includes("--fix-hints");

  const violations = lintAllTestFiles();

  if (violations.length === 0) {
    console.log("lint-tests-isolation: OK — no isolation / determinism violations found");
    process.exit(0);
  }

  const RULE_LABEL: Record<Rule, string> = {
    "mkdtemp-env": "raw mkdtempSync + AKM env var",
    "unguarded-env": "unguarded AKM/XDG/HOME env assignment",
    "elapsed-assertion": "wall-clock elapsed-time assertion",
    "raw-akm-mkdtemp": "raw mkdtempSync(…akm-test…) outside tests/_helpers/",
    "unit-real-spawn": "real process spawn in unit-scope test",
    "mock-module": "mock.module call (banned — suite runs without --isolate)",
    "nonatomic-now": "non-atomic Date.now() timestamp construction (#499 flake class)",
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
}
