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
 */

import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const TESTS_DIR = path.join(REPO_ROOT, "tests");
const SKIP_CONFIG = path.join(import.meta.dir, "codemod-ref-literals.skip.json");

// Post-F2 ceiling: the legacy `type:name` literal tokens that remain in the
// counted scope (origin-qualified skips + prose/ambiguous tokens the codemod
// conservatively left). SHRINK-ONLY — lower this when F3/F4 removes more; never
// raise it.
const CEILING = 138;

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
// ref name char (so `key: value` YAML and prose colons do not count).
const TOKEN = new RegExp(`(?:^|[^A-Za-z])(?:${TYPES.join("|")}):[A-Za-z0-9]`, "g");

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
