// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * lint-asset-io.ts
 *
 * Bundle adapters are the one layer that reads and writes assets. Code outside it works with assets through the
 * facade in `src/core/assets/` and never learns which adapter holds one. This script counts what still breaks that,
 * in three rules:
 *
 *   asset-io        a call that reads or writes files, walks a bundle, or asks the registry for an adapter
 *                   (`readFileSync`, `writeFileSync`, `walkStash*`, `adapterForId`, ...) outside the allowed paths
 *                   below. A line may carry `// asset-io: <reason>` (same or previous line) for I/O that is not an
 *                   asset: a user-supplied input, run state, a scratch file.
 *   adapter-import  an import from `src/core/adapter/**` other than `bundle-adapter` and `types`, outside the
 *                   adapter layer (`src/core/adapter/`, `src/core/assets/`).
 *   adapter-id      a comparison of an adapter's id with a string literal (`adapterId === "akm"`, `case "okf"` in a
 *                   switch on an adapter) outside the adapter layer: callers ask the asset, never which adapter it is.
 *                   The subject must name an adapter, so `platform === "claude"` is not one.
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

export type Rule = "asset-io" | "adapter-import" | "adapter-id";
/** `file -> rule -> count`. */
export type Counts = Record<string, Partial<Record<Rule, number>>>;

const repoRoot = path.resolve(import.meta.dir, "..");
const baselinePath = path.join(import.meta.dir, "lint-asset-io.baseline.json");

const ADAPTER_LAYER = ["src/core/adapter/", "src/core/assets/"];
/** The adapter modules the rest of the code may import: the contract and the shared value types. */
const IMPORTABLE_ADAPTER_MODULES = ["src/core/adapter/bundle-adapter", "src/core/adapter/types"];

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
  "createReadStream",
  "buildFileContext",
  "mutateFrontmatter",
  "adapterForId",
  "getAdapters",
]);

/** Paths whose own business is files: each is allowed for `asset-io`, for the reason beside it. */
const IO_ALLOWED: ReadonlyArray<readonly [prefix: string, reason: string, except?: readonly string[]]> = [
  ["src/core/adapter/", "the adapters"],
  ["src/core/assets/", "the asset facade"],
  ["src/indexer/walk/", "the directory adapters' walk"],
  ["src/indexer/passes/metadata.ts", "recognition helpers the akm adapter calls"],
  ["src/workflows/source-files.ts", "directory workflow arbitration"],
  ["src/indexer/indexer.ts", "the index scan"],
  ["src/indexer/scan/", "the index scan"],
  ["src/commands/lint/index.ts", "validate dispatch"],
  ["src/core/config/", "config files"],
  ["src/storage/", "databases"],
  ["src/core/state-db.ts", "state database"],
  ["src/core/file-lock.ts", "lock files"],
  ["src/core/common.ts", "file primitives"],
  ["src/core/warn.ts", "primitives"],
  ["src/core/trash.ts", "primitives"],
  ["src/core/npm-package.ts", "package files"],
  ["src/core/tar.ts", "archives"],
  ["src/runtime.ts", "runtime"],
  ["src/version.ts", "runtime"],
  ["src/llm/", "model-call logs"],
  ["src/integrations/", "harness logs, lockfile, runtime"],
  ["src/sources/providers/", "source checkouts"],
  ["src/sources/snapshot-fetchers/", "crawl staging"],
  ["src/tasks/backends/", "scheduler backends"],
  ["src/tasks/run/task-log.ts", "run logs"],
  ["src/tasks/embedded.ts", "shipped task templates"],
  [
    "src/commands/sources/",
    "installs, self-update, plugins, skeleton, migration help",
    ["source-clone.ts", "schema-repair.ts", "import-task.ts"],
  ],
  ["src/commands/health/data-dir-usage.ts", "disk usage"],
  ["src/commands/health/archive-usage.ts", "disk usage"],
  ["src/commands/health/plugin-staleness.ts", "plugin files"],
  ["src/commands/backups-cli.ts", "backups"],
  ["src/commands/completions.ts", "shell completions"],
  ["src/output/stdout.ts", "output"],
  ["src/core/asset/stash-meta.ts", ".meta/ documents are not assets"],
  ["src/workspace/file-actions.ts", "the Desktop Files view"],
  ["src/workspace/copy-entry.ts", "the Desktop Files view"],
  ["src/workspace/bundle-files.ts", "the Desktop Files view"],
  ["src/workspace/git-read.ts", "the Desktop Files view"],
  ["src/core/standards/", "standards documents"],
];

function ioAllowed(file: string): boolean {
  return IO_ALLOWED.some(
    ([prefix, , except]) => file.startsWith(prefix) && !except?.some((name) => file === `${prefix}${name}`),
  );
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

/** Every violation under `<root>/src`, as `[file, rule, line]`. `adapterIds` are the registry's ids. */
export function scan(root: string, adapterIds: readonly string[]): Array<[file: string, rule: Rule, line: number]> {
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
    /** `// asset-io: <reason>` on the line or the one before it. */
    const exempt = (line: number) =>
      /\/\/ asset-io: \S/.test(lines[line] ?? "") || /^\s*\/\/ asset-io: \S/.test(lines[line - 1] ?? "");
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && !ioOk) {
        const name = calleeName(node);
        if (name && isIoCall(name) && !exempt(lineOf(node))) found.push([file, "asset-io", lineOf(node) + 1]);
      }
      const specifier = moduleSpecifier(node);
      if (specifier?.startsWith(".") && !inAdapterLayer) {
        const target = path
          .relative(root, path.resolve(path.dirname(full), specifier))
          .split(path.sep)
          .join("/")
          .replace(/\.(js|ts)$/, "");
        if (target.startsWith("src/core/adapter/") && !IMPORTABLE_ADAPTER_MODULES.includes(target)) {
          found.push([file, "adapter-import", lineOf(node) + 1]);
        }
      }
      if (!inAdapterLayer) {
        // The string and what it is compared with: a switch case compares with the switch's subject.
        let pair: [ts.Expression, ts.Expression] | undefined;
        if (ts.isBinaryExpression(node) && COMPARISONS.has(node.operatorToken.kind)) {
          pair = ts.isStringLiteralLike(node.left) ? [node.left, node.right] : [node.right, node.left];
        } else if (ts.isCaseClause(node) && ts.isSwitchStatement(node.parent.parent)) {
          pair = [node.expression, node.parent.parent.expression];
        }
        // An id is a plain word (`akm`, `claude`), so only a subject that names an adapter counts.
        if (
          pair &&
          ts.isStringLiteralLike(pair[0]) &&
          ids.has(pair[0].text) &&
          /adapter/i.test(pair[1].getText(source))
        ) {
          found.push([file, "adapter-id", lineOf(node) + 1]);
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
    for (const rule of ["asset-io", "adapter-import", "adapter-id"] as const) {
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
  const violations = scan(repoRoot, adapterIds());
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
}
