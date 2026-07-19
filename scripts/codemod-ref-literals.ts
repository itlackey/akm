// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * F2 test-literal re-key codemod (akm 0.9.0 Chunk-5 flip, ref-grammar decision
 * D-R2). Rewrites origin-less `type:name` ref literals in the test corpus to the
 * D-R2 short conceptId `<stash-subdir>/<name>`, so the suite speaks the 0.9.0
 * grammar behind the F1/F1b dual readers + input boundaries.
 *
 * SCRIPT-ONLY GATE (plan §15 rule 2): this is the ONLY thing that edits test
 * literals in the F2 commit — no hand edits. Re-run it from a clean checkout of
 * `tests/` and the output is byte-identical.
 *
 *   bun scripts/codemod-ref-literals.ts            # rewrite in place
 *   bun scripts/codemod-ref-literals.ts --dry-run  # report only, no writes
 *
 * ── Rules ──
 *   - The mapping is IMPORTED from `resolve-ref.ts` (`legacyConceptId`) so the
 *     codemod and the runtime shim can never disagree: `type:name` →
 *     `stashDirFor(type)/name`, with NO name normalization (the readers'
 *     `withMdVariants` tolerance handles the ±.md/ext ambiguity).
 *   - ORIGIN-LESS whole-literal `type:name` (string, no-substitution template,
 *     or a `type:`-prefixed template head) → rewritten.
 *   - ORIGIN-QUALIFIED `anything//type:name` → SKIPPED (F3 hand bucket), counted
 *     as skipped-origin.
 *   - Anything that merely CONTAINS a `type:` token but is not a clean whole
 *     ref (prose, `key: value`, interpolated middles) → SKIPPED, counted as
 *     skipped-ambiguous. Conservative by construction: only a whole-literal (or
 *     a clean `type:`-prefixed template head) is ever touched.
 *
 * ── Scope ──
 *   `tests/**` `.ts` + `.json`, EXCLUDING `tests/fixtures/goldens/**` (frozen
 *   migration-input goldens), `tests/migrate/legacy/**` (frozen migrator), and
 *   every path in the checked-in skip-list (`codemod-ref-literals.skip.json` —
 *   the F4-coupled output-assertion files discovered by the run→red→skip loop).
 *   `.md` fixtures are out of scope (the authoritative decision doc scopes the
 *   codemod to ".ts + fixture JSON"; the two `.md` hits are indexed asset
 *   content, i.e. F4/content territory).
 */

import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { legacyConceptId } from "../src/core/asset/resolve-ref";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const TESTS_DIR = path.join(REPO_ROOT, "tests");
const SKIP_CONFIG = path.join(import.meta.dir, "codemod-ref-literals.skip.json");
const INVENTORY_OUT = path.join(import.meta.dir, "codemod-ref-literals.inventory.txt");

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
const TYPE_ALT = TYPES.join("|");
const NAME = "[A-Za-z0-9][A-Za-z0-9._/-]*";
/** Whole literal is an origin-less `type:name`. */
const ORIGINLESS = new RegExp(`^(${TYPE_ALT}):(${NAME})$`);
/** Whole literal is an origin-qualified `anything//type:name`. */
const QUALIFIED = new RegExp(`^.+//(?:${TYPE_ALT}):${NAME}$`);
/** A template head that is exactly a `type:`-prefixed (ref-safe) fragment. */
const HEAD_PREFIX = new RegExp(`^(${TYPE_ALT}):([A-Za-z0-9._/-]*)$`);
/** Loose "contains a type token" probe for the ambiguous tally. */
const CONTAINS_TYPE = new RegExp(`(?:^|[^A-Za-z])(${TYPE_ALT}):`);

interface FileCounts {
  rewritten: number;
  skippedOrigin: number;
  skippedAmbiguous: number;
}

interface Edit {
  start: number;
  end: number;
  replacement: string;
}

const dryRun = process.argv.includes("--dry-run");

/** Rewrite an origin-less `type:name` to its D-R2 conceptId, or `null` to skip. */
function rekey(content: string): string | null {
  const m = ORIGINLESS.exec(content);
  if (!m) return null;
  return legacyConceptId(m[1], m[2]);
}

function loadSkipList(): Set<string> {
  if (!fs.existsSync(SKIP_CONFIG)) return new Set();
  const raw = JSON.parse(fs.readFileSync(SKIP_CONFIG, "utf8")) as { skip?: string[] } | string[];
  const list = Array.isArray(raw) ? raw : (raw.skip ?? []);
  return new Set(list.map((p) => path.normalize(p)));
}

/**
 * Directory prefixes the codemod never touches: frozen migration-input goldens
 * and the frozen migrator (per the flip constraints), plus shared test INFRA —
 * `_helpers/` (ref-builder helpers whose output is consumed cross-file) and
 * `_fixtures/` (durable state fixtures that represent LEGACY on-disk/db state,
 * analogous to the goldens — migration INPUT stays old-grammar).
 */
const EXCLUDED_DIRS = ["tests/fixtures/goldens/", "tests/migrate/legacy/", "tests/_helpers/", "tests/_fixtures/"];

function isExcluded(relPath: string, skip: Set<string>): boolean {
  const norm = relPath.replace(/\\/g, "/");
  if (EXCLUDED_DIRS.some((d) => norm.startsWith(d))) return true;
  return skip.has(path.normalize(norm));
}

function walk(dir: string, out: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
    } else if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".json"))) {
      out.push(full);
    }
  }
}

/** Collect edits for a `.ts` file via the TS AST (quote/template/comment-safe). */
function collectTsEdits(text: string, fileName: string, counts: FileCounts): Edit[] {
  const src = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, /*setParentNodes*/ true, ts.ScriptKind.TS);
  const edits: Edit[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const content = node.text;
      const conceptId = rekey(content);
      if (conceptId !== null) {
        const raw = text.slice(node.getStart(src), node.getEnd());
        const quote = raw[0]; // preserve `"`, `'`, or backtick
        edits.push({ start: node.getStart(src), end: node.getEnd(), replacement: `${quote}${conceptId}${quote}` });
        counts.rewritten++;
      } else if (QUALIFIED.test(content)) {
        counts.skippedOrigin++;
      } else if (CONTAINS_TYPE.test(content)) {
        counts.skippedAmbiguous++;
      }
    } else if (ts.isTemplateExpression(node)) {
      // Only a clean `type:`-prefixed HEAD is safe to rewrite; interpolated
      // middles/tails are left untouched (the `type:` colon is the first colon
      // and there is no origin before it, so `type:` → `stashDir/` is
      // behavior-preserving under `parseRefInput`).
      const headText = node.head.text;
      const hm = HEAD_PREFIX.exec(headText);
      if (hm) {
        const newHead = legacyConceptId(hm[1], hm[2]); // `stashDir/<prefix>`
        const rawHead = text.slice(node.head.getStart(src), node.head.getEnd());
        // rawHead = "`" + headText + "${"  →  keep the delimiters, swap the body.
        const rebuilt = `\`${newHead}\${`;
        if (rawHead === `\`${headText}\${`) {
          edits.push({ start: node.head.getStart(src), end: node.head.getEnd(), replacement: rebuilt });
          counts.rewritten++;
        } else {
          counts.skippedAmbiguous++;
        }
      } else if (CONTAINS_TYPE.test(node.getText(src))) {
        counts.skippedAmbiguous++;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(src);
  return edits;
}

/** Collect edits for a `.json` file via a whole-string-value regex scan. */
function collectJsonEdits(text: string, counts: FileCounts): Edit[] {
  const edits: Edit[] = [];
  const stringRe = /"((?:[^"\\]|\\.)*)"/g;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop
  while ((m = stringRe.exec(text)) !== null) {
    const content = m[1];
    const conceptId = rekey(content);
    if (conceptId !== null) {
      edits.push({ start: m.index, end: m.index + m[0].length, replacement: `"${conceptId}"` });
      counts.rewritten++;
    } else if (QUALIFIED.test(content)) {
      counts.skippedOrigin++;
    } else if (CONTAINS_TYPE.test(content)) {
      counts.skippedAmbiguous++;
    }
  }
  return edits;
}

function applyEdits(text: string, edits: Edit[]): string {
  // Apply from the end so earlier offsets stay valid.
  const sorted = [...edits].sort((a, b) => b.start - a.start);
  let out = text;
  for (const e of sorted) out = out.slice(0, e.start) + e.replacement + out.slice(e.end);
  return out;
}

function main(): void {
  const skip = loadSkipList();
  const files: string[] = [];
  walk(TESTS_DIR, files);
  files.sort();

  const perFile = new Map<string, FileCounts>();
  const total: FileCounts = { rewritten: 0, skippedOrigin: 0, skippedAmbiguous: 0 };

  for (const abs of files) {
    const rel = path.relative(REPO_ROOT, abs).replace(/\\/g, "/");
    if (isExcluded(rel, skip)) continue;
    const text = fs.readFileSync(abs, "utf8");
    if (!CONTAINS_TYPE.test(text)) continue; // fast skip — no ref-shaped tokens
    const counts: FileCounts = { rewritten: 0, skippedOrigin: 0, skippedAmbiguous: 0 };
    const edits = abs.endsWith(".json") ? collectJsonEdits(text, counts) : collectTsEdits(text, rel, counts);
    if (edits.length > 0 && !dryRun) {
      fs.writeFileSync(abs, applyEdits(text, edits), "utf8");
    }
    if (counts.rewritten || counts.skippedOrigin || counts.skippedAmbiguous) {
      perFile.set(rel, counts);
      total.rewritten += counts.rewritten;
      total.skippedOrigin += counts.skippedOrigin;
      total.skippedAmbiguous += counts.skippedAmbiguous;
    }
  }

  // Deterministic inventory (sorted by path).
  const lines: string[] = [];
  lines.push("# F2 ref-literal codemod inventory (deterministic; regenerate with the codemod).");
  lines.push(`# skip-listed files: ${[...skip].sort().join(", ") || "(none)"}`);
  lines.push(
    `# TOTAL rewritten=${total.rewritten} skipped-origin=${total.skippedOrigin} skipped-ambiguous=${total.skippedAmbiguous} files-touched=${[...perFile.values()].filter((c) => c.rewritten > 0).length}`,
  );
  lines.push("# path\trewritten\tskipped-origin\tskipped-ambiguous");
  for (const rel of [...perFile.keys()].sort()) {
    const c = perFile.get(rel) as FileCounts;
    lines.push(`${rel}\t${c.rewritten}\t${c.skippedOrigin}\t${c.skippedAmbiguous}`);
  }
  const inventory = `${lines.join("\n")}\n`;
  if (!dryRun) fs.writeFileSync(INVENTORY_OUT, inventory, "utf8");

  process.stdout.write(
    `${dryRun ? "[dry-run] " : ""}rewritten=${total.rewritten} skipped-origin=${total.skippedOrigin} skipped-ambiguous=${total.skippedAmbiguous} across ${perFile.size} files (${skip.size} skip-listed).\n`,
  );
}

main();
