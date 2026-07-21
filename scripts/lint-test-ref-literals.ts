// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * SHRINK-ONLY ratchet on legacy `type:name` ref literals in the test corpus
 * (akm 0.9.0 Chunk-5 flip, F2). After the codemod re-keyed the origin-less
 * `type:name` literals to D-R2 conceptIds, this pins the REMAINING count as a
 * ceiling: the number may only fall (F3 hand bucket, F4 output re-key), never
 * rise — no new `type:name` literal may creep back into the counted scope.
 *
 * Counted scope = the SAME files the codemod rewrites (`tests/**` `.ts`+`.json`,
 * excluding `tests/fixtures/goldens/**`, `tests/migrate/legacy/**`,
 * `tests/_helpers/**`, `tests/_fixtures/**`, and every path in the codemod
 * skip-list). Skip-listed / excluded files legitimately keep the old grammar
 * until F4, so they are outside the ratchet.
 *
 *   bun scripts/lint-test-ref-literals.ts            # gate (exit 1 if over ceiling)
 *   bun scripts/lint-test-ref-literals.ts --count    # just print the current count
 *
 * ── Substitution-token exclusion (Chunk-5 flip F4b, Ruling B1) ────────────────
 *
 * A `${type:NAME}` sequence (`${secret:API_KEY}`, `${env:...}`, …) is
 * TEMPLATE-SUBSTITUTION SYNTAX — a placeholder resolved at env/secret injection
 * time — NOT a legacy `type:name` ref literal. It survives the F5 grammar
 * removal unchanged (it is not a ref), so it must not inflate the ratchet count.
 * The {@link TOKEN} regex therefore excludes any `type:` immediately preceded by
 * `${`. This is a MEASUREMENT fix only; the ceiling stays shrink-only.
 */

import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const TESTS_DIR = path.join(REPO_ROOT, "tests");
const SKIP_CONFIG = path.join(import.meta.dir, "codemod-ref-literals.skip.json");

// Post-F2 ceiling: the legacy `type:name` literal tokens that remain in the
// counted scope (origin-qualified skips + prose/ambiguous tokens the codemod
// conservatively left). SHRINK-ONLY — lower this when F3/F4 removes more; never
// raise it. Dropped 138 → 116 at F4b Ruling B1 (the `${type:...}` substitution-
// token measurement fix — those 22 tokens were never refs); 116 → 115 at F4b
// when a graph output-baseline assertion flipped to the conceptId spelling;
// 115 → 111 at F5j (the Chunk-5 grammar deletion RE-GREEN: CLI-arg/API ref
// inputs across the mv/source/show/history/feedback/events/remember/env/graph/
// workflow suites re-keyed to the conceptId grammar; the residual 111 are the
// durable-state / persisted / echoed legacy assertions the heuristic preserves).
//
// WI-8.5d (Chunk-8) drove 110 → 74, and the chunk-8 CLOSE audit drove 74 → 50:
// the workflow run-key family flipped when `canonicalWorkflowRunRef` became the
// single mint site (`workflows/<name>` written by runs.ts, pre-existing rows
// re-keyed by the cutover), and the consolidate LLM-prompt refs flipped when
// chunking.ts moved to `memories/<name>`. The residual 50 are the SANCTIONED
// survivors dispositioned in docs/design/execution/chunk-8/ledger.md
// ("Ratchet survivors (50)"):
//   • index `entry_key` seeds/queries — SRC builds `${stashDir}:${type}:${name}`
//     (index.db-internal, regenerable, NOT durable state; item_ref is the
//     separate durable column): utility-scoring, scoped-utility, graph-update,
//     graph-cli-envelope, indexer-rejection, index-db-version-preserve,
//     llm-enrichment-cache.
//   • the `derived_from` channel (`memory:<name>` index column + `source:`
//     frontmatter backref) — deliberate WI-8.5c decision, producer+consumer-
//     consistent legacy channel with a tolerant reader (parseMemoryRef);
//     flipping it is a 0.9.x content-migration follow-up.
//   • error-message / prose refs the SRC formats as `type:name`, plus
//     false positives that are not refs at all: `$env:` PowerShell
//     (tasks-schtasks-backend), `session:<harness>:<id>` provenance
//     (asset-serialize), `…-agent:ok` process output (published-task-upgrade).
const CEILING = 50;

const TYPES = [
  "skill",
  "command",
  "agent",
  "knowledge",
  "workflow",
  "script",
  "memory",
  "env",
  "secret",
  "lesson",
  "task",
  "session",
  "fact",
] as const;
// A legacy `type:name` token: a type keyword on a word boundary, a colon, then a
// ref name char (so `key: value` YAML and prose colons do not count). The
// `(?<!\$\{)` guard (Ruling B1) drops `${type:NAME}` substitution tokens —
// template syntax, not a ref — so they never count toward the ceiling.
const TOKEN = new RegExp(`(?<![A-Za-z])(?<!\\$\\{)(?:${TYPES.join("|")}):[A-Za-z0-9]`, "g");

const EXCLUDED_DIRS = ["tests/fixtures/goldens/", "tests/migrate/legacy/", "tests/_helpers/", "tests/_fixtures/"];

function loadSkip(): Set<string> {
  if (!fs.existsSync(SKIP_CONFIG)) return new Set();
  const raw = JSON.parse(fs.readFileSync(SKIP_CONFIG, "utf8")) as { skip?: string[] };
  return new Set((raw.skip ?? []).map((p) => path.normalize(p)));
}

function walk(dir: string, out: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".json"))) out.push(full);
  }
}

function main(): void {
  const skip = loadSkip();
  const files: string[] = [];
  walk(TESTS_DIR, files);
  let count = 0;
  const perFile: Array<[string, number]> = [];
  for (const abs of files.sort()) {
    const rel = path.relative(REPO_ROOT, abs).replace(/\\/g, "/");
    if (EXCLUDED_DIRS.some((d) => rel.startsWith(d)) || skip.has(path.normalize(rel))) continue;
    const text = fs.readFileSync(abs, "utf8");
    const n = (text.match(TOKEN) ?? []).length;
    if (n > 0) {
      count += n;
      perFile.push([rel, n]);
    }
  }

  if (process.argv.includes("--count") || process.argv.includes("--verbose")) {
    for (const [rel, n] of perFile.sort((a, b) => b[1] - a[1])) process.stdout.write(`${n}\t${rel}\n`);
  }

  if (count > CEILING) {
    process.stderr.write(
      `lint-test-ref-literals: FAIL — ${count} legacy \`type:name\` literal token(s) in the counted scope exceeds the ceiling ${CEILING}. ` +
        "New tests must use the 0.9.0 conceptId grammar (`stashDir/name`), or run `bun scripts/codemod-ref-literals.ts`.\n",
    );
    process.exit(1);
  }
  process.stdout.write(
    `lint-test-ref-literals: OK — ${count} legacy \`type:name\` literal token(s) within ceiling ${CEILING} (shrink-only).\n`,
  );
}

main();
