/**
 * lint-asset-io.ts
 *
 * Bundle adapters are the one layer that reads and writes assets. Code outside it works with assets through the
 * facade in `src/core/assets/` and never learns which adapter holds one, where, or under what file name. This script
 * counts what still breaks that, in thirteen rules, over `src/` and `desktop/src/lib/server/` (outside
 * `src/core/adapter/` and `src/core/assets/`, except where a rule says otherwise):
 *
 *   asset-io         a call that reads, writes, stats or walks files, sync or async (`readFileSync`, `fs.promises.stat`,
 *                    `Bun.write`, `walkStash*`, ...), or asks the registry for an adapter (`adapterForId`), outside the
 *                    allowed paths below. Async fs names are matched by where they come from (an `fs` import), so an
 *                    unrelated `.rename()` is not flagged, and an aliased import is.
 *   adapter-import   an import from `src/core/adapter/**` other than `bundle-adapter` and `types`, the walk
 *                    (`directory/`) included. The adapter layer and the metadata recognition helper
 *                    (`ADAPTER_IMPORT_LAYER`) may import their own adapter modules.
 *   facade-internal  an import of `src/core/assets/bundle`, `asset` or `index-rows`: the facade's internals.
 *   adapter-id       a registry id literal compared with anything (`x === "akm"`, `case "okf"`), `kind === "location"`,
 *                    or `.fileless`: callers ask the asset, never which adapter or storage it has. The compared
 *                    expression's last name may be one of `NON_ADAPTER_NAMES`.
 *   entry-file       `entry.file` / `.entry.file`: a path is for display or for a program, never for finding an asset.
 *   adapter-probe    a call of `detectAdapterId` / `adapterIdOf`: callers never probe which adapter a directory is.
 *   facade-export    an export of a public facade module (`src/core/assets/*` except the internals) that nothing
 *                    outside the facade imports: a facade export lands with its first caller.
 *   facade-fs        (inside `src/core/assets/`) a file-access call: the facade reaches storage through adapters only.
 *                    Registry calls (`adapterForId`, `getAdapters`) are the facade's job and are not flagged.
 *   facade-adapter-id (inside `src/core/assets/`) what `adapter-id` flags: the facade does not know which adapter an
 *                    asset has either; adapter-specific behaviour is a contract method.
 *   facade-reexport  (in a public facade module) an `export ... from` an adapter module other than the contract: the
 *                    facade answers about assets, and an adapter's internals or file functions passed through under its
 *                    name are a caller's adapter-import the lint would not count. A caller that needs one imports it
 *                    itself, under an exemption.
 *   store-sniff      a test of whether a bundle is a store: `.isStore`, `addressedBy`, or `.location` compared
 *                    (`=== undefined` included), outside the adapter layer.
 *   entries-sql      raw SQL on the `entries` table or `index_meta` (`FROM entries`, `INSERT INTO index_meta`, ...)
 *                    outside `src/storage/`, `src/core/assets/` and `src/indexer/`.
 *   entry-file-logic `entry.file` as an operand of a comparison, or as a map/set key (`get set has delete add`, `m[entry.file]`,
 *                    `{ [entry.file]: x }`). A `display` or `exec` exemption does not cover it: display is print/format only.
 *                    A test against `undefined` is not logic: a file-less asset has no path to show or run (§7.3).
 *
 * A line may carry `// asset-io: <reason>` (same line, or a comment line before it) for access that is not an
 * asset: the reason is one word from REASONS, optionally followed by text. Each rule accepts only the reasons in
 * `reasonsFor`: `entry-file` takes `display` and `exec`; `store-sniff` takes `config` (a bundle's config entry read as
 * config: copied, validated, described); `facade-reexport` takes `files-view` (the Files view's path rules); the other
 * rules that are not file access take none. `deprecated` (workflow
 * code, removed in 0.11) is accepted everywhere but `facade-export`; `base` (asset access kept as the base release
 * does it until the owner rules on it) by `asset-io`, `entry-file` and `adapter-import`. A missing or unknown reason
 * is no exemption. The exemptions in use are counted per reason and printed.
 *
 * Exit codes: 0 no violation, 1 any violation.
 *
 * Usage: bun scripts/lint-asset-io.ts
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
  "facade-fs",
  "facade-adapter-id",
  "facade-reexport",
  "store-sniff",
  "entries-sql",
  "entry-file-logic",
] as const;
export type Rule = (typeof RULES)[number];
/** One violation: where, which rule, the line, and what it was (the callee, module, literal or export name). */
export type Violation = [file: string, rule: Rule, line: number, key: string];

const repoRoot = path.resolve(import.meta.dir, "..");

const SCAN_ROOTS = ["src", "desktop/src/lib/server"];
const ADAPTER_LAYER = ["src/core/adapter/", "src/core/assets/"];
/** What may import `src/core/adapter/**` modules: the layer, and the recognition helpers in `src/indexer/passes/metadata.ts`. */
const ADAPTER_IMPORT_LAYER = [...ADAPTER_LAYER, "src/indexer/passes/metadata.ts"];
/**
 * The adapter modules the rest of the code may import: the contract, the shared value types, and the report that compares
 * two adapters' listings of a directory (`akm doctor`, `akm bundle add`). The walk is not one.
 */
const IMPORTABLE_ADAPTER_MODULES = [
  "src/core/adapter/bundle-adapter",
  "src/core/adapter/types",
  "src/core/adapter/adapter-skips",
];
/** The adapter modules a public facade module may re-export: the contract and the shared value types. */
const REEXPORTABLE_ADAPTER_MODULES = ["src/core/adapter/bundle-adapter", "src/core/adapter/types"];
/** Where raw SQL on the index tables is at home. */
const ENTRIES_SQL_ALLOWED = ["src/storage/", "src/core/assets/", "src/indexer/"];
/** Registry calls: asset-io flags them outside the layer; the facade is where they belong. */
const REGISTRY_CALLS = new Set(["adapterForId", "getAdapters"]);
const FACADE_INTERNAL_MODULES = ["src/core/assets/bundle", "src/core/assets/asset", "src/core/assets/index-rows"];

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
  "bundle-root": "checks a configured bundle's root (exists, readable, is a git checkout); reads no asset",
  deprecated: "workflow code (deprecated, removed in 0.11): not migrated, its exemptions go with the feature",
  base: "asset access kept as the base release does it, where the facade would change what the user sees: for the owner",
} as const;
type Reason = keyof typeof REASONS;

/** The reasons a rule accepts. Only file access has the storage reasons; the other rules are not about files. */
function reasonsFor(rule: Rule): readonly string[] {
  if (rule === "asset-io") return Object.keys(REASONS);
  if (rule === "entry-file") return ["display", "exec", "base", "deprecated"];
  if (rule === "adapter-import") return ["base", "deprecated"];
  if (rule === "store-sniff") return ["config", "deprecated"];
  if (rule === "facade-reexport") return ["files-view"];
  if (rule === "facade-export" || rule === "entry-file-logic") return [];
  return ["deprecated"];
}

/** Names that hold a registry id's spelling without being an adapter (`harness === "akm"` is not an adapter test). */
const NON_ADAPTER_NAMES: Record<string, string> = {
  harness: "a harness id (claude, opencode, ...)",
  harnessId: "a harness id (claude, opencode, ...)",
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

/** `entry.file` or `x.entry.file`, through parentheses, `!` and `as`. */
function isEntryFile(node: ts.Node): boolean {
  if (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node) || ts.isAsExpression(node)) {
    return isEntryFile(node.expression);
  }
  if (!ts.isPropertyAccessExpression(node) || node.name.text !== "file") return false;
  const target = node.expression;
  return (
    (ts.isIdentifier(target) && target.text === "entry") ||
    (ts.isPropertyAccessExpression(target) && target.name.text === "entry")
  );
}

/** The text of a string literal or template (its fixed parts), or undefined for any other node. */
function stringText(node: ts.Node): string | undefined {
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isTemplateExpression(node))
    return [node.head, ...node.templateSpans.map((span) => span.literal)].map((part) => part.text).join(" ");
  return undefined;
}

const SQL_ON_INDEX_TABLE = /\b(?:from|join|into|update|table|exists)\s+(entries|index_meta)\b/i;
const MAP_KEY_METHODS = new Set(["get", "set", "has", "delete", "add"]);
const ORDERINGS = new Set([
  ts.SyntaxKind.LessThanToken,
  ts.SyntaxKind.LessThanEqualsToken,
  ts.SyntaxKind.GreaterThanToken,
  ts.SyntaxKind.GreaterThanEqualsToken,
]);

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
    const sqlOk = ENTRIES_SQL_ALLOWED.some((prefix) => file.startsWith(prefix));
    const idRule: Rule = inFacade ? "facade-adapter-id" : "adapter-id";
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
      if (ts.isCallExpression(node) && inFacade) {
        const callee = ioKey(node, fsFrom);
        if (callee && !REGISTRY_CALLS.has(callee)) report(node, "facade-fs", callee);
      }
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
          !IMPORTABLE_ADAPTER_MODULES.some((module) =>
            module.endsWith("/") ? target.startsWith(module) : target === module,
          )
        ) {
          report(node, "adapter-import", target);
        }
        if (!inAdapterLayer && FACADE_INTERNAL_MODULES.includes(target)) report(node, "facade-internal", target);
        if (
          ts.isExportDeclaration(node) &&
          isPublicFacadeModule(file.replace(/\.ts$/, "")) &&
          target.startsWith("src/core/adapter/") &&
          !REEXPORTABLE_ADAPTER_MODULES.includes(target)
        ) {
          report(node, "facade-reexport", target);
        }
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
      if (!sqlOk) {
        const sql = stringText(node);
        const table = sql === undefined ? undefined : SQL_ON_INDEX_TABLE.exec(sql)?.[1];
        if (table) report(node, "entries-sql", table.toLowerCase());
      }
      if (!inAdapterLayer) {
        const operand = ts.isBinaryExpression(node) ? [node.left, node.right] : [];
        if (
          ts.isBinaryExpression(node) &&
          (COMPARISONS.has(node.operatorToken.kind) || ORDERINGS.has(node.operatorToken.kind))
        ) {
          const absence = operand.some((side) => ts.isIdentifier(side) && side.text === "undefined");
          if (operand.some(isEntryFile) && !absence) report(node, "entry-file-logic", "compare");
          if (
            COMPARISONS.has(node.operatorToken.kind) &&
            operand.some((side) => ts.isPropertyAccessExpression(side) && side.name.text === "location")
          ) {
            report(node, "store-sniff", "location");
          }
        }
        const [firstArgument] = ts.isCallExpression(node) ? node.arguments : [];
        if (
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          MAP_KEY_METHODS.has(node.expression.name.text) &&
          firstArgument &&
          isEntryFile(firstArgument)
        ) {
          report(node, "entry-file-logic", "key");
        }
        if (ts.isElementAccessExpression(node) && isEntryFile(node.argumentExpression)) {
          report(node, "entry-file-logic", "key");
        }
        if (ts.isComputedPropertyName(node) && isEntryFile(node.expression)) report(node, "entry-file-logic", "key");
        if (ts.isPropertyAccessExpression(node) && (node.name.text === "isStore" || node.name.text === "addressedBy")) {
          report(node, "store-sniff", node.name.text);
        }
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "addressedBy") {
          report(node, "store-sniff", "addressedBy");
        }
      }
      if (!inAdapterLayer || inFacade) {
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
          if (literal.text === "location" && name === "kind") report(node, idRule, "location");
          else if (ids.has(literal.text) && !(name && Object.hasOwn(NON_ADAPTER_NAMES, name)))
            report(node, idRule, literal.text);
        }
        if (ts.isPropertyAccessExpression(node)) {
          if (node.name.text === "fileless") report(node, idRule, ".fileless");
          if (!inFacade && isEntryFile(node)) report(node, "entry-file", "entry.file");
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

if (import.meta.main) {
  const { adapterIds } = await import("../src/core/adapter/registry");
  const exemptions: string[] = [];
  const violations = scan(repoRoot, adapterIds(), exemptions);
  if (violations.length > 0) {
    console.error("lint-asset-io: asset I/O outside the adapter layer.");
    console.error("Read and write assets through src/core/assets; see scripts/lint-asset-io.ts for the rules.");
    for (const [file, rule, line, key] of violations) console.error(`  ${file}:${line} ${rule} ${key}`);
    process.exit(1);
  }
  console.log(`lint-asset-io: OK - ${exemptions.length} exemption(s)`);
  for (const reason of Object.keys(REASONS))
    console.log(`  ${reason}: ${exemptions.filter((r) => r === reason).length}`);
}
