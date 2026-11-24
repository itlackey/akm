// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fs from "node:fs";
import path from "node:path";
import type { Diagnostic } from "../../core/adapter/types";
import {
  documentFormatForStashDir,
  documentStashDirFor,
  documentStashDirs,
  documentTypes,
  refForFile,
  stashDirFor,
  typeForStashDir,
} from "../../core/asset/asset-placement";
import { parseFrontmatter } from "../../core/asset/frontmatter";
import { conceptIdForStashFile, displayRefForConceptId } from "../../core/asset/resolve-ref";
import { adapterDeclaresTypes, adapterLintsAlone, bundleAdapterId } from "../../core/assets/gate";
import {
  assertFileWritable,
  heldFilesBelow,
  heldFolders,
  heldText,
  holdsFile,
  saveHeldText,
} from "../../core/assets/held";
import type { Asset } from "../../core/assets/read";
import { assetTypesByContent } from "../../core/assets/type";
import {
  assetAtStoredKey,
  derivedSiblingPath,
  type FileDiagnostic,
  listBundleAssets,
  MAX_SKILL_GROUP_DEPTH,
  matchWorkflowPlaceholder,
  perTypeChecks,
  perTypeFrontend,
  storeFindings,
  validateBundleAssets,
} from "../../core/assets/validate";
import { writeAssets } from "../../core/assets/write";
import { bundleSourceAt } from "../../core/bundle-at-dir";
import { deriveBundleIds } from "../../core/bundle-id";
import { compareCodePoints, isAkmRegistryCachePath, resolveStashDir, safeRealpath, samePath } from "../../core/common";
import type { AkmConfig } from "../../core/config/config";
import { loadConfig, primaryBundlePath } from "../../core/config/config";
import { bundleAtDir } from "../../core/config/config-sources";
import { defaultExcludedTypes } from "../../core/config/schema/search";
import { UsageError } from "../../core/errors";
import { warn } from "../../core/warn";
import { resolveSourceEntries, type SearchSource } from "../../indexer/search/search-source";
import { TASK_EXTENSION, TASK_NEAR_MISS_EXTENSION, taskExtensionDetail } from "../../tasks/source-v3";
import { isUsableWorkflowSource, isWorkflowSource, resolveWorkflowSourceDomains } from "../../workflows/source-files";
import { runBaseChecks } from "./base-linter";
import { bundleLintSkip } from "./bundle-skip";
import { checkEnvForDangerousKeys } from "./env-key-rules";
import { type MovedRefs, type ReadMoves, readRecordedMoves } from "./moved-refs";
import { lintScope } from "./scope";
import { trackedSecretIssues } from "./tracked-secrets";
import { isAdvisoryLintIssue, LINT_RULES, type LintContext, type LintIssue, type LintIssueType } from "./types";

// ── Public API types (re-exported for consumers) ──────────────────────────────

export type { LintIssue, LintIssueType } from "./types";

export interface AkmLintResult {
  ok: boolean;
  fixed: LintIssue[];
  flagged: LintIssue[];
  /**
   * Non-fatal advisories (issue code `workflow-warning`: workflow compile
   * warnings such as a step missing its `output:` schema). Kept OUT of
   * `flagged` so `--fail-on-flagged` never fails a run over an advisory.
   */
  warnings: LintIssue[];
  summary: { fixed: number; flagged: number; warnings: number };
  /** Flagged findings per rule: how many findings, in how many assets. */
  byRule: Record<string, { findings: number; assets: number }>;
  /** The rule the run was narrowed to (`--rule`). */
  rule?: string;
}

/** What a lint pass found, before skips, refs and the per-rule summary are applied. */
interface LintFindings {
  fixed: LintIssue[];
  flagged: LintIssue[];
  warnings: LintIssue[];
}

export interface AkmLintOptions {
  fix?: boolean;
  /**
   * #884 opt-in repair: drop belief-channel entries whose target resolves to
   * neither a live file nor a prune tombstone. Independent of `fix` — see the
   * flag's rationale in `commands/agent/contribute-cli.ts`.
   */
  pruneDanglingEdges?: boolean;
  /**
   * Rewrite the links to refs the index recorded as moved, and nothing else (`fix` rewrites them too). Not a command
   * flag: the workspace's "update links" is this.
   */
  fixMovedRefs?: boolean;
  dir?: string;
  config?: AkmConfig;
  typeFilter?: string;
  /** Only report this rule's findings (listing only: it cannot combine with a fix). */
  rule?: string;
  /** Lint this one file instead of a whole bundle (`akm lint <file>`). */
  file?: string;
  /**
   * How the recorded moves are read, asked only when a ref did not resolve. A caller that holds its own connection to
   * state.db (the improve dry run's snapshot) passes it; otherwise they are read through the ordinary read-only one.
   */
  readMoves?: ReadMoves;
  /**
   * Also check the keyrings and vaults among the configured bundles through their adapters (a name akm cannot list, two
   * entries of one name). `akm lint` without `--dir` or a file asks; a store that cannot be reached is skipped.
   */
  stores?: boolean;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Every task-shaped file under `tasks/`: the recognized `.yml` spelling AND the
 * `.yaml` near-miss. A `.yaml` file is not a runnable task — it is invisible to
 * the indexer's `tasks` matcher — but collecting it here is what lets the sweep
 * SAY so (`invalid-task-yaml`, see {@link taskExtensionDetail}) instead of
 * walking past it and reporting a clean scan.
 */
function collectTaskFiles(root: string): string[] {
  return heldFilesBelow({ path: root }, "tasks", (name) => isTaskFileName(name) || isNearMissTaskFileName(name));
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

/** The bundle a lint pass reads: the one the facade holds at `path`. */
interface LintBundle {
  name: string;
  path: string;
  adapterId?: string;
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

// ── Non-akm adapter dispatch (real `adapter.validate()`, not a re-implementation) ──
//
// Every bundle is linted by its own configured or detected adapter's `validate()`: the one definition of that
// format's rules, shared with the advisory change-transaction pre-commit gate in `commands/proposal/repository.ts`.
// Routing a non-akm bundle through the akm sweep below would apply the wrong linter to the wrong format and leave the
// adapter's own checks unreachable, so the dispatch stays outside that sweep.
// The sweep's workflow branch separately supports authoritative peer `.md` and
// `.yml` sources while preserving the pinned Markdown findings/`--fix` bytes.

/**
 * Every closed {@link LintIssueType} member a current adapter `validate()` can
 * legitimately emit. Anything outside this set folds onto `"adapter-diagnostic"`
 * (see `types.ts`'s doc comment on that member) rather than being dropped.
 */
const KNOWN_ADAPTER_ISSUE_TYPES: ReadonlySet<string> = new Set<LintIssueType>([
  "unquoted-colon",
  "missing-updated",
  "stale-path",
  "missing-ref",
  "missing-type",
  "missing-name-or-type",
  "missing-skill-md",
  // The `akm-task` adapter's own code, reported by `akm lint` for a
  // malformed or misnamed task file; without it here, a genuine
  // task finding would arrive folded onto `adapter-diagnostic`.
  "invalid-task-yaml",
  "dangerous-env-key",
  "uncited-raw",
  "missing-description",
  "broken-xref",
  "broken-source",
  "shadowed-spelling",
  "type-from-content",
  "invalid-workflow-structure",
  "workflow-warning",
]);

/** Map one adapter {@link Diagnostic} onto a {@link LintIssue} — see `types.ts`'s `"adapter-diagnostic"` doc comment for the open→closed reconciliation. */
export function diagnosticToLintIssue({ ref, ...diag }: Diagnostic): LintIssue {
  const issue = { ...diag, file: diag.file ?? ref };
  if (KNOWN_ADAPTER_ISSUE_TYPES.has(issue.issue)) return { ...issue, issue: issue.issue as LintIssueType };
  return { ...issue, issue: "adapter-diagnostic", detail: `[${issue.issue}] ${issue.detail}` };
}

/**
 * What the adapter's `validate()` reports for the assets of the bundle at `stashRoot` that `keep` admits (all of them
 * by default), as lint findings. The edits are the assets the adapter lists (one per concept): `validate` finds the
 * files it ignores itself.
 */
async function adapterFindings(
  adapterId: string,
  stashRoot: string,
  keep: ((key: string) => boolean) | undefined,
  sources: SearchSource[],
  cfg: AkmConfig,
  options: AkmLintOptions,
): Promise<LintIssue[]> {
  const found = await validateBundleAssets(lintBundleOf(adapterId, stashRoot, sources), {
    // akm's own resolved registry-cache copies are not the bundle's content.
    keep: (entry) =>
      !isAkmRegistryCachePath(path.join(stashRoot, entry.key)) && (keep === undefined || keep(entry.key)),
    ctx: { sources, config: cfg, readMoves: options.readMoves ?? readRecordedMoves },
  });
  return found.map(diagnosticToLintIssue);
}

/** The bundle at `stashRoot` among the configured `sources`, under the id refs name it by (its path when none is configured there). */
function lintBundleOf(adapterId: string, stashRoot: string, sources: SearchSource[]): LintBundle {
  const ids = deriveBundleIds(sources);
  const sourceIndex = sources.findIndex((s) => samePath(s.path, stashRoot));
  return { name: sourceIndex >= 0 ? (ids[sourceIndex] as string) : stashRoot, path: stashRoot, adapterId };
}

/**
 * What the configured keyring and vault bundles report about their stores (an entry akm cannot list, two entries of one
 * name). A finding names its asset by ref, since no file holds it.
 */
async function addStoreFindings(
  found: LintFindings,
  sources: SearchSource[],
  cfg: AkmConfig,
  options: AkmLintOptions,
): Promise<void> {
  // Secrets are the stores' only type: a `--type` for another one leaves them out.
  if (options.stores !== true || (options.typeFilter !== undefined && options.typeFilter !== "secrets")) return;
  const ctx = { sources, config: cfg, readMoves: options.readMoves ?? readRecordedMoves };
  for (const diagnostic of await storeFindings(sources, ctx)) {
    const issue = { ...diagnosticToLintIssue(diagnostic), ref: diagnostic.ref };
    (isAdvisoryLintIssue(issue) ? found.warnings : found.flagged).push(issue);
  }
}

/**
 * Lint a bundle through its OWN adapter's `validate()`: the
 * adapter never writes, so every finding lands in `flagged` — `fixed` is
 * always `false`/`"failed"` for a non-akm bundle regardless of `--fix`
 * (the CLI option is silently a no-op here, exactly as it already was for
 * `okf` before this change).
 */
async function lintViaAdapter(
  adapterId: string,
  stashRoot: string,
  extraStashRoots: string[],
  sources: SearchSource[],
  cfg: AkmConfig,
  options: AkmLintOptions,
): Promise<LintFindings> {
  // `--type` names an AKM stash subdir; every other adapter has its own type
  // vocabulary and `validate()` sees the whole bundle regardless. That is not a
  // correctness problem (full-bundle validation is a superset of the requested
  // scope), but a user narrowing a run deserves to hear the flag did nothing
  // rather than infer it from identical output. Warn, don't throw:
  // a hard error would break scripts passing one `--type` across mixed-adapter
  // bundle sets.
  if (options.typeFilter) {
    warn(
      `Warning: lint --type "${options.typeFilter}" is not supported for the "${adapterId}" adapter — ` +
        "type scoping applies to akm bundles only; the whole bundle was validated.",
    );
  }

  const mapped = await adapterFindings(adapterId, stashRoot, undefined, sources, cfg, options);

  // Advisory diagnostics travel in their own channel — never `flagged`, so a
  // `--fail-on-flagged` gate is not tripped by a non-fatal warning. Classified
  // by the shared `ADVISORY_LINT_ISSUES` set rather than a code spelled out
  // here, so this and the sweep below can never disagree about a code.
  const warnings = mapped.filter(isAdvisoryLintIssue);
  const flagged = mapped.filter((issue) => !isAdvisoryLintIssue(issue));
  // The cross-bundle env dangerous-key sweep (see `runEnvDangerousKeyPass`'s
  // doc comment) ran for every non-akm adapter via the akm sweep
  // fallthrough this dispatch replaces — EXCEPT `okf`, which the old code
  // special-cased out before ever reaching that pass. Preserve both halves of
  // that history exactly: skip only for `okf`. Some adapters (`dotenv`) ALSO
  // find the same `dangerous-env-key` findings natively through their own
  // `validate()` (reusing the same `dangerousEnvKeyDiagnostics` rule) — dedupe
  // by `(file, issue, detail)` so a bundle covered both ways reports each
  // finding once, not twice.
  if (!adapterLintsAlone(adapterId)) {
    const seen = new Set(flagged.map(lintIssueDedupeKey));
    for (const issue of runEnvDangerousKeyPass(stashRoot, extraStashRoots, sources, cfg)) {
      const key = lintIssueDedupeKey(issue);
      if (seen.has(key)) continue;
      seen.add(key);
      flagged.push(issue);
    }
  }
  return { fixed: [], flagged, warnings };
}

function lintIssueDedupeKey(issue: LintIssue): string {
  return `${issue.file} ${issue.issue} ${issue.detail}`;
}

/**
 * Scan every `env/`/`secrets/` `.env` file across `[stashRoot, ...extraStashRoots]`
 * for keys that are known to enable process-execution hijacking. This is a
 * cross-bundle SECURITY sweep, not per-adapter validation — it has always run
 * regardless of which format family a given root's OWN files are (verbatim
 * extraction of the pass `lintAkmSweep` still runs inline; shared with
 * the non-akm dispatch path so a non-akm PRIMARY bundle gets the same
 * cross-bundle coverage).
 */
function runEnvDangerousKeyPass(
  stashRoot: string,
  extraStashRoots: string[],
  sources: SearchSource[],
  cfg: AkmConfig,
): LintIssue[] {
  const flagged: LintIssue[] = [];
  const envRoots = [stashRoot, ...extraStashRoots];
  const bundleIdByRoot = new Map(sources.map((source) => [safeRealpath(source.path), source.registryId]));
  for (const root of envRoots) {
    const bundleId = bundleIdByRoot.get(safeRealpath(root));
    // `env` assets live under `env/`, whole-file `secret` assets under
    // `secrets/`. `displayRefForConceptId` owns the short-default /
    // qualified-secondary `Ref:` spelling `akm show` emits — the old
    // hand-built `env:<base>` colon grammar is rejected by the ref
    // parser, which dead-ended a user copying the ref off a security finding.
    for (const assetType of ["env", "secret"] as const) {
      for (const envPath of heldFilesBelow({ path: root }, stashDirFor(assetType) as string, (name) =>
        name.endsWith(".env"),
      )) {
        const conceptId = conceptIdForStashFile(assetType, root, envPath);
        const ref = displayRefForConceptId(conceptId, bundleId, cfg.defaultBundle);
        const relPath = path.relative(root, envPath);
        for (const issue of checkEnvForDangerousKeys(heldText(envPath), relPath, ref)) {
          flagged.push(issue);
        }
      }
    }
  }
  return flagged;
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
  if (holdsFile({ path: stashRoot }, path.join(relDir, "SKILL.md"))) return [];
  const children = depth < MAX_SKILL_GROUP_DEPTH ? skillSubfolders(stashRoot, relDir) : [];
  if (children.some((child) => containsSkillManifest(stashRoot, child, depth + 1))) {
    return children.flatMap((child) => lintSkillDirectory(stashRoot, child, depth + 1));
  }
  return [{ file: relDir, issue: "missing-skill-md", detail: `no SKILL.md in ${relDir}/`, fixed: false }];
}

/** The folders of `relDir` that are not hidden, as bundle-relative paths. */
function skillSubfolders(stashRoot: string, relDir: string): string[] {
  return heldFolders({ path: stashRoot }, relDir)
    .filter((name) => !name.startsWith("."))
    .map((name) => path.join(relDir, name));
}

function containsSkillManifest(stashRoot: string, relDir: string, depth: number): boolean {
  if (holdsFile({ path: stashRoot }, path.join(relDir, "SKILL.md"))) return true;
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
    derivedSiblingExists: holdsFile({ path: ctx.stashRoot }, derivedSiblingPath(ctx.relPath)),
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
              writer.update(asset.conceptId, raw, { throughLink: true });
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
async function addAdapterFindings(
  found: LintFindings,
  adapterId: string,
  stashRoot: string,
  sources: SearchSource[],
  cfg: AkmConfig,
  options: AkmLintOptions,
): Promise<void> {
  const dirs = new Set(sweepDirs(cfg, options));
  // The keys of the assets the sweep reads, as it reads them (the bundle as it stands after the sweep's fixes).
  const inventory = inventoryOf(lintBundleOf(adapterId, stashRoot, sources));
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
  for (const issue of await adapterFindings(adapterId, stashRoot, inSweep, sources, cfg, options)) {
    // A skill directory's check belongs to the skills sweep: `--type knowledge` does not report it.
    if (issue.issue === "missing-skill-md" && !dirs.has("skills")) continue;
    const key = lintIssueDedupeKey(issue);
    if (seen.has(key) || fixTried.has(`${issue.file} ${issue.issue}`)) continue;
    seen.add(key);
    (isAdvisoryLintIssue(issue) ? found.warnings : found.flagged).push(issue);
  }
}

/**
 * The `akm`-adapter sweep: document-folder walk + per-file `lintAssetFile` +
 * the env dangerous-key pass. UNTOUCHED by the adapter-dispatch wiring above
 * (CRITICAL CONSTRAINT — the overwhelming majority of real bundles use `akm`,
 * and its findings / `--fix` behavior / exact `LintIssueType` codes are
 * pinned by goldens + a large test suite). Only reached when the resolved
 * adapter id is `"akm"` (or, defensively, an unregistered adapter id —
 * see {@link lintViaAdapter}'s fallback).
 */
function lintAkmSweep(
  adapterId: string,
  stashRoot: string,
  extraStashRoots: string[],
  cfg: AkmConfig,
  sources: SearchSource[],
  options: AkmLintOptions,
): LintFindings {
  const fix = options.fix === true;
  // #884: the dangling-edge repair writes too, so it clears the same
  // read-only gate `--fix` does.
  const writes = fix || options.pruneDanglingEdges === true || options.fixMovedRefs === true;
  if (writes) assertFixTargetWritable(stashRoot, sources);
  const bundle = lintBundleOf(adapterId, stashRoot, sources);
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
        for (const name of heldFolders({ path: stashRoot }, "skills")) {
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
    flagged.push(...runEnvDangerousKeyPass(stashRoot, extraStashRoots, sources, cfg));

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
  update(conceptId: string, content: string, options: { throughLink: boolean }): void;
  delete(conceptId: string): void;
}

function writerOf(bundle: LintBundle): LintWriter {
  return {
    update: (conceptId, content, options) =>
      void writeAssets(fixTarget(bundle), { purpose: "lint-fix" }, (w) => w.update(conceptId, content, options)),
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

/** The configured bundle root (or `--dir`) that contains `file`, deepest first; undefined when `file` is outside every bundle. */
function containingBundleRoot(file: string, roots: readonly string[]): string | undefined {
  const real = (p: string): string => fs.realpathSync(p);
  const target = real(file);
  return (
    roots
      // asset-io: bundle-root root probe
      .filter((root) => fs.existsSync(root))
      .filter((root) => {
        const rel = path.relative(real(root), target);
        return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
      })
      .sort((a, b) => b.length - a.length)[0]
  );
}

/**
 * `akm lint <file>`: the sweep's own per-file rules (`lintSweepFile`) on one
 * file, rather than a filter threaded through the whole sweep — the sweep's
 * directory-level and cross-bundle passes (skill dirs, env keys, workflow
 * ownership) are bundle concerns that a single file should not trigger. A file
 * in a non-akm bundle runs that adapter and keeps only this file's findings.
 */
async function lintFile(file: string, options: AkmLintOptions, cfg: AkmConfig): Promise<AkmLintResult> {
  if (options.pruneDanglingEdges) {
    throw new UsageError("lint: --prune-dangling-edges applies to a bundle, not a single file.", "INVALID_FLAG_VALUE");
  }
  // asset-io: user-input the file named
  const stat = fs.statSync(file, { throwIfNoEntry: false });
  if (!stat) throw new UsageError(`lint: "${file}" does not exist.`, "INVALID_FLAG_VALUE");
  if (stat.isDirectory()) {
    throw new UsageError(`lint: "${file}" is a directory; use --dir to lint a bundle.`, "INVALID_FLAG_VALUE");
  }
  const absFile = fs.realpathSync(file);
  // A machine with no bundle at all can still lint a loose file, so a missing primary bundle is not an error here.
  let primary: string | undefined = options.dir ?? primaryBundlePath(cfg);
  if (!primary) {
    try {
      primary = resolveStashDir();
    } catch {
      primary = undefined;
    }
  }
  const root = containingBundleRoot(absFile, [
    ...(options.dir ? [options.dir] : []),
    ...(primary ? resolveSourceEntries(primary, cfg).map((source) => source.path) : []),
  ]);

  // Symlink-resolved, so a file's bundle-relative path is right however either was spelled.
  const realRoot = root ? fs.realpathSync(root) : undefined;
  const typeValues = documentTypes().join(", ");
  let subdir: string | undefined;
  if (root) {
    const sources = resolveSourceEntries(root, cfg);
    const { adapterId } = bundleSourceAt(root, cfg);
    const relPath = path.relative(realRoot as string, absFile);
    if (!adapterDeclaresTypes(adapterId)) {
      const result = await lintViaAdapter(
        adapterId,
        root,
        // asset-io: bundle-root root probe
        sources.map((s) => s.path).filter((p) => p !== root && fs.existsSync(p)),
        sources,
        cfg,
        { ...options, typeFilter: undefined },
      );
      const only = (issues: LintIssue[]): LintIssue[] =>
        issues.filter((i) => path.resolve(realRoot as string, i.file) === absFile);
      return finishLint(
        { fixed: [], flagged: only(result.flagged), warnings: only(result.warnings) },
        cfg,
        options,
        root,
      );
    }
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
        `lint: "${file}" is outside every bundle; pass --type (${typeValues}).`,
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
      `lint: "${file}" is not a ${subdir} file (expects ${subdir === "tasks" ? `${TASK_EXTENSION}` : ".md"}).`,
      "INVALID_FLAG_VALUE",
    );
  }

  const sinks: SweepSinks = { fixed: [], flagged: [], warnings: [] };
  const scope = {
    ...(root
      ? lintScope(root, cfg, resolveSourceEntries(root, cfg), options.readMoves ?? readRecordedMoves)
      : lintScope(path.dirname(absFile), cfg, [], options.readMoves ?? readRecordedMoves)),
    fix: options.fix === true,
    fixMovedRefs: options.fixMovedRefs === true,
    pruneDanglingEdges: false,
    // Outside a bundle there are no other assets to resolve refs or a derived stub against.
    lintSkip: root ? undefined : ["missing-ref", "orphaned-stub"],
  };
  if (root && realRoot) {
    const bundle = lintBundleOf(bundleSourceAt(root, cfg).adapterId, root, resolveSourceEntries(root, cfg));
    const asset = assetAtStoredKey(bundle, path.relative(realRoot, absFile).split(path.sep).join("/"));
    const writer = scope.fix || scope.fixMovedRefs ? writerOf(bundle) : undefined;
    lintSweepFile(sweepFileOf({ ...bundle, path: realRoot }, absFile, asset, writer), subdir as string, scope, sinks);
  } else {
    // A file outside every bundle is no asset: the one the user named is read and, under `--fix`, saved as it lies.
    lintSweepFile(
      {
        filePath: absFile,
        relPath: file,
        // asset-io: user-input the file named
        read: () => fs.readFileSync(absFile, "utf8"),
        io: {
          // asset-io: user-input the file named
          write: (raw) => fs.writeFileSync(absFile, raw, "utf8"),
          // asset-io: user-input the file named
          remove: () => fs.unlinkSync(absFile),
        },
      },
      subdir as string,
      scope,
      sinks,
    );
  }
  return finishLint(sinks, cfg, options, root);
}

/**
 * The findings for `content` as the text of the asset at `relPath` of the akm bundle at `root`, by the checks `akm lint`
 * runs on that file. Nothing is read from or written to the file. `subdir` is the stash folder of the asset's type.
 */
export function lintDocumentText(input: {
  root: string;
  relPath: string;
  subdir: string;
  content: string;
  config?: AkmConfig;
  readMoves?: ReadMoves;
}): Pick<AkmLintResult, "flagged" | "warnings"> {
  const cfg = input.config ?? loadConfig();
  const { root } = input;
  const sinks: SweepSinks = { fixed: [], flagged: [], warnings: [] };
  lintDocument(
    input.content,
    path.join(root, input.relPath),
    input.relPath,
    input.subdir,
    {
      ...lintScope(root, cfg, resolveSourceEntries(root, cfg), input.readMoves ?? readRecordedMoves),
      fix: false,
      fixMovedRefs: false,
      pruneDanglingEdges: false,
    },
    sinks,
  );
  const { flagged, warnings } = finishLint(sinks, cfg, {}, root);
  return { flagged, warnings };
}

/** The ref of an asset of the bundle at `root` by its bundle-relative `file`; undefined when `file` is not an asset path. */
function refOfFile(root: string, file: string, cfg: AkmConfig): string | undefined {
  const type = typeForStashDir(file.split(/[\\/]/)[0] ?? "");
  const conceptId = type ? refForFile(type, root, path.join(root, file)) : undefined;
  if (conceptId === undefined) return undefined;
  const bundleId = bundleAtDir(cfg, root);
  return displayRefForConceptId(conceptId, bundleId, cfg.defaultBundle);
}

/**
 * Turn what a pass found into the result: drop what the bundle's `lint.skip`
 * names, give each finding its asset ref, narrow to `--rule`, and count the
 * flagged findings per rule.
 */
function finishLint(found: LintFindings, cfg: AkmConfig, options: AkmLintOptions, root?: string): AkmLintResult {
  const skippedRules = root ? bundleLintSkip(cfg, root) : () => [];
  let rule = options.rule;
  if (rule !== undefined && !(LINT_RULES as readonly string[]).includes(rule)) {
    warn(
      `Warning: lint --rule "${rule}" is not a lint rule — valid rules: ${LINT_RULES.join(", ")}. Showing every rule.`,
    );
    rule = undefined;
  }
  const keep = (issue: LintIssue): boolean =>
    (rule === undefined || issue.issue === rule) && !skippedRules(issue.file).includes(issue.issue);
  const fixed = found.fixed.filter((issue) => rule === undefined || issue.issue === rule);
  const flagged = found.flagged.filter(keep);
  const warnings = found.warnings.filter(keep);
  if (root) {
    for (const issue of [...fixed, ...flagged, ...warnings]) issue.ref ??= refOfFile(root, issue.file, cfg);
  }
  const byRule: AkmLintResult["byRule"] = {};
  const assetsByRule = new Map<string, Set<string>>();
  for (const issue of flagged) {
    const assets = (assetsByRule.get(issue.issue) ?? new Set<string>()).add(issue.file);
    assetsByRule.set(issue.issue, assets);
    byRule[issue.issue] = { findings: (byRule[issue.issue]?.findings ?? 0) + 1, assets: assets.size };
  }
  return {
    ok: true,
    fixed,
    flagged,
    warnings,
    summary: { fixed: fixed.length, flagged: flagged.length, warnings: warnings.length },
    byRule,
    ...(rule === undefined ? {} : { rule }),
  };
}

/**
 * Lint the resolved bundle at `options.dir` (default: the primary bundle).
 * Dispatches to the bundle's OWN adapter: the `akm` sweep for `"akm"`
 * (unchanged), or {@link lintViaAdapter} — a real `adapter.validate()` call —
 * for every other configured/detected adapter id (OKF, llm-wiki, dotenv,
 * claude, opencode, agent-skills, website-snapshot, generic-files, akm-task,
 * akm-workflow). `async` because `BundleAdapter.validate()` is async by
 * interface contract (`core/adapter/bundle-adapter.ts`); every existing
 * caller already runs inside an async context (`commands/agent/contribute-cli.ts`,
 * `commands/improve/preparation.ts`) or is a test that can `await` it.
 */
export async function akmLint(options: AkmLintOptions = {}): Promise<AkmLintResult> {
  if (options.rule !== undefined && (options.fix || options.pruneDanglingEdges || options.fixMovedRefs)) {
    throw new UsageError(
      "lint: --rule lists findings; run it without --fix or --prune-dangling-edges.",
      "INVALID_FLAG_VALUE",
    );
  }
  // Fail closed on a mistyped invocation: a nonexistent --dir would walk
  // nothing and report a clean `ok:true, flagged:0`, silently passing scripted
  // --fail-on-flagged gates.
  // asset-io: user-input --dir
  if (options.dir !== undefined && !fs.statSync(options.dir, { throwIfNoEntry: false })?.isDirectory()) {
    throw new UsageError(`lint: --dir "${options.dir}" is not a directory.`, "INVALID_FLAG_VALUE");
  }
  // Collect secondary stash roots from configured filesystem sources so that
  // cross-stash refs (e.g. referencing assets in dimm-city/agent-stash) are
  // not falsely flagged as missing-ref.
  const cfg = options.config ?? loadConfig();
  // `--type` names a type or its folder; the sweep and the single-file path work on the folder.
  if (options.typeFilter)
    options = { ...options, typeFilter: documentStashDirFor(options.typeFilter) ?? options.typeFilter };
  if (options.file !== undefined) return lintFile(options.file, options, cfg);
  // The primary stash is the defaultBundle's path.
  const stashRoot = options.dir ?? primaryBundlePath(cfg) ?? resolveStashDir();
  const sources = resolveSourceEntries(stashRoot, cfg);
  const adapterId = bundleAdapterId(sources.find((source) => samePath(source.path, stashRoot)) ?? {});
  // asset-io: bundle-root root probe
  const extraStashRoots = sources.map((s) => s.path).filter((p) => p !== stashRoot && fs.existsSync(p));

  if (!adapterDeclaresTypes(adapterId)) {
    const found = await lintViaAdapter(adapterId, stashRoot, extraStashRoots, sources, cfg, options);
    found.flagged.push(...trackedSecretIssues(stashRoot));
    await addStoreFindings(found, sources, cfg, options);
    return finishLint(found, cfg, options, stashRoot);
  }
  // Same fail-closed rule for --type on the akm sweep: an unknown value used
  // to filter the walk to ZERO directories — a false-clean result on the
  // classic singular/plural typo ("workflow" for "workflows"). Non-akm
  // adapters keep their own type vocabularies (see lintViaAdapter).
  if (options.typeFilter && documentFormatForStashDir(options.typeFilter) === undefined) {
    warn(
      `Warning: lint --type "${options.typeFilter}" is not a recognized akm asset type — ` +
        `valid types: ${documentTypes().join(", ")}. The whole bundle was validated.`,
    );
    options = { ...options, typeFilter: undefined };
  }
  // The sweep and the adapter's checks both ask about moved refs: the recorded moves are read once between them.
  const readMoves = options.readMoves ?? readRecordedMoves;
  let moves: ReturnType<ReadMoves> | undefined;
  options = { ...options, readMoves: () => (moves ??= readMoves()) };
  const found = lintAkmSweep(adapterId, stashRoot, extraStashRoots, cfg, sources, options);
  await addAdapterFindings(found, adapterId, stashRoot, sources, cfg, options);
  found.flagged.push(...trackedSecretIssues(stashRoot));
  await addStoreFindings(found, sources, cfg, options);
  return finishLint(found, cfg, options, stashRoot);
}
