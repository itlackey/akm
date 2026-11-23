/**
 * lint-asset-io.ts
 *
 * Bundle adapters are the one layer that reads and writes assets. Code outside it works with assets through the
 * facade in `src/core/assets/` and never learns which adapter holds one, where, or under what file name. This script
 * counts what still breaks that, in seven rules, over `src/` and `desktop/src/lib/server/` (outside
 * `src/core/adapter/` and `src/core/assets/`):
 *
 *   asset-io         a call that reads, writes, stats or walks files, sync or async (`readFileSync`, `fs.promises.stat`,
 *                    `Bun.write`, `walkStash*`, ...), or asks the registry for an adapter (`adapterForId`), outside the
 *                    allowed paths below. Async fs names are matched by where they come from (an `fs` import), so an
 *                    unrelated `.rename()` is not flagged, and an aliased import is.
 *   adapter-import   an import from `src/core/adapter/**` other than `bundle-adapter` and `types`. The walk and the
 *                    metadata recognition helpers (`ADAPTER_IMPORT_LAYER`) may import their own adapter modules.
 *   facade-internal  an import of `src/core/assets/bundle` or `asset`: the facade's internals.
 *   adapter-id       a registry id literal compared with anything (`x === "akm"`, `case "okf"`), `kind === "location"`,
 *                    or `.fileless`: callers ask the asset, never which adapter or storage it has. The compared
 *                    expression's last name may be one of `NON_ADAPTER_NAMES`.
 *   entry-file       `entry.file` / `.entry.file`: a path is for display or for a program, never for finding an asset.
 *   adapter-probe    a call of `detectAdapterId` / `adapterIdOf`: callers never probe which adapter a directory is.
 *   facade-export    an export of a public facade module (`src/core/assets/*` except the internals) that nothing
 *                    outside the facade imports: a facade export lands with its first caller.
 *
 * A line may carry `// asset-io: <reason>` (same line, or a comment line before it) for access that is not an
 * asset: the reason is one word from REASONS, optionally followed by text. Each rule accepts only the reasons in
 * `reasonsFor`: `entry-file` takes `display` and `exec`; the rules that are not file access take none. `deprecated`
 * (workflow code, removed in 0.11) is accepted everywhere but `facade-export`. A missing or unknown reason is no
 * exemption. The exemptions in use are counted per reason and printed.
 *
 * The violations of today are recorded in `lint-asset-io.baseline.json` (count per file, rule and key: the callee for
 * `asset-io` and `adapter-probe`, the module for the import rules, the literal for `adapter-id`, the export name for
 * `facade-export`). The check fails on a violation the baseline lacks and on a baseline entry that no longer occurs,
 * so the baseline only shrinks, cannot trade one violation for another, and stays exact: when a change removes
 * violations, run `bun scripts/lint-asset-io.ts --update`, which rewrites it and refuses to record a new one. The
 * migration is finished when the baseline is empty.
 *
 * Exit codes: 0 matches the baseline, 1 it does not.
 *
 * Usage: bun scripts/lint-asset-io.ts [--update]
 */

import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const RULES = [
  "asset-io",
  "adapter-import",
  "facade-internal",
  "adapter-id",
  "entry-file",
  "adapter-probe",
  "facade-export",
] as const;
export type Rule = (typeof RULES)[number];
/** `file -> rule -> key -> count`. */
export type Counts = Record<string, Partial<Record<Rule, Record<string, number>>>>;
/** One violation: where, which rule, the line, and what it was (the callee, module, literal or export name). */
export type Violation = [file: string, rule: Rule, line: number, key: string];

const repoRoot = path.resolve(import.meta.dir, "..");
const baselinePath = path.join(import.meta.dir, "lint-asset-io.baseline.json");

const SCAN_ROOTS = ["src", "desktop/src/lib/server"];
const ADAPTER_LAYER = ["src/core/adapter/", "src/core/assets/"];
/** What may import `src/core/adapter/**` modules: the layer, and the walk and recognition helpers 4f.1 moves into it. */
const ADAPTER_IMPORT_LAYER = [...ADAPTER_LAYER, "src/indexer/walk/", "src/indexer/passes/metadata.ts"];
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
  deprecated: "workflow code (deprecated, removed in 0.11): not migrated, its exemptions go with the feature",
} as const;
type Reason = keyof typeof REASONS;

/** The reasons a rule accepts. Only file access has the storage reasons; the other rules are not about files. */
function reasonsFor(rule: Rule): readonly string[] {
  if (rule === "asset-io") return Object.keys(REASONS);
  if (rule === "entry-file") return ["display", "exec", "deprecated"];
  if (rule === "facade-export") return [];
  return ["deprecated"];
}

/** Names that hold a registry id's spelling without being an adapter (`harness === "akm"` is not an adapter test). */
const NON_ADAPTER_NAMES: Record<string, string> = {
  harness: "a harness id (claude, opencode, ...)",
  platform: "an operating-system platform",
  basename: "a file name",
  binary: "an executable's name",
  bin: "an executable's name",
  command: "a CLI command word",
};

const IO_CALLS = new Set([
  "readFileSync",
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

/** Async file access: flagged only when the call comes from an `fs` import (`fs.promises.stat`, `{ rename }`). */
const ASYNC_FS = new Set([
  "readFile",
  "writeFile",
  "appendFile",
  "rm",
  "rename",
  "unlink",
  "copyFile",
  "cp",
  "readdir",
  "stat",
  "lstat",
  "open",
  "access",
]);
const FS_MODULES = new Set(["fs", "node:fs", "fs/promises", "node:fs/promises"]);

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
  ["desktop/src/lib/server/features/files.ts", "files-view"],
  ["desktop/src/lib/server/features/file-operations.ts", "files-view"],
  ["desktop/src/lib/server/features/bundle-path.ts", "files-view"],
  ["desktop/src/lib/server/features/preferences.ts", "config"],
];

function ioAllowed(file: string): boolean {
  return IO_ALLOWED.some(([prefix]) => file.startsWith(prefix));
}

function collectTs(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return collectTs(full);
    return entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts") ? [full] : [];
  });
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

/** What a file imported from `fs`: names bound to the module (or to `fs.promises`), and local name -> imported name. */
function fsImports(source: ts.SourceFile): { modules: Set<string>; functions: Map<string, string> } {
  const modules = new Set<string>();
  const functions = new Map<string, string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteralLike(statement.moduleSpecifier)) continue;
    if (!FS_MODULES.has(statement.moduleSpecifier.text)) continue;
    const clause = statement.importClause;
    if (clause?.name) modules.add(clause.name.text);
    const bindings = clause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) modules.add(bindings.name.text);
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        const imported = (element.propertyName ?? element.name).text;
        if (imported === "promises") modules.add(element.name.text);
        else functions.set(element.name.text, imported);
      }
    }
  }
  return { modules, functions };
}

/** The key of an I/O call (its callee), or undefined when the call is not asset I/O. */
function ioKey(call: ts.CallExpression, fsFrom: ReturnType<typeof fsImports>): string | undefined {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) {
    const imported = fsFrom.functions.get(callee.text);
    const name = imported ?? callee.text;
    return IO_CALLS.has(name) || name.startsWith("walkStash") || (imported && ASYNC_FS.has(name)) ? name : undefined;
  }
  if (!ts.isPropertyAccessExpression(callee)) return undefined;
  const name = callee.name.text;
  const owner = callee.expression;
  if (ts.isIdentifier(owner) && owner.text === "Bun" && (name === "file" || name === "write")) return `Bun.${name}`;
  if (IO_CALLS.has(name) || name.startsWith("walkStash")) return name;
  const fromFs =
    (ts.isIdentifier(owner) && fsFrom.modules.has(owner.text)) ||
    (ts.isPropertyAccessExpression(owner) &&
      owner.name.text === "promises" &&
      ts.isIdentifier(owner.expression) &&
      fsFrom.modules.has(owner.expression.text));
  return fromFs && ASYNC_FS.has(name) ? name : undefined;
}

/** The called name of `detectAdapterId(...)` / `x.adapterIdOf(...)`. */
function probeKey(call: ts.CallExpression): string | undefined {
  const callee = call.expression;
  const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : "";
  return name === "detectAdapterId" || name === "adapterIdOf" ? name : undefined;
}

/** The last name of an expression: `a.b.harness` and `path.basename(p)` and `command.toLowerCase()` give the name. */
function lastName(node: ts.Expression): string | undefined {
  if (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node) || ts.isAsExpression(node)) {
    return lastName(node.expression);
  }
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) {
    return node.argumentExpression.text;
  }
  if (ts.isCallExpression(node)) {
    const callee = node.expression;
    if (ts.isPropertyAccessExpression(callee) && ["toLowerCase", "toUpperCase", "trim"].includes(callee.name.text)) {
      return lastName(callee.expression);
    }
    return lastName(callee);
  }
  return undefined;
}

/** The names a statement exports, with the line of each. */
function exportedNames(source: ts.SourceFile): Array<[name: string, line: number]> {
  const out: Array<[string, number]> = [];
  const lineOf = (node: ts.Node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  for (const statement of source.statements) {
    if (ts.isExportDeclaration(statement)) {
      if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) out.push([element.name.text, lineOf(element)]);
      }
    } else if (ts.isExportAssignment(statement)) {
      out.push(["default", lineOf(statement)]);
    } else if (
      ts.canHaveModifiers(statement) &&
      ts.getModifiers(statement)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      const isDefault = ts.getModifiers(statement)?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name)) out.push([declaration.name.text, lineOf(declaration)]);
        }
      } else if (isDefault) out.push(["default", lineOf(statement)]);
      else if ("name" in statement && statement.name && ts.isIdentifier(statement.name as ts.Node)) {
        out.push([(statement.name as ts.Identifier).text, lineOf(statement)]);
      }
    }
  }
  return out;
}

const COMPARISONS = new Set([
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
]);

const isPublicFacadeModule = (module: string) =>
  module.startsWith("src/core/assets/") && !FACADE_INTERNAL_MODULES.includes(module);

/**
 * Every violation under `<root>/src` and `<root>/desktop/src/lib/server`. `adapterIds` are the registry's ids. The
 * reason of each exemption that covered a violation is pushed onto `exemptions`.
 */
export function scan(root: string, adapterIds: readonly string[], exemptions: string[] = []): Violation[] {
  const ids = new Set(adapterIds);
  const found: Violation[] = [];
  /** Public facade module -> its exports; and the names (or `*`) that code outside the facade imports from each. */
  const facadeExports = new Map<string, Array<[string, number]>>();
  const facadeUsed = new Map<string, Set<string>>();
  const use = (module: string, name: string) => {
    if (isPublicFacadeModule(module)) facadeUsed.set(module, (facadeUsed.get(module) ?? new Set()).add(name));
  };
  for (const full of SCAN_ROOTS.flatMap((dir) => collectTs(path.join(root, dir)))) {
    const file = path.relative(root, full).split(path.sep).join("/");
    const text = fs.readFileSync(full, "utf8");
    const lines = text.split("\n");
    const source = ts.createSourceFile(full, text, ts.ScriptTarget.Latest, true);
    const inAdapterLayer = ADAPTER_LAYER.some((prefix) => file.startsWith(prefix));
    const mayImportAdapter = ADAPTER_IMPORT_LAYER.some((prefix) => file.startsWith(prefix));
    const inFacade = file.startsWith("src/core/assets/");
    const ioOk = ioAllowed(file);
    const fsFrom = fsImports(source);
    const namespaces = new Map<string, string>();
    if (isPublicFacadeModule(file.replace(/\.ts$/, "")))
      facadeExports.set(file.replace(/\.ts$/, ""), exportedNames(source));
    const lineOf = (node: ts.Node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line;
    /** Records a violation unless `// asset-io: <reason>` with a reason the rule accepts is on its line or a comment line before. */
    const report = (node: ts.Node, rule: Rule, key: string) => {
      const line = lineOf(node);
      const reason =
        /\/\/ asset-io: ([\w-]+)/.exec(lines[line] ?? "")?.[1] ??
        /^\s*\/\/ asset-io: ([\w-]+)/.exec(lines[line - 1] ?? "")?.[1];
      if (reason && reasonsFor(rule).includes(reason)) exemptions.push(reason);
      else found.push([file, rule, line + 1, key]);
    };
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && !inAdapterLayer) {
        const probe = probeKey(node);
        if (probe) report(node, "adapter-probe", probe);
        const callee = ioOk ? undefined : ioKey(node, fsFrom);
        if (callee) report(node, "asset-io", callee);
      }
      const specifier = moduleSpecifier(node);
      if (specifier?.startsWith(".")) {
        const target = path
          .relative(root, path.resolve(path.dirname(full), specifier))
          .split(path.sep)
          .join("/")
          .replace(/\.(js|ts)$/, "");
        if (
          !mayImportAdapter &&
          target.startsWith("src/core/adapter/") &&
          !IMPORTABLE_ADAPTER_MODULES.includes(target)
        ) {
          report(node, "adapter-import", target);
        }
        if (!inAdapterLayer && FACADE_INTERNAL_MODULES.includes(target)) report(node, "facade-internal", target);
        if (!inFacade) {
          const clause = ts.isImportDeclaration(node) ? node.importClause : undefined;
          const bindings = clause?.namedBindings;
          const exported = ts.isExportDeclaration(node) ? node.exportClause : undefined;
          if (clause?.name) use(target, "default");
          if (bindings && ts.isNamespaceImport(bindings)) namespaces.set(bindings.name.text, target);
          else if (bindings && ts.isNamedImports(bindings)) {
            for (const element of bindings.elements) use(target, (element.propertyName ?? element.name).text);
          } else if (exported && ts.isNamedExports(exported)) {
            for (const element of exported.elements) use(target, (element.propertyName ?? element.name).text);
          } else if (!clause) use(target, "*"); // `export * from` or `import()`: all of it, or unknown
        }
      }
      if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
        const target = namespaces.get(node.expression.text);
        if (target) use(target, node.name.text);
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
          const name = lastName(subject);
          if (literal.text === "location" && name === "kind") report(node, "adapter-id", "location");
          else if (ids.has(literal.text) && !(name && Object.hasOwn(NON_ADAPTER_NAMES, name)))
            report(node, "adapter-id", literal.text);
        }
        if (ts.isPropertyAccessExpression(node)) {
          const target = node.expression;
          if (node.name.text === "fileless") report(node, "adapter-id", ".fileless");
          if (
            node.name.text === "file" &&
            ((ts.isIdentifier(target) && target.text === "entry") ||
              (ts.isPropertyAccessExpression(target) && target.name.text === "entry"))
          ) {
            report(node, "entry-file", "entry.file");
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  for (const [module, exports] of facadeExports) {
    const used = facadeUsed.get(module);
    for (const [name, line] of exports) {
      if (!used?.has(name) && !used?.has("*")) found.push([`${module}.ts`, "facade-export", line, name]);
    }
  }
  return found;
}

export function countsOf(violations: readonly Violation[]): Counts {
  const counts: Counts = {};
  // Sorted first, so the object (and the baseline file written from it) lists files, rules and keys in order.
  const sorted = [...violations].sort((a, b) => (`${a[0]} ${a[1]} ${a[3]}` < `${b[0]} ${b[1]} ${b[3]}` ? -1 : 1));
  for (const [file, rule, , key] of sorted) {
    const rules = counts[file] ?? {};
    const keys = rules[rule] ?? {};
    keys[key] = (keys[key] ?? 0) + 1;
    rules[rule] = keys;
    counts[file] = rules;
  }
  return counts;
}

/** How `found` differs from `baseline`: what is new, and what the baseline records that no longer occurs. */
export function compare(found: Counts, baseline: Counts): { added: string[]; stale: string[] } {
  const added: string[] = [];
  const stale: string[] = [];
  for (const file of new Set([...Object.keys(found), ...Object.keys(baseline)])) {
    for (const rule of RULES) {
      const now = found[file]?.[rule] ?? {};
      const recorded = baseline[file]?.[rule] ?? {};
      for (const key of new Set([...Object.keys(now), ...Object.keys(recorded)])) {
        const [a, b] = [now[key] ?? 0, recorded[key] ?? 0];
        if (a > b) added.push(`${file}: ${rule} ${key} ${b} -> ${a}`);
        if (a < b) stale.push(`${file}: ${rule} ${key} ${b} -> ${a}`);
      }
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
    for (const [file, rule, line, key] of violations) {
      if (added.some((entry) => entry.startsWith(`${file}: ${rule} ${key} `))) {
        console.error(`    ${file}:${line} ${rule} ${key}`);
      }
    }
  }
  if (stale.length > 0) {
    console.error(
      "lint-asset-io: the baseline records violations that are gone. Run `bun scripts/lint-asset-io.ts --update`.",
    );
    for (const line of stale) console.error(`  ${line}`);
  }
  if (added.length > 0 || stale.length > 0) process.exit(1);
  console.log(`lint-asset-io: OK - ${violations.length} baseline violation(s), none new.`);
  for (const rule of RULES) console.log(`  ${rule}: ${violations.filter(([, r]) => r === rule).length}`);
  console.log(`lint-asset-io: ${exemptions.length} exemption(s)`);
  for (const reason of Object.keys(REASONS))
    console.log(`  ${reason}: ${exemptions.filter((r) => r === reason).length}`);
}
