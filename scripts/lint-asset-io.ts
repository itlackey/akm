// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * lint-asset-io.ts
 *
 * Bundle adapters are the one layer that reads and writes assets. Code outside it works with assets through the
 * facade in `src/core/assets/` and never learns which adapter holds one, where, or under what file name. This script
 * counts what still breaks that, in five rules (outside `src/core/adapter/` and `src/core/assets/`):
 *
 *   asset-io         a call that reads, writes, stats or walks files, or asks the registry for an adapter
 *                    (`readFileSync`, `existsSync`, `walkStash*`, `adapterForId`, ...), outside the allowed paths below.
 *   adapter-import   an import from `src/core/adapter/**` other than `bundle-adapter` and `types`.
 *   facade-internal  an import of `src/core/assets/bundle` or `asset`: the facade's internals.
 *   adapter-id       a registry id literal compared with anything (`x === "akm"`, `case "okf"`), `kind === "location"`,
 *                    or `.fileless`: callers ask the asset, never which adapter or storage it has.
 *   entry-file       `entry.file` / `.entry.file`: a path is for display or for a program, never for finding an asset.
 *
 * A line may carry `// asset-io: <reason>` (same line, or a comment line before it) for access that is not an
 * asset: the reason is one word from REASONS, optionally followed by text. `entry-file` accepts only `display` and
 * `exec`. A missing or unknown reason is no exemption. The exemptions in use are counted per reason and printed.
 *
 * The violations of today are recorded in `lint-asset-io.baseline.json` (count per file and rule). The check fails
 * on a violation the baseline lacks and on a baseline entry that no longer occurs, so the baseline only shrinks and
 * stays exact: when a change removes violations, run `bun scripts/lint-asset-io.ts --update`, which rewrites it and
 * refuses to record a new one. The migration is finished when the baseline is empty.
 *
 * Exit codes: 0 matches the baseline, 1 it does not.
 *
 * Usage: bun scripts/lint-asset-io.ts [--update]
 */

import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const RULES = ["asset-io", "adapter-import", "facade-internal", "adapter-id", "entry-file"] as const;
export type Rule = (typeof RULES)[number];
/** `file -> rule -> count`. */
export type Counts = Record<string, Partial<Record<Rule, number>>>;

const repoRoot = path.resolve(import.meta.dir, "..");
const baselinePath = path.join(import.meta.dir, "lint-asset-io.baseline.json");

const ADAPTER_LAYER = ["src/core/adapter/", "src/core/assets/"];
/** The adapter modules the rest of the code may import: the contract and the shared value types. */
const IMPORTABLE_ADAPTER_MODULES = ["src/core/adapter/bundle-adapter", "src/core/adapter/types"];
const FACADE_INTERNAL_MODULES = ["src/core/assets/bundle", "src/core/assets/asset"];

/** The reasons an exemption may give, each with what it covers. Allowed path prefixes below use the same words. */
export const REASONS = {
  "user-input": "a file or directory the user named (--from-file, import source, export output, stdin, --dir)",
  config: "config files and credentials",
  state: "akm's data directory: databases, run records, logs, locks, caches, backups",
  install: "bundle checkouts, packages, self-update, plugins, lockfile, crawl staging",
  scratch: "temporary files akm creates and removes",
  shipped: "templates and documents akm ships",
  host: "runtime, version, stdout, completions, host probes",
  "disk-usage": "sizes only, no content",
  display: "entry.file shown to a person",
  exec: "entry.file handed to a program",
  "files-view": "the Desktop Files view on a directory bundle",
  "bundle-meta": ".meta/ documents of a directory bundle (not assets)",
} as const;
type Reason = keyof typeof REASONS;
const ENTRY_FILE_REASONS: readonly string[] = ["display", "exec"];

const IO_CALLS = new Set([
  "readFileSync",
  "readFile",
  "writeFileSync",
  "writeFileAtomic",
  "appendFileSync",
  "renameSync",
  "rmSync",
  "unlinkSync",
  "copyFileSync",
  "cpSync",
  "readdirSync",
  "existsSync",
  "statSync",
  "lstatSync",
  "openSync",
  "readTextFile",
  "createReadStream",
  "buildFileContext",
  "mutateFrontmatter",
  "adapterForId",
  "getAdapters",
]);

/** Paths allowed for `asset-io`, each with its reason: REASONS, or the adapter layer itself. */
const IO_ALLOWED: ReadonlyArray<readonly [prefix: string, reason: Reason | "adapter layer"]> = [
  ["src/core/adapter/", "adapter layer"],
  ["src/core/assets/", "adapter layer"],
  ["src/core/config/", "config"],
  ["src/storage/", "state"],
  ["src/core/state-db.ts", "state"],
  ["src/core/file-lock.ts", "state"],
  ["src/core/common.ts", "host"],
  ["src/core/warn.ts", "host"],
  ["src/core/trash.ts", "files-view"],
  ["src/core/npm-package.ts", "install"],
  ["src/core/tar.ts", "install"],
  ["src/runtime.ts", "host"],
  ["src/version.ts", "host"],
  ["src/llm/", "state"],
  ["src/integrations/", "state"],
  ["src/sources/providers/", "install"],
  ["src/sources/snapshot-fetchers/", "install"],
  ["src/tasks/backends/", "host"],
  ["src/tasks/run/task-log.ts", "state"],
  ["src/tasks/embedded.ts", "shipped"],
  ["src/commands/health/data-dir-usage.ts", "disk-usage"],
  ["src/commands/health/archive-usage.ts", "disk-usage"],
  ["src/commands/health/plugin-staleness.ts", "install"],
  ["src/commands/backups-cli.ts", "state"],
  ["src/commands/completions.ts", "host"],
  ["src/output/stdout.ts", "host"],
  ["src/core/asset/stash-meta.ts", "bundle-meta"],
  ["src/workspace/file-actions.ts", "files-view"],
  ["src/workspace/copy-entry.ts", "files-view"],
  ["src/workspace/bundle-files.ts", "files-view"],
  ["src/workspace/git-read.ts", "files-view"],
  ["src/core/standards/", "shipped"],
];

function ioAllowed(file: string): boolean {
  return IO_ALLOWED.some(([prefix]) => file.startsWith(prefix));
}

function collectTs(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return collectTs(full);
    return entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts") ? [full] : [];
  });
}

/** The name a call goes by: `readFileSync` for both `readFileSync(...)` and `fs.readFileSync(...)`. */
function calleeName(call: ts.CallExpression): string | undefined {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) {
    if (ts.isIdentifier(callee.expression) && callee.expression.text === "Bun" && callee.name.text === "file") {
      return "Bun.file";
    }
    return callee.name.text;
  }
  return undefined;
}

function isIoCall(name: string): boolean {
  return IO_CALLS.has(name) || name === "Bun.file" || name.startsWith("walkStash");
}

function moduleSpecifier(node: ts.Node): string | undefined {
  if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
    return ts.isStringLiteralLike(node.moduleSpecifier) ? node.moduleSpecifier.text : undefined;
  }
  if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
    const [argument] = node.arguments;
    return argument && ts.isStringLiteralLike(argument) ? argument.text : undefined;
  }
  return undefined;
}

const COMPARISONS = new Set([
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
]);

/**
 * Every violation under `<root>/src`, as `[file, rule, line]`. `adapterIds` are the registry's ids. The reason of each
 * exemption that covered a violation is pushed onto `exemptions`.
 */
export function scan(
  root: string,
  adapterIds: readonly string[],
  exemptions: string[] = [],
): Array<[file: string, rule: Rule, line: number]> {
  const ids = new Set(adapterIds);
  const found: Array<[string, Rule, number]> = [];
  for (const full of collectTs(path.join(root, "src"))) {
    const file = path.relative(root, full).split(path.sep).join("/");
    const text = fs.readFileSync(full, "utf8");
    const lines = text.split("\n");
    const source = ts.createSourceFile(full, text, ts.ScriptTarget.Latest, true);
    const inAdapterLayer = ADAPTER_LAYER.some((prefix) => file.startsWith(prefix));
    const ioOk = ioAllowed(file);
    const lineOf = (node: ts.Node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line;
    /** Records a violation unless `// asset-io: <reason>` with an accepted reason is on its line or a comment line before. */
    const report = (node: ts.Node, rule: Rule) => {
      const line = lineOf(node);
      const reason =
        /\/\/ asset-io: ([\w-]+)/.exec(lines[line] ?? "")?.[1] ??
        /^\s*\/\/ asset-io: ([\w-]+)/.exec(lines[line - 1] ?? "")?.[1];
      const accepted = rule === "entry-file" ? ENTRY_FILE_REASONS : Object.keys(REASONS);
      if (reason && accepted.includes(reason)) exemptions.push(reason);
      else found.push([file, rule, line + 1]);
    };
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && !ioOk) {
        const name = calleeName(node);
        if (name && isIoCall(name)) report(node, "asset-io");
      }
      const specifier = moduleSpecifier(node);
      if (specifier?.startsWith(".") && !inAdapterLayer) {
        const target = path
          .relative(root, path.resolve(path.dirname(full), specifier))
          .split(path.sep)
          .join("/")
          .replace(/\.(js|ts)$/, "");
        if (target.startsWith("src/core/adapter/") && !IMPORTABLE_ADAPTER_MODULES.includes(target)) {
          report(node, "adapter-import");
        }
        if (FACADE_INTERNAL_MODULES.includes(target)) report(node, "facade-internal");
      }
      if (!inAdapterLayer) {
        // The string and what it is compared with: a switch case compares with the switch's subject.
        let pair: [ts.Expression, ts.Expression] | undefined;
        if (ts.isBinaryExpression(node) && COMPARISONS.has(node.operatorToken.kind)) {
          pair = ts.isStringLiteralLike(node.left) ? [node.left, node.right] : [node.right, node.left];
        } else if (ts.isCaseClause(node) && ts.isSwitchStatement(node.parent.parent)) {
          pair = [node.expression, node.parent.parent.expression];
        }
        if (pair && ts.isStringLiteralLike(pair[0])) {
          const [literal, subject] = pair;
          if (ids.has(literal.text) || (literal.text === "location" && /\bkind$/.test(subject.getText(source)))) {
            report(node, "adapter-id");
          }
        }
        if (ts.isPropertyAccessExpression(node)) {
          const target = node.expression;
          if (node.name.text === "fileless") report(node, "adapter-id");
          if (
            node.name.text === "file" &&
            ((ts.isIdentifier(target) && target.text === "entry") ||
              (ts.isPropertyAccessExpression(target) && target.name.text === "entry"))
          ) {
            report(node, "entry-file");
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return found;
}

export function countsOf(violations: ReadonlyArray<[string, Rule, number]>): Counts {
  const counts: Counts = {};
  for (const [file, rule] of violations) {
    const entry = counts[file] ?? {};
    entry[rule] = (entry[rule] ?? 0) + 1;
    counts[file] = entry;
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => (a < b ? -1 : 1)));
}

/** How `found` differs from `baseline`: what is new, and what the baseline records that no longer occurs. */
export function compare(found: Counts, baseline: Counts): { added: string[]; stale: string[] } {
  const added: string[] = [];
  const stale: string[] = [];
  for (const file of new Set([...Object.keys(found), ...Object.keys(baseline)])) {
    for (const rule of RULES) {
      const now = found[file]?.[rule] ?? 0;
      const recorded = baseline[file]?.[rule] ?? 0;
      if (now > recorded) added.push(`${file}: ${rule} ${recorded} -> ${now}`);
      if (now < recorded) stale.push(`${file}: ${rule} ${recorded} -> ${now}`);
    }
  }
  return { added, stale };
}

if (import.meta.main) {
  const { adapterIds } = await import("../src/core/adapter/registry");
  const exemptions: string[] = [];
  const violations = scan(repoRoot, adapterIds(), exemptions);
  const found = countsOf(violations);
  const baseline: Counts = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
  const { added, stale } = compare(found, baseline);

  if (process.argv.includes("--update")) {
    if (added.length > 0) {
      console.error("lint-asset-io: the baseline only shrinks; these are new violations, fix them instead:");
      for (const line of added) console.error(`  ${line}`);
      process.exit(1);
    }
    fs.writeFileSync(baselinePath, `${JSON.stringify(found, null, 2)}\n`);
    console.log(`lint-asset-io: baseline updated (${stale.length} entries shrank).`);
    process.exit(0);
  }

  if (added.length > 0) {
    console.error("lint-asset-io: asset I/O outside the adapter layer that the baseline does not allow.");
    console.error("Read and write assets through src/core/assets; see scripts/lint-asset-io.ts for the rules.");
    for (const line of added) console.error(`  ${line}`);
    for (const [file, rule, line] of violations) {
      if (added.some((entry) => entry.startsWith(`${file}: ${rule} `))) console.error(`    ${file}:${line} ${rule}`);
    }
  }
  if (stale.length > 0) {
    console.error(
      "lint-asset-io: the baseline records violations that are gone. Run `bun scripts/lint-asset-io.ts --update`.",
    );
    for (const line of stale) console.error(`  ${line}`);
  }
  if (added.length > 0 || stale.length > 0) process.exit(1);
  const total = Object.values(found).reduce((sum, rules) => sum + Object.values(rules).reduce((a, b) => a + b, 0), 0);
  console.log(`lint-asset-io: OK - ${total} baseline violation(s), none new.`);
  for (const rule of RULES) {
    const count = Object.values(found).reduce((sum, rules) => sum + (rules[rule] ?? 0), 0);
    console.log(`  ${rule}: ${count}`);
  }
  const perReason = Object.keys(REASONS).map((reason) => [reason, exemptions.filter((r) => r === reason).length]);
  console.log(`lint-asset-io: ${exemptions.length} exemption(s)`);
  for (const [reason, count] of perReason) console.log(`  ${reason}: ${count}`);
}
