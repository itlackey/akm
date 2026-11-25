// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The `akm` adapter's `lint`: the sweep of a bundle's document folders, each file checked by the shared base checks and
 * its type's rules (`akm-lint.ts`), the skill folders, the task files (the `.yaml` near-miss included), the workflow
 * frontend, and the findings of the adapter's own `validate` that the sweep left out. `--fix`, `--fix-moved-refs` and
 * `--prune-dangling-edges` repair as they check, each repair an asset write through `writeAssets`; `validate` never
 * writes. The sweep also reads what no adapter lists as an asset (a `.yaml` task, a skill folder, the `.env` files).
 */

import fs from "node:fs";
import path from "node:path";
import { runBaseChecks } from "../../../commands/lint/base-linter";
import { lintIssueDedupeKey } from "../../../commands/lint/diagnostics";
import { type MovedRefs, type ReadMoves, readRecordedMoves } from "../../../commands/lint/moved-refs";
import { lintScope } from "../../../commands/lint/scope";
import {
  type AkmLintOptions,
  isAdvisoryLintIssue,
  type LintBundle,
  type LintContext,
  type LintFindings,
  type LintIssue,
  type LintRun,
} from "../../../commands/lint/types";
import { resolveSourceEntries, type SearchSource } from "../../../indexer/search/search-source";
import { TASK_EXTENSION, TASK_NEAR_MISS_EXTENSION, taskExtensionDetail } from "../../../tasks/source-v3";
import {
  isUsableWorkflowSource,
  isWorkflowSource,
  resolveWorkflowSourceDomains,
} from "../../../workflows/source-files";
import {
  documentFormatForStashDir,
  documentStashDirFor,
  documentStashDirs,
  documentTypes,
  stashDirFor,
  typeForStashDir,
} from "../../asset/asset-placement";
import { parseFrontmatter } from "../../asset/frontmatter";
import type { Asset } from "../../assets/read";
import { assetTypesByContent } from "../../assets/type";
import { assetAtStoredKey, listBundleAssets } from "../../assets/validate";
import { writeAssets } from "../../assets/write";
import { compareCodePoints, isAkmRegistryCachePath, samePath } from "../../common";
import type { AkmConfig } from "../../config/config";
import { defaultExcludedTypes } from "../../config/schema/search";
import { UsageError } from "../../errors";
import { warn } from "../../warn";
import {
  assertFileWritable,
  heldFilesBelow,
  heldFolders,
  heldText,
  holdsFile,
  saveHeldText,
} from "../directory/held-files";
import type { FileDiagnostic } from "../validate-context";
import {
  derivedSiblingPath,
  MAX_SKILL_GROUP_DEPTH,
  matchWorkflowPlaceholder,
  perTypeChecks,
  perTypeFrontend,
} from "./akm-lint";
import { envSweepFindings, validateFindings } from "./akm-lint-run";

/**
 * Every task-shaped file under `tasks/`: the recognized `.yml` spelling AND the
 * `.yaml` near-miss. A `.yaml` file is not a runnable task — it is invisible to
 * the indexer's `tasks` matcher — but collecting it here is what lets the sweep
 * SAY so (`invalid-task-yaml`, see {@link taskExtensionDetail}) instead of
 * walking past it and reporting a clean scan.
 */
function collectTaskFiles(root: string): string[] {
  return heldFilesBelow(root, "tasks", (name) => isTaskFileName(name) || isNearMissTaskFileName(name));
}

function isTaskFileName(fileName: string): boolean {
  return fileName.toLowerCase().endsWith(TASK_EXTENSION);
}

function isNearMissTaskFileName(fileName: string): boolean {
  return fileName.toLowerCase().endsWith(TASK_NEAR_MISS_EXTENSION);
}

/** A loose `.md` typed workflow, or one a symlink makes unusable (`isUsableWorkflowSource`), is no workflow source: lint never read it. */
function isLintableWorkflow(root: string, file: string): boolean {
  return isWorkflowSource(root, "akm", file) && isUsableWorkflowSource(root, file);
}

/** The bundle at `root` as its adapter lists it, with the type of each asset checked against its saved bytes. */
interface BundleInventory {
  assets: Asset[];
  types: Map<Asset, string | undefined>;
}

function inventoryOf(bundle: LintBundle): BundleInventory {
  // Nothing under `env/` or `secrets/` is read, so nothing there is typed either: typing an asset reads its bytes.
  const assets = listBundleAssets(bundle).filter((asset) => !underEnvOrSecrets(asset));
  return { assets, types: assetTypesByContent(assets) };
}

function underEnvOrSecrets(asset: Asset): boolean {
  return asset.entry.key
    .split("/")
    .slice(0, -1)
    .some((dir) => dir === "env" || dir === "secrets");
}

/** The absolute file of an asset the bundle at `root` keeps as a file. */
function fileOfAsset(root: string, asset: Asset): string {
  return path.join(root, asset.entry.key);
}

/**
 * The stash folder of the document type of `asset`, when the sweep reads it: its adapter's listing is the files and
 * each one's type is the index's (checked against its saved bytes), so lint reads what the index holds, wherever a file
 * sits. Nothing under `env/` or `secrets/` is read, and a loose `.md` typed workflow by its content is no workflow
 * source, so the sweep never linted it.
 */
function documentDirOf(root: string, asset: Asset, type: string | undefined): string | undefined {
  if (underEnvOrSecrets(asset)) return undefined;
  if (type === "workflow" && !isLintableWorkflow(root, fileOfAsset(root, asset))) return undefined;
  return type === undefined ? undefined : documentStashDirFor(type);
}

/** The Markdown assets of the bundle at `root` by the stash folder of their type. */
function markdownAssetsByType(root: string, { assets, types }: BundleInventory): Map<string, Asset[]> {
  const byDir = new Map<string, Asset[]>();
  for (const asset of assets) {
    if (path.extname(asset.entry.key).toLowerCase() !== ".md") continue;
    const dir = documentDirOf(root, asset, types.get(asset));
    if (dir === undefined || documentFormatForStashDir(dir) !== "markdown") continue;
    byDir.set(dir, [...(byDir.get(dir) ?? []), asset]);
  }
  return byDir;
}

interface WorkflowLintOwnership {
  files: string[];
  issues: LintIssue[];
}

/**
 * Resolve the already-enumerated candidates through the same workflow-source
 * authority used by index/show/run. The bulk surface inspects every canonical
 * domain without re-reading its parent directory once per workflow. A rejected
 * domain produces one deterministic finding and none of its sources is parsed.
 */
function resolveWorkflowLintOwnership(stashRoot: string, files: readonly string[]): WorkflowLintOwnership {
  const ownedFiles: string[] = [];
  const issues: LintIssue[] = [];
  for (const resolution of resolveWorkflowSourceDomains(stashRoot, "akm", files)) {
    if (resolution.source) {
      ownedFiles.push(resolution.source.path);
      continue;
    }
    if (!resolution.rejection) continue;
    const representative = resolution.sourcePaths[0];
    if (!representative) continue;
    issues.push({
      file: representative,
      issue: "invalid-workflow-structure",
      detail: resolution.rejection.message,
      fixed: false,
    });
  }
  return { files: ownedFiles.sort(compareCodePoints), issues };
}
/**
 * Refuse `--fix` against a bundle the config marks `writable: false`, BEFORE
 * the sweep touches a single file.
 *
 * Every other mutating command routes through `core/write-source.ts`'s
 * `ensureWritable`/`resolveWritable` pair; `akm lint --fix` writes and deletes
 * directly, so without this check it would rewrite frontmatter in a
 * bundle explicitly configured read-only. `SearchSource.writable` is already the
 * EFFECTIVE policy (`resolveWritable` applied — see `resolveSourceEntries`), so
 * this reads the same answer the write path would, without a second resolver.
 *
 * A root that is not a configured source at all (an ad-hoc `--dir`) carries no
 * policy and stays fixable, exactly as today.
 */
function assertFixTargetWritable(stashRoot: string, sources: SearchSource[]): void {
  const target = sources.find((source) => samePath(source.path, stashRoot));
  if (target?.writable !== false) return;
  // Same error kind and code `write-source.ts#ensureWritable` raises for the
  // identical refusal, so a scripted caller classifies both the same way.
  throw new UsageError(
    `lint: bundle "${stashRoot}" is configured \`writable: false\`; refusing to modify it. ` +
      "Run `akm lint` without --fix / --prune-dangling-edges to report findings, or set `writable: true` on the bundle.",
    "INVALID_FLAG_VALUE",
  );
}

/** True when the issue represents a file deletion that was successfully applied. */
function isFileDeletion(issue: LintIssue): boolean {
  return issue.fixed === true && (issue.issue === "orphaned-stub" || issue.issue === "placeholder-stub");
}

// ── Per-file lint dispatch ──
//
// The format-generic checks are the shared `runBaseChecks` (`./base-linter`);
// the per-`type` RULES are the `akm` adapter's `validate` surface
// (`core/adapter/adapters/akm-lint.ts`), imported here so both the read-only
// adapter and this fix-capable CLI sweep share ONE definition of each finding.
// The adapter never writes; the delete-fix for the two stub types is applied
// HERE (a core/CLI concern).

/**
 * Reproduce `SkillLinter.lintDirectory`: a skill subdirectory (`relDir`, bundle-relative) with no
 * `SKILL.md` is flagged `missing-skill-md` (never auto-fixable). A directory
 * that has none itself but holds skill packages is a grouping directory: it is
 * not flagged, its children are checked instead. Exported for the lint-parity
 * golden (`tests/integration/goldens-lint-output.test.ts`).
 */
export function lintSkillDirectory(stashRoot: string, relDir: string, depth = 1): LintIssue[] {
  if (holdsFile(stashRoot, path.join(relDir, "SKILL.md"))) return [];
  const children = depth < MAX_SKILL_GROUP_DEPTH ? skillSubfolders(stashRoot, relDir) : [];
  if (children.some((child) => containsSkillManifest(stashRoot, child, depth + 1))) {
    return children.flatMap((child) => lintSkillDirectory(stashRoot, child, depth + 1));
  }
  return [{ file: relDir, issue: "missing-skill-md", detail: `no SKILL.md in ${relDir}/`, fixed: false }];
}

/** The folders of `relDir` that are not hidden, as bundle-relative paths. */
function skillSubfolders(stashRoot: string, relDir: string): string[] {
  return heldFolders(stashRoot, relDir)
    .filter((name) => !name.startsWith("."))
    .map((name) => path.join(relDir, name));
}

function containsSkillManifest(stashRoot: string, relDir: string, depth: number): boolean {
  if (holdsFile(stashRoot, path.join(relDir, "SKILL.md"))) return true;
  if (depth >= MAX_SKILL_GROUP_DEPTH) return false;
  return skillSubfolders(stashRoot, relDir).some((child) => containsSkillManifest(stashRoot, child, depth + 1));
}

/** Under `--fix`, a stub the per-type checks found is deleted; the finding then says so, or says why not. */
function deleteStubWhenFixing(ctx: LintContext, found: FileDiagnostic): LintIssue {
  const issue = found as LintIssue;
  if (!ctx.fix || (issue.issue !== "orphaned-stub" && issue.issue !== "placeholder-stub")) return issue;
  try {
    if (ctx.remove === undefined) throw new Error("there is nowhere to delete it from");
    ctx.remove();
    return {
      ...issue,
      detail:
        issue.issue === "orphaned-stub"
          ? "deleted orphaned stub"
          : `deleted: found "${matchWorkflowPlaceholder(ctx.body)}"`,
      fixed: true,
    };
  } catch (e) {
    return { ...issue, detail: `could not delete: ${e instanceof Error ? e.message : String(e)}`, fixed: "failed" };
  }
}

/**
 * Lint ONE asset file: the shared base checks, then the winning stash subdir's
 * per-`type` extra rules. Replaces `getLinterForType(subdir).lint(ctx)`.
 * `--fix` mutations (frontmatter rewrites inside `runBaseChecks`; stub deletes
 * here) are applied when `ctx.fix` is set.
 *
 * The workflow parse/compile frontend is NOT one of these rules — it is one
 * pass feeding two channels, so {@link lintAkmSweep} owns it (see
 * {@link appendWorkflowStubIssue}).
 */
export function lintAssetFile(ctx: LintContext, subdir: string): LintIssue[] {
  const issues = runBaseChecks(ctx);
  const found = perTypeChecks({
    type: typeForStashDir(subdir),
    relPath: ctx.relPath,
    raw: ctx.raw,
    data: ctx.data,
    frontmatter: ctx.frontmatter,
    body: ctx.body,
    ext: path.extname(ctx.relPath).toLowerCase(),
    rules: { relPath: ctx.relPath, skip: ctx.lintSkip },
    derivedSiblingExists: holdsFile(ctx.stashRoot, derivedSiblingPath(ctx.relPath)),
  });
  issues.push(...found.map((finding) => deleteStubWhenFixing(ctx, finding)));
  return issues;
}

interface SweepScope {
  stashRoot: string;
  extraStashRoots: string[];
  fix: boolean;
  fixMovedRefs: boolean;
  moves: MovedRefs;
  bundleRoots: ReadonlyMap<string, string>;
  pruneDanglingEdges: boolean;
  /** Rules to skip for this run, on top of the bundle's `lint.skip`. */
  lintSkip?: string[];
  /** Roots that make an absolute path judgeable for `stale-path`. */
  stalePathRoots: string[];
  /** The bundle's `lint.skip` rules for a bundle-relative path. */
  bundleSkip?: (relPath: string) => string[];
}

interface SweepSinks {
  fixed: LintIssue[];
  flagged: LintIssue[];
  warnings: LintIssue[];
}

/** What a pass can do with the file it lints besides check its text: stamp it, save a fix, delete a stub. */
type FileIo = Pick<LintContext, "modified" | "write" | "remove">;

/** A file the sweep lints: where it is, its text, and what a fix may do with it. */
interface SweepFile {
  filePath: string;
  relPath: string;
  read(): string;
  io: FileIo;
}

/**
 * The file `filePath` of the bundle at `root`. The asset that holds it (an adapter lists one there) is what a fix saves
 * through, written where a link leads when the file is one; a file no adapter lists as an asset (a `.yaml` near-miss task)
 * is read and saved as it lies. Under a write session the asset is read again when its turn comes, since an earlier fix
 * may have changed the bytes it was listed with (two paths to one file).
 */
function sweepFileOf(
  bundle: LintBundle,
  filePath: string,
  asset: Asset | undefined,
  writer: LintWriter | undefined,
): SweepFile {
  const current = (held: Asset): Asset => (writer ? (assetAtStoredKey(bundle, held.entry.key) ?? held) : held);
  return {
    filePath,
    relPath: path.relative(bundle.path, filePath),
    read: () => (asset ? current(asset).entry.content() : heldText(filePath)),
    io: asset
      ? writer
        ? {
            modified: () => asset.entry.modified?.() ?? new Date(),
            write: (raw) => {
              // A read-only file stays as it is: the save replaces the file, which ignores its mode.
              assertFileWritable(filePath);
              writer.update(asset.conceptId, raw);
            },
            remove: () => void writer.delete(asset.conceptId),
          }
        : {}
      : { write: (raw) => saveHeldText(filePath, raw) },
  };
}

/** Lint one asset file of `subdir` and file its findings into `sinks` (the sweep loop body, shared with {@link lintFile}). */
function lintSweepFile(file: SweepFile, subdir: string, scope: SweepScope, sinks: SweepSinks): void {
  let raw: string;
  try {
    raw = file.read();
  } catch {
    return;
  }
  lintDocument(raw, file.filePath, file.relPath, subdir, scope, sinks, file.io);
}

/**
 * The checks of one asset's text, as the sweep runs them on a file: the file's own rules, its type's rules and the
 * workflow frontend. {@link lintSweepFile} reads the file and calls this; {@link lintDocumentText} calls it for text not
 * yet saved, so what a save is checked against is what a sweep would then report.
 */
function lintDocument(
  raw: string,
  filePath: string,
  relPath: string,
  subdir: string,
  scope: SweepScope,
  { fixed, flagged, warnings }: SweepSinks,
  io: FileIo = {},
): void {
  const { stashRoot, extraStashRoots, fix, fixMovedRefs, moves, bundleRoots, pruneDanglingEdges, stalePathRoots } =
    scope;
  const lintSkip = [...(scope.lintSkip ?? []), ...(scope.bundleSkip?.(relPath) ?? [])];

  let data: Record<string, unknown>;
  let body: string;
  let frontmatter: string | null;
  let bodyStartLine = 1;
  // File-identity findings the per-type rules cannot produce: they describe
  // the FILE (its extension, whether it parsed at all), not its fields.
  const fileIssues: LintIssue[] = [];

  if (subdir === "tasks") {
    // Task files are pure YAML. The canonical task-v3 parser runs once in
    // taskDiagnostics below; base checks need no parsed frontmatter data.
    data = {};
    if (isNearMissTaskFileName(relPath)) {
      fileIssues.push({
        file: relPath,
        issue: "invalid-task-yaml",
        detail: taskExtensionDetail(relPath),
        fixed: false,
      });
    }
    body = raw;
    frontmatter = null;
  } else {
    ({ data, content: body, frontmatter, bodyStartLine } = parseFrontmatter(raw));
  }

  // One file's checks — including its `--fix` mutations — must never abort
  // the sweep: an uncaught throw here left the caller with an exception and
  // no record of which earlier files had ALREADY been rewritten on disk
  //. A failure is reported per-file, in-band, and the sweep
  // continues so the rest of the bundle is still linted.
  let issues: LintIssue[];
  try {
    issues = [
      ...fileIssues,
      ...lintAssetFile(
        {
          filePath,
          relPath,
          raw,
          data,
          body,
          frontmatter,
          bodyStartLine,
          fix,
          fixMovedRefs,
          moves,
          bundleRoots,
          pruneDanglingEdges,
          stashRoot,
          stalePathRoots,
          extraStashRoots,
          lintSkip,
          ...io,
        },
        subdir,
      ),
    ];
  } catch (e) {
    flagged.push(...fileIssues, {
      file: relPath,
      issue: "lint-failed",
      detail: `lint ${fix ? "--fix " : ""}failed for this file: ${e instanceof Error ? e.message : String(e)}`,
      fixed: fix ? "failed" : false,
    });
    return;
  }

  let fileDeleted = false;
  for (const issue of issues) {
    if (isFileDeletion(issue)) {
      fileDeleted = true;
      fixed.push(issue);
    } else if (isAdvisoryLintIssue(issue)) {
      // `lintAssetFile` returns errors only today, so this branch is
      // reached by no current producer — it is here so that an advisory
      // added to a per-type check later cannot silently become a
      // `--fail-on-flagged` failure, the way the unclassified default does.
      warnings.push(issue);
    } else if (issue.fixed === true) {
      fixed.push(issue);
    } else {
      // fixed === false (not fixable / no fix requested) or "failed" (fix attempted but threw)
      flagged.push(issue);
    }
  }

  if (fileDeleted) return; // file is gone — skip any remaining checks

  // The workflow frontend is ONE parse+compile whose output feeds BOTH
  // channels, so it runs here — once per file — rather than inside
  // `lintAssetFile`, which is an errors-only surface (pinned by the lint
  // golden). Which channel a finding lands in is decided by
  // `ADVISORY_LINT_ISSUES`, never by which half of the pass produced it, so
  // a future compile-warning kind carrying a fatal code cannot slip past
  // `--fail-on-flagged`.
  // The CLI passes the absolute filePath to the shared source-IR frontend,
  // whereas the adapter passes the change relPath.
  const frontend = perTypeFrontend(
    { type: typeForStashDir(subdir), ext: path.extname(relPath).toLowerCase(), relPath, raw },
    filePath,
  );
  for (const finding of [...frontend.errors, ...frontend.warnings]) {
    if (isAdvisoryLintIssue(finding)) {
      warnings.push(finding);
    } else {
      flagged.push(finding);
    }
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

/** The stash folders the sweep reads: the document folders, less the types an untyped search leaves out unless `--type` names one. */
function sweepDirs(cfg: AkmConfig, options: AkmLintOptions): string[] {
  const leftOut = new Set(defaultExcludedTypes(cfg).map((type) => stashDirFor(type)));
  return documentStashDirs().filter((d) => (options.typeFilter ? d === options.typeFilter : !leftOut.has(d)));
}

/**
 * Add what the akm adapter's own `validate()` finds in the assets the sweep reads (the same scope), the findings the
 * sweep already made left out: `validate` is where an adapter says what is wrong with its storage, such as a concept
 * held by two files, which the sweep cannot see. Findings are deduped by `lintIssueDedupeKey`.
 */
async function addAdapterFindings(found: LintFindings, run: LintRun): Promise<void> {
  const { bundle, cfg, options } = run;
  const stashRoot = bundle.path;
  const dirs = new Set(sweepDirs(cfg, options));
  // The keys of the assets the sweep reads, as it reads them (the bundle as it stands after the sweep's fixes).
  const inventory = inventoryOf(bundle);
  const inSweepKeys = new Set(
    inventory.assets
      .filter((asset) => {
        const dir = documentDirOf(stashRoot, asset, inventory.types.get(asset));
        return dir !== undefined && dirs.has(dir);
      })
      .map((asset) => asset.entry.key),
  );
  const inSweep = (key: string): boolean => inSweepKeys.has(key);
  const seen = new Set([...found.fixed, ...found.flagged, ...found.warnings].map(lintIssueDedupeKey));
  // A finding the sweep tried to fix is that finding, whether or not the fix landed: a fix that could not be written
  // leaves the file as it was, and the adapter would report it again with its unfixed wording.
  const fixTried = new Set(
    [...found.fixed, ...found.flagged].filter((issue) => issue.fixed !== false).map((i) => `${i.file} ${i.issue}`),
  );
  for (const issue of await validateFindings(run, inSweep)) {
    // A skill directory's check belongs to the skills sweep: `--type knowledge` does not report it.
    if (issue.issue === "missing-skill-md" && !dirs.has("skills")) continue;
    const key = lintIssueDedupeKey(issue);
    if (seen.has(key) || fixTried.has(`${issue.file} ${issue.issue}`)) continue;
    seen.add(key);
    (isAdvisoryLintIssue(issue) ? found.warnings : found.flagged).push(issue);
  }
}

/**
 * The sweep: document-folder walk + per-file `lintAssetFile` + the env dangerous-key pass. Its findings and `--fix`
 * behaviour are pinned by goldens (`tests/integration/lint-parity.test.ts`) and a large test suite.
 */
function lintAkmSweep(run: LintRun): LintFindings {
  const { bundle, cfg, sources, options } = run;
  const stashRoot = bundle.path;
  const fix = options.fix === true;
  // #884: the dangling-edge repair writes too, so it clears the same
  // read-only gate `--fix` does.
  const writes = fix || options.pruneDanglingEdges === true || options.fixMovedRefs === true;
  if (writes) assertFixTargetWritable(stashRoot, sources);
  const sweep = (writer: LintWriter | undefined): LintFindings => {
    const fixed: LintIssue[] = [];
    const flagged: LintIssue[] = [];
    const warnings: LintIssue[] = [];

    const scope = lintScope(stashRoot, cfg, sources, options.readMoves ?? readRecordedMoves);
    const dirsToScan = sweepDirs(cfg, options);

    const inventory = inventoryOf(bundle);
    const markdownAssets = markdownAssetsByType(stashRoot, inventory);
    const assetByFile = new Map(inventory.assets.map((asset) => [fileOfAsset(stashRoot, asset), asset]));
    for (const subdir of dirsToScan) {
      // Tasks have their own `.yml` plus near-miss collector; every other type is Markdown, wherever it sits.
      const files =
        subdir === "tasks"
          ? collectTaskFiles(stashRoot)
          : (markdownAssets.get(subdir) ?? []).map((asset) => fileOfAsset(stashRoot, asset));
      let assetFiles = files;
      if (subdir === "workflows") {
        assetFiles = assetFiles.filter((file) => !isAkmRegistryCachePath(file));
        const ownership = resolveWorkflowLintOwnership(stashRoot, assetFiles);
        assetFiles = ownership.files;
        flagged.push(...ownership.issues);
      }

      // Directory-level check: skills require a SKILL.md entry point (was
      // SkillLinter.lintDirectory). Run once per direct subdirectory before the
      // per-file loop.
      if (subdir === "skills") {
        for (const name of heldFolders(stashRoot, "skills")) {
          for (const issue of lintSkillDirectory(stashRoot, path.join("skills", name))) {
            // Tristate-safe: only `true` counts as fixed; `false` and "failed"
            // are both flagged.
            if (issue.fixed === true) {
              fixed.push(issue);
            } else {
              flagged.push(issue);
            }
          }
        }
      }

      for (const filePath of assetFiles) {
        // Skip registry-cached read-only files — --fix must not mutate them.
        // Compare on a separator-normalized copy: on Windows these paths carry
        // backslashes, so the forward-slash substring never matched and --fix
        // rewrote files inside the registry cache.
        if (isAkmRegistryCachePath(filePath)) continue;
        lintSweepFile(
          sweepFileOf(bundle, filePath, assetByFile.get(filePath), writer),
          subdir,
          {
            ...scope,
            fix,
            fixMovedRefs: options.fixMovedRefs === true,
            pruneDanglingEdges: options.pruneDanglingEdges === true,
          },
          { fixed, flagged, warnings },
        );
      }
    }

    // ── Env dangerous-key pass ─────────────────────────────────────────────────
    // Scan every `.env` file under <stashRoot>/env/ across all stash roots for
    // keys that are known to enable process-execution hijacking. Warn-only —
    // findings go into `flagged`, never `fixed`.
    flagged.push(...envSweepFindings(run));

    // `ok` reflects whether the lint run completed successfully — NOT whether
    // it found anything. Findings are surfaced via `summary.flagged`; the CLI
    // gates its exit code on `--fail-on-flagged`. Conflating "issues exist"
    // with "command failed" caused two downstream problems:
    //   1. `akm lint --json | jq …` saw stdout-flush races on Bun's non-zero
    //      exit, intermittently truncating the JSON the consumer read.
    //   2. `ok` is the shared `{ok, error, code}` failure indicator across the
    //      whole CLI; reusing it for "found stuff" forced callers to disambiguate
    //      a successful-but-flagged run from a hard error by inspecting fields.
    return { fixed, flagged, warnings };
  };
  return sweep(writes ? writerOf(bundle) : undefined);
}

/**
 * What a fix does to an asset. Each change is its own write session, so the asset-mutation lease is taken only when a
 * change is made: a run with nothing to fix (or none asked for) takes none and writes nothing.
 */
interface LintWriter {
  update(conceptId: string, content: string): void;
  delete(conceptId: string): void;
}

function writerOf(bundle: LintBundle): LintWriter {
  return {
    update: (conceptId, content) =>
      void writeAssets(fixTarget(bundle), { purpose: "lint-fix" }, (w) => w.update(conceptId, content)),
    delete: (conceptId) => void writeAssets(fixTarget(bundle), { purpose: "lint-fix" }, (w) => w.delete(conceptId)),
  };
}

/** The write target of the bundle a fix repairs: its policy was checked by {@link assertFixTargetWritable}, which lint owns. */
function fixTarget(bundle: LintBundle): Parameters<typeof writeAssets>[0] {
  return {
    source: {
      kind: "filesystem",
      name: bundle.name,
      path: bundle.path,
      ...(bundle.adapterId ? { adapterId: bundle.adapterId } : {}),
    },
    config: { type: "filesystem", name: bundle.name, path: bundle.path, writable: true },
  };
}

/**
 * `akm lint <file>`: the sweep's own per-file rules (`lintSweepFile`) on one file, rather than a filter threaded
 * through the whole sweep — the sweep's directory-level and cross-bundle passes (skill dirs, env keys, workflow
 * ownership) are bundle concerns that a single file should not trigger. `bundle` is the bundle that holds the file;
 * a file outside every bundle has none and its type comes from `--type`.
 */
export function lintAkmFile(
  file: { given: string; real: string },
  bundle: LintBundle | undefined,
  sources: SearchSource[],
  cfg: AkmConfig,
  options: AkmLintOptions,
): LintFindings {
  const { given, real: absFile } = file;
  const root = bundle?.path;
  // Symlink-resolved, so a file's bundle-relative path is right however either was spelled.
  const realRoot = root ? fs.realpathSync(root) : undefined;
  const typeValues = documentTypes().join(", ");
  let subdir: string | undefined;
  if (root && realRoot) {
    const relPath = path.relative(realRoot, absFile);
    // The type comes from where the file sits, as the bundle sweep decides it.
    const located = documentStashDirs().find((d) => relPath.split(path.sep)[0] === d);
    const firstSegment = relPath.split(path.sep)[0] ?? "";
    if (!located && typeForStashDir(firstSegment) !== undefined) {
      throw new UsageError(
        `lint: "${relPath}" is a ${typeForStashDir(firstSegment)} asset, which lint does not read as a document.`,
        "INVALID_FLAG_VALUE",
      );
    }
    if (located && options.typeFilter && options.typeFilter !== located) {
      throw new UsageError(
        `lint: --type "${options.typeFilter}" does not match "${relPath}", which is a ${located} file in this bundle.`,
        "INVALID_FLAG_VALUE",
      );
    }
    subdir = located ?? options.typeFilter;
    if (!subdir) {
      throw new UsageError(
        `lint: "${relPath}" is not under a known asset directory; pass --type (${typeValues}).`,
        "MISSING_REQUIRED_ARGUMENT",
        "Example: akm lint ./nightly.yml --type tasks",
      );
    }
    if (options.fix || options.fixMovedRefs) assertFixTargetWritable(root, sources);
  } else {
    subdir = options.typeFilter;
    if (!subdir) {
      throw new UsageError(
        `lint: "${given}" is outside every bundle; pass --type (${typeValues}).`,
        "MISSING_REQUIRED_ARGUMENT",
        "Example: akm lint ./nightly.yml --type tasks",
      );
    }
  }
  if (documentFormatForStashDir(subdir) === undefined) {
    throw new UsageError(
      `lint: --type "${subdir}" is not recognized; valid types: ${typeValues}.`,
      "INVALID_FLAG_VALUE",
    );
  }
  const name = path.basename(absFile);
  const fits =
    subdir === "tasks" ? isTaskFileName(name) || isNearMissTaskFileName(name) : name.toLowerCase().endsWith(".md");
  if (!fits) {
    throw new UsageError(
      `lint: "${given}" is not a ${subdir} file (expects ${subdir === "tasks" ? `${TASK_EXTENSION}` : ".md"}).`,
      "INVALID_FLAG_VALUE",
    );
  }

  const sinks: SweepSinks = { fixed: [], flagged: [], warnings: [] };
  const readMoves = options.readMoves ?? readRecordedMoves;
  const scope = {
    ...(root ? lintScope(root, cfg, sources, readMoves) : lintScope(path.dirname(absFile), cfg, [], readMoves)),
    fix: options.fix === true,
    fixMovedRefs: options.fixMovedRefs === true,
    pruneDanglingEdges: false,
    // Outside a bundle there are no other assets to resolve refs or a derived stub against.
    lintSkip: root ? undefined : ["missing-ref", "orphaned-stub"],
  };
  if (bundle && realRoot) {
    const asset = assetAtStoredKey(bundle, path.relative(realRoot, absFile).split(path.sep).join("/"));
    const writer = scope.fix || scope.fixMovedRefs ? writerOf(bundle) : undefined;
    lintSweepFile(sweepFileOf({ ...bundle, path: realRoot }, absFile, asset, writer), subdir, scope, sinks);
  } else {
    // A file outside every bundle is no asset: the one the user named is read and, under `--fix`, saved as it lies.
    lintSweepFile(
      {
        filePath: absFile,
        relPath: given,
        read: () => fs.readFileSync(absFile, "utf8"),
        io: {
          write: (raw) => fs.writeFileSync(absFile, raw, "utf8"),
          remove: () => fs.unlinkSync(absFile),
        },
      },
      subdir,
      scope,
      sinks,
    );
  }
  return sinks;
}

/**
 * The findings for `content` as the text of the asset at `relPath` of the akm bundle at `root`, by the checks `akm lint`
 * runs on that file. Nothing is read from or written to the file. `subdir` is the stash folder of the asset's type.
 */
export function lintAkmText(input: {
  root: string;
  relPath: string;
  subdir: string;
  content: string;
  cfg: AkmConfig;
  readMoves: ReadMoves;
}): LintFindings {
  const { root, cfg } = input;
  const sinks: SweepSinks = { fixed: [], flagged: [], warnings: [] };
  lintDocument(
    input.content,
    path.join(root, input.relPath),
    input.relPath,
    input.subdir,
    {
      ...lintScope(root, cfg, resolveSourceEntries(root, cfg), input.readMoves),
      fix: false,
      fixMovedRefs: false,
      pruneDanglingEdges: false,
    },
    sinks,
  );
  return sinks;
}

/** `akm lint` of an akm bundle (or one file of it): the sweep, then what the adapter's own `validate` adds. */
export async function lintAkmBundle(run: LintRun): Promise<LintFindings> {
  if (run.file) return lintAkmFile(run.file, run.bundle, run.sources, run.cfg, run.options);
  // An unknown `--type` used to filter the walk to ZERO directories — a false-clean result on the classic
  // singular/plural typo ("workflow" for "workflows"). Other adapters keep their own type vocabularies.
  let { options } = run;
  if (options.typeFilter && documentFormatForStashDir(options.typeFilter) === undefined) {
    warn(
      `Warning: lint --type "${options.typeFilter}" is not a recognized akm asset type — ` +
        `valid types: ${documentTypes().join(", ")}. The whole bundle was validated.`,
    );
    options = { ...options, typeFilter: undefined };
  }
  const swept: LintRun = { ...run, options };
  const found = lintAkmSweep(swept);
  await addAdapterFindings(found, swept);
  return found;
}
