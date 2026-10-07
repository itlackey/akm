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
 * D-R2). This gate fails on the FIRST dead-grammar token - shipped assets are
 * read by agents and must never model the retired grammar.
 *
 *   bun scripts/lint-shipped-assets.ts            # gate (exit 1 on any dead token)
 *   bun scripts/lint-shipped-assets.ts --verbose  # list every offending token
 *
 * Text-scanned roots (the agent-facing shipped surfaces named in plan 7.3/16):
 *   - src/assets/**           (cli-hints, help text, stash-skeleton conventions,
 *                              improve-strategy JSONs, prompts, templates, ...)
 *   - scripts/akm-asset/**    (akm-asset command docs)
 *
 * NOTE this gate only catches the dead `type:name` COLON grammar below, not
 * arbitrary references to a removed command name with no colon (e.g. `akm wiki
 * search`) - that class of defect needs a maintained-command-surface check,
 * which this script does not attempt.
 *
 * AST-scanned root (W2-C/F1 - closed a real blind spot):
 *   - src/**\/*.ts             (every TS source file in the app). Plain text
 *     scanning does not work here: TS source legitimately contains a known
 *     type name immediately before a colon that ISN'T a ref (`case "env":`,
 *     a discriminated union member, an object literal key) and it legitimately
 *     contains COMMENTS that mention the dead grammar for entirely benign
 *     reasons (explaining what NOT to do, historical context, migration
 *     notes) which are never shipped to an agent - only actual source text
 *     that ends up in a runtime string is. So this root is walked with the
 *     TypeScript compiler API (already a project dependency; see
 *     `scripts/fn-size-core.ts` / `scripts/lint-import-cycles.ts` for the same
 *     pattern) and only the CONTENT of string/template literals is handed to
 *     `TOKEN` - comments and code syntax never reach the regex at all, which
 *     is a stronger exclusion than any hand-written carve-out could give.
 *     This is exactly the blind spot that let the retired colon grammar into
 *     `RESPONSE_CONTRACT_JSON` (`src/integrations/agent/prompts.ts`) - a
 *     string-literal array shipped verbatim into an agent-facing prompt -
 *     undetected by the old text-only scan, which never looked at `src/**` at
 *     all outside `src/assets`.
 *
 * What is NOT the dead grammar (not flagged):
 *  1. `${type:NAME}` env/secret SUBSTITUTION tokens (`${secret:API_KEY}`) -
 *     template injection syntax, not a ref (same carve-out as the test lint).
 *  2. A known-type word immediately followed by `${…}` interpolation with NO
 *     literal characters in between (e.g. a hypothetical `` `skill:${id}` ``)
 *     is invisible to the AST scan by construction: template literals are
 *     walked piece-by-piece (head / each span's literal), and `TOKEN` only
 *     matches a colon followed by a literal name character in the SAME piece.
 *     This mirrors carve-out #1 in spirit (colon-then-substitution is not a
 *     static ref token) but is a real residual gap for DYNAMICALLY BUILT dead
 *     refs - not a text-teaches-the-grammar problem, a code-constructs-the-
 *     grammar problem. Out of scope for this text/prompt-grammar gate; if
 *     found, report it as a logic defect (see this change's report).
 */

import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { KNOWN_TYPES } from "../src/core/recognition-util";

const REPO_ROOT = path.resolve(import.meta.dir, "..");

// Agent-facing shipped roots (plan 7.3/16), scanned as plain text.
const SCAN_ROOTS = ["src/assets", "scripts/akm-asset"];

// Every TS source file, scanned via the TS AST (string/template literal
// content only - see the module doc "AST-scanned root" section above).
const TS_SCAN_ROOT = "src";

// Binary extensions to skip outright (the assets tree is otherwise all text).
const SKIP_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".woff", ".woff2", ".ttf", ".otf"]);

const ALLOWED_OFFENSES: ReadonlySet<string> = new Set();

// `wiki` was a real AKM-owned type up through chunk 3 and was deliberately
// RETIRED in chunk 4 ("the wiki ASSET-TYPE dies", plan §11 Chunk 4/§7.4) - the
// LLM Wiki structure now lives behind the first-class `llm-wiki` adapter,
// whose page kinds are open/foreign types, not an AKM `KnownType`. That is
// exactly why it is ABSENT from `KNOWN_TYPES` below (correctly - it is not a
// live type) and exactly why this gate still needs to know about it: a
// leftover `wiki:pagename` token in shipped material is dead colon-grammar
// from a type that no longer exists at all, the most dead a ref token can be.
// Kept as its own list (not folded into `KNOWN_TYPES`) so this is legible as
// "retired, not forgotten" rather than a silent duplicate entry.
const RETIRED_TYPES = ["wiki"] as const;

// F2 fix: this used to be a hand-maintained literal list that had drifted
// from the real type taxonomy (missing `wiki`, and later missing `instruction`
// too - a type added after the list was last touched). Deriving `TYPES` from
// `KNOWN_TYPES` (`src/core/recognition-util.ts`, the single source of truth
// for AKM's own type taxonomy - `placementTypes()` in
// `src/core/asset/asset-placement.ts` is compile-time asserted to be a subset
// of it) makes that drift structurally impossible: a type can never be added
// to the taxonomy without this gate's regex picking it up in the same commit.
// `RETIRED_TYPES` (`wiki`) is unioned in explicitly since a retired type is,
// by definition, never in the live taxonomy.
const TYPES: readonly string[] = [...KNOWN_TYPES, ...RETIRED_TYPES];

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

function walk(dir: string, out: string[], filter: (name: string) => boolean): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out, filter);
    else if (entry.isFile() && filter(entry.name)) out.push(full);
  }
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
    for (const m of lines[i]!.matchAll(TOKEN)) {
      offenses.push({ file: rel, line: i + 1, token: m[0] });
    }
  }
}

/**
 * Scan one string/template-literal piece's decoded text for dead tokens,
 * reporting each match at its true line (the piece's start line plus any
 * newlines the match itself is preceded by - matters for multi-line template
 * literals, e.g. the SQL migration text in `src/core/state/migrations.ts`).
 */
function scanLiteralPiece(sf: ts.SourceFile, node: ts.Node, content: string, rel: string, offenses: Offense[]): void {
  const startLine = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line;
  for (const m of content.matchAll(TOKEN)) {
    const before = content.slice(0, m.index ?? 0);
    const line = startLine + (before.match(/\n/g)?.length ?? 0) + 1;
    offenses.push({ file: rel, line, token: m[0] });
  }
}

/**
 * Scan one `.ts` file's string/template literal CONTENT only - not comments,
 * not code syntax - for dead `type:name` tokens. See the module doc
 * "AST-scanned root" section for why this needs the compiler API rather than
 * `scanFile`'s plain-text approach.
 */
function scanTsFile(abs: string, rel: string, offenses: Offense[]): void {
  let text: string;
  try {
    text = fs.readFileSync(abs, "utf8");
  } catch {
    return;
  }
  const sf = ts.createSourceFile(abs, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      scanLiteralPiece(sf, node, node.text, rel, offenses);
    } else if (ts.isTemplateExpression(node)) {
      scanLiteralPiece(sf, node.head, node.head.text, rel, offenses);
      for (const span of node.templateSpans) scanLiteralPiece(sf, span.literal, span.literal.text, rel, offenses);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

/** True when `o` matches an entry in {@link ALLOWED_OFFENSES} exactly. */
function isAllowedOffense(o: Offense): boolean {
  return ALLOWED_OFFENSES.has(`${o.file}:${o.line}:${o.token}`);
}

function main(): void {
  const verbose = process.argv.includes("--verbose") || process.argv.includes("--list");
  const rawOffenses: Offense[] = [];
  for (const root of SCAN_ROOTS) {
    const absRoot = path.join(REPO_ROOT, root);
    const files: string[] = [];
    walk(absRoot, files, (name) => !SKIP_EXT.has(path.extname(name).toLowerCase()));
    for (const file of files.sort()) {
      const rel = path.relative(REPO_ROOT, file).replace(/\\/g, "/");
      scanFile(file, rel, rawOffenses);
    }
  }

  {
    const absRoot = path.join(REPO_ROOT, TS_SCAN_ROOT);
    const files: string[] = [];
    walk(absRoot, files, (name) => name.endsWith(".ts"));
    for (const file of files.sort()) {
      const rel = path.relative(REPO_ROOT, file).replace(/\\/g, "/");
      scanTsFile(file, rel, rawOffenses);
    }
  }

  const offenses = rawOffenses.filter((o) => !isAllowedOffense(o));

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
