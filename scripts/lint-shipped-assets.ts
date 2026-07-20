// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Section 7.3 shipped-assets grammar gate (akm 0.9.0 Chunk 10, plan section 16,
 * DoD 12).
 *
 * ZERO-tolerance ratchet: no SHIPPED, agent-facing asset may teach the dead
 * `type:name` ref grammar. The 0.9.0 canonical ref is `[bundle//]conceptId`
 * with a subdir-qualified conceptId (`skills/x`, `memories/x`, ...); the legacy
 * `type:name` spelling is dead in all teaching material (ref-grammar decision
 * D-R2). Unlike `lint-test-ref-literals.ts` (a shrink-only ceiling over the test
 * corpus), this gate fails on the FIRST dead-grammar token - shipped assets are
 * read by agents and must never model the retired grammar.
 *
 *   bun scripts/lint-shipped-assets.ts            # gate (exit 1 on any dead token)
 *   bun scripts/lint-shipped-assets.ts --verbose  # list every offending token
 *
 * Scanned roots (the agent-facing shipped surfaces named in plan 7.3/16):
 *   - src/assets/**           (cli-hints, help text, stash-skeleton conventions,
 *                              improve-strategy JSONs, prompts, templates, ...)
 *   - scripts/akm-asset/**    (akm-asset command docs)
 *   - scripts/akm-eval/cases/** (eval cases + judge-calibration probes - an
 *                              embedded `skill:`/`knowledge:` ref there fails
 *                              akm-eval-smoke at cutover, plan 16)
 *
 * What is NOT the dead grammar (not flagged):
 *  1. LIVE ref-prefix SEARCH queries - a bare `<type>:` or a `<type>:<prefix>/`
 *     (trailing slash) is the deterministic subtree-enumeration grammar parsed
 *     by `parseRefPrefixQuery` (`indexer/search/fts-query.ts`), pinned by
 *     `tests/integration/search-ref-prefix.test.ts`. Still current; keep it.
 *     A bare `<type>:` never matches (the token requires a name char after the
 *     colon); a `<type>:<seg>/` matches but is skipped by the trailing-slash
 *     rule.
 *  2. `${type:NAME}` env/secret SUBSTITUTION tokens (`${secret:API_KEY}`) -
 *     template injection syntax, not a ref (same carve-out as the test lint).
 *  3. The SANCTIONED `derived_from` / belief-transition `memory:<name>` channel
 *     in the eval MEMORY-REGRESSION suite: `akm improve --json-to-stdout` emits
 *     `beliefStateTransitions[].ref`/`archived[].ref` as `memory:<name>`
 *     (`commands/improve/memory/memory-improve.ts`), and the runner's
 *     `refToPath` resolves the same spelling - the case expectations MUST match
 *     what the CLI prints (chunk-8 ledger: WI-8.5c sanctioned survivor). That
 *     whole suite dir is excluded; the actual eval run in CI smoke guards it.
 */

import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "..");

// Agent-facing shipped roots (plan 7.3/16).
const SCAN_ROOTS = ["src/assets", "scripts/akm-asset", "scripts/akm-eval/cases"];

// The sanctioned `memory:<name>` derived-from / belief-transition channel lives
// here; those refs MUST match the CLI's emitted spelling, so the suite keeps the
// legacy grammar by design (chunk-8 ledger WI-8.5c). Excluded from this gate;
// the real eval run in akm-eval-smoke.yml guards it instead.
const EXCLUDED_DIRS = ["scripts/akm-eval/cases/memory-regression"];

// Binary extensions to skip outright (the assets tree is otherwise all text).
const SKIP_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".woff", ".woff2", ".ttf", ".otf"]);

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

// A dead `type:name` ref token: a known type on a word boundary, a colon, then a
// ref-name RUN. The `(?<!\$\{)` guard drops `${type:NAME}` substitution tokens.
// The captured run is inspected below: a run ending in `/` is the LIVE
// ref-prefix-search shape (kept); anything else is a dead ref (flagged). A bare
// `type:` never matches (the run requires a leading name char).
const TOKEN = new RegExp(`(?<![A-Za-z])(?<!\\$\\{)(?:${TYPES.join("|")}):([A-Za-z0-9][A-Za-z0-9._/-]*)`, "g");

interface Offense {
  file: string;
  line: number;
  token: string;
}

function walk(dir: string, out: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile() && !SKIP_EXT.has(path.extname(entry.name).toLowerCase())) out.push(full);
  }
}

function isExcluded(rel: string): boolean {
  return EXCLUDED_DIRS.some((d) => rel === d || rel.startsWith(`${d}/`));
}

function scanFile(abs: string, rel: string, offenses: Offense[]): void {
  let text: string;
  try {
    text = fs.readFileSync(abs, "utf8");
  } catch {
    return;
  }
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    for (const m of lines[i].matchAll(TOKEN)) {
      const run = m[1];
      // LIVE ref-prefix search shape (`<type>:<prefix>/`) - deterministic
      // subtree enumeration, still current. Not a dead ref.
      if (run.endsWith("/")) continue;
      offenses.push({ file: rel, line: i + 1, token: m[0] });
    }
  }
}

function main(): void {
  const verbose = process.argv.includes("--verbose") || process.argv.includes("--list");
  const offenses: Offense[] = [];
  for (const root of SCAN_ROOTS) {
    const absRoot = path.join(REPO_ROOT, root);
    const files: string[] = [];
    walk(absRoot, files);
    for (const file of files.sort()) {
      const rel = path.relative(REPO_ROOT, file).replace(/\\/g, "/");
      if (isExcluded(rel)) continue;
      scanFile(file, rel, offenses);
    }
  }

  if (offenses.length > 0) {
    process.stderr.write(
      `lint-shipped-assets: FAIL - ${offenses.length} dead \`type:name\` ref token(s) in shipped assets. ` +
        "Shipped/agent-facing assets must use the 0.9.0 conceptId grammar (`<subdir>/<name>`, e.g. `skills/code-review`).\n",
    );
    for (const o of offenses) process.stderr.write(`  ${o.file}:${o.line}\t${o.token}\n`);
    process.exit(1);
  }

  if (verbose) process.stdout.write("lint-shipped-assets: no dead `type:name` tokens found in the scanned roots.\n");
  process.stdout.write("lint-shipped-assets: OK - 0 dead `type:name` ref token(s) in shipped assets.\n");
}

main();
