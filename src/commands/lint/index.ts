// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fs from "node:fs";
import path from "node:path";
import {
  factDiagnostics,
  matchWorkflowPlaceholder,
  memoryOrphanStubApplies,
  nameOrTypeDiagnostics,
  ORPHANED_STUB_DETAIL,
  taskDiagnostics,
  workflowFrontendDiagnostics,
  workflowYamlSourceDiagnostics,
} from "../../core/adapter/adapters/akm-lint";
import { detectAdapterId } from "../../core/adapter/detect-adapter";
import { adapterForId } from "../../core/adapter/registry";
import type { Diagnostic } from "../../core/adapter/types";
import { createValidateContext } from "../../core/adapter/validate-context";
import { stashDirFor } from "../../core/asset/asset-placement";
import { parseFrontmatter } from "../../core/asset/frontmatter";
import { conceptIdForStashFile, displayRefForConceptId } from "../../core/asset/resolve-ref";
import { deriveBundleIds } from "../../core/bundle-id";
import { compareCodePoints, isAkmRegistryCachePath, resolveStashDir } from "../../core/common";
import type { AkmConfig } from "../../core/config/config";
import { loadConfig, primaryBundlePath } from "../../core/config/config";
import { UsageError } from "../../core/errors";
import type { FileChange } from "../../core/file-change";
import { warn } from "../../core/warn";
import { resolveSourceEntries, type SearchSource } from "../../indexer/search/search-source";
import { TASK_EXTENSION, TASK_NEAR_MISS_EXTENSION, taskExtensionDetail } from "../../tasks/source-v3";
import { resolveWorkflowSourceDomains } from "../../workflows/source-files";
import { runBaseChecks } from "./base-linter";
import { checkEnvForDangerousKeys } from "./env-key-rules";
import { isAdvisoryLintIssue, type LintContext, type LintIssue, type LintIssueType } from "./types";

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
}

export interface AkmLintOptions {
  fix?: boolean;
  /**
   * #884 opt-in repair: drop belief-channel entries whose target resolves to
   * neither a live file nor a prune tombstone. Independent of `fix` — see the
   * flag's rationale in `commands/agent/contribute-cli.ts`.
   */
  pruneDanglingEdges?: boolean;
  dir?: string;
  config?: AkmConfig;
  typeFilter?: string;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const STASH_SUBDIRS = [
  "agents",
  "commands",
  "memories",
  "skills",
  "workflows",
  "lessons",
  "tasks",
  "knowledge",
  "facts",
] as const;

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Every task-shaped file under `tasks/`: the recognized `.yml` spelling AND the
 * `.yaml` near-miss. A `.yaml` file is not a runnable task — it is invisible to
 * the indexer's `tasks` matcher — but collecting it here is what lets the sweep
 * SAY so (`invalid-task-yaml`, see {@link taskExtensionDetail}) instead of
 * walking past it and reporting a clean scan (issue #760).
 */
function collectTaskFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectTaskFiles(full));
    } else if (entry.isFile() && (isTaskFileName(entry.name) || isNearMissTaskFileName(entry.name))) {
      results.push(full);
    }
  }
  return results;
}

function isTaskFileName(fileName: string): boolean {
  return fileName.toLowerCase().endsWith(TASK_EXTENSION);
}

function isNearMissTaskFileName(fileName: string): boolean {
  return fileName.toLowerCase().endsWith(TASK_NEAR_MISS_EXTENSION);
}

function collectMarkdownFiles(dir: string, caseInsensitive = false): string[] {
  if (!fs.existsSync(dir)) return [];
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectMarkdownFiles(full, caseInsensitive));
    } else if (entry.isFile() && (caseInsensitive ? entry.name.toLowerCase() : entry.name).endsWith(".md")) {
      results.push(full);
    }
  }
  return results;
}

/** Peer workflow sources accepted by the source-IR compiler; `.yaml` remains unsupported. */
function collectWorkflowFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const results: string[] = [];
  for (const entry of fs
    .readdirSync(dir, { withFileTypes: true })
    .sort((left, right) => compareCodePoints(left.name, right.name))) {
    if (entry.name === ".git") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (isAkmRegistryCachePath(full)) continue;
      results.push(...collectWorkflowFiles(full));
      continue;
    }
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    const extension = path.extname(entry.name).toLowerCase();
    if (extension === ".md" || extension === ".yml") results.push(full);
  }
  return results.sort(compareCodePoints);
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
// akm 0.9.0 lint/adapter-dispatch wiring: `akm lint` used to special-case
// exactly one non-akm adapter (`okf`, via a hand-rolled `missing-type`-only
// `lintOkfBundle` re-implementation this change deletes) and silently route
// every OTHER non-akm bundle (llm-wiki, dotenv, claude, opencode,
// agent-skills, website-snapshot, generic-files, akm-task, akm-workflow)
// through the AKM-shaped STASH_SUBDIRS sweep — the wrong linter for the wrong
// format, and the reason those adapters' own `validate()` checks (OKF's
// `missing-ref`; llm-wiki's `uncited-raw`/`missing-description`/`broken-xref`/
// `broken-source`) were unreachable dead code. Every bundle is now linted by
// its OWN configured/detected adapter's `validate()` — the single definition
// of that format's rules, shared with the (now also wired, advisory-only)
// change-transaction pre-commit gate in `commands/proposal/repository.ts`.
// The adapter-dispatch work intentionally stays outside the `akm` sweep below.
// The sweep's workflow branch separately supports authoritative peer `.md` and
// `.yml` sources while preserving the pinned Markdown findings/`--fix` bytes.

/**
 * Case-insensitive SUFFIX match against an adapter's declared `extensions`
 * hint. Deliberately NOT `path.extname()`: Node's `extname(".env")` is `""`
 * (a leading-dot-only basename has no "extension" by that definition), which
 * would silently skip every bare `env/.env` file — exactly the shape
 * `dotenvAdapter`'s own `classify()` (and the akm adapter's env recognition)
 * match by plain `endsWith`, not `path.extname`. A suffix match is also a
 * strict superset of the `path.extname` behavior for a normal `name.ext`
 * file, so nothing that matched before stops matching.
 */
function matchesAdapterExtension(fileName: string, extensions: readonly string[]): boolean {
  const lower = fileName.toLowerCase();
  return extensions.some((candidate) => lower.endsWith(candidate.toLowerCase()));
}

/** Walk the whole bundle tree, collecting every file whose extension the adapter recognizes (skip `.git`, symlinks, cache/registry copies). */
function collectAdapterFiles(root: string, extensions: readonly string[]): string[] {
  if (!fs.existsSync(root)) return [];
  const results: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === ".git" || entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && matchesAdapterExtension(entry.name, extensions)) {
        // Skip akm's OWN resolved registry-cache copies, not any user
        // directory that happens to be named ".cache" or "registry".
        if (isAkmRegistryCachePath(full)) continue;
        results.push(full);
      }
    }
  };
  walk(root);
  return results;
}

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
  // The `akm-task` adapter's own code. Now reachable from `akm lint` for a
  // malformed or misnamed task file (issue #760); without it here, a genuine
  // task finding would arrive folded onto `adapter-diagnostic`.
  "invalid-task-yaml",
  "dangerous-env-key",
  "uncited-raw",
  "missing-description",
  "broken-xref",
  "broken-source",
  "invalid-workflow-structure",
  "workflow-warning",
]);

/** Map one adapter {@link Diagnostic} onto a {@link LintIssue} — see `types.ts`'s `"adapter-diagnostic"` doc comment for the open→closed reconciliation. */
export function diagnosticToLintIssue(diag: Diagnostic): LintIssue {
  // `line` is optional on both shapes: carry it only when the adapter set one,
  // so whole-file findings keep their exact existing serialization.
  const location = typeof diag.line === "number" ? { line: diag.line } : {};
  if (KNOWN_ADAPTER_ISSUE_TYPES.has(diag.issue)) {
    return { file: diag.file, issue: diag.issue as LintIssueType, detail: diag.detail, fixed: diag.fixed, ...location };
  }
  return {
    file: diag.file,
    issue: "adapter-diagnostic",
    detail: `[${diag.issue}] ${diag.detail}`,
    fixed: diag.fixed,
    ...location,
  };
}

/**
 * Lint a bundle through its OWN adapter's `validate()` (spec §12.1): the
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
): Promise<AkmLintResult> {
  const adapter = adapterForId(adapterId);
  // Defensive fallback (shouldn't happen via `detectAdapterId`/a valid config
  // — both only ever name a registered built-in): an unregistered adapter id
  // falls back to the akm-shaped sweep, the same default `akm lint` has
  // always applied to a bundle it can't otherwise place.
  if (!adapter) return lintAkmSweep(stashRoot, extraStashRoots, cfg, sources, options);

  // `--type` names an AKM stash subdir; every other adapter has its own type
  // vocabulary and `validate()` sees the whole bundle regardless. That is not a
  // correctness problem (full-bundle validation is a superset of the requested
  // scope), but a user narrowing a run deserves to hear the flag did nothing
  // rather than infer it from identical output (issue #762). Warn, don't throw:
  // a hard error would break scripts passing one `--type` across mixed-adapter
  // bundle sets.
  if (options.typeFilter) {
    warn(
      `Warning: lint --type "${options.typeFilter}" is not supported for the "${adapterId}" adapter — ` +
        "type scoping applies to akm bundles only; the whole bundle was validated.",
    );
  }

  const files = collectAdapterFiles(stashRoot, adapter.extensions);
  const changes: FileChange[] = files.map((filePath) => ({
    path: path.relative(stashRoot, filePath).replace(/\\/g, "/"),
    op: "update",
  }));
  const ids = deriveBundleIds(sources);
  const sourceIndex = sources.findIndex((s) => path.resolve(s.path) === path.resolve(stashRoot));
  const componentId = sourceIndex >= 0 ? (ids[sourceIndex] as string) : stashRoot;

  const ctx = createValidateContext({ root: stashRoot, extraRoots: extraStashRoots });
  const diagnostics = await adapter.validate(
    { id: componentId, adapter: adapterId, root: stashRoot, writable: true },
    changes,
    ctx,
  );

  const mapped = diagnostics.map(diagnosticToLintIssue);
  // Advisory diagnostics travel in their own channel — never `flagged`, so a
  // `--fail-on-flagged` gate is not tripped by a non-fatal warning. Classified
  // by the shared `ADVISORY_LINT_ISSUES` set rather than a code spelled out
  // here, so this and the sweep below can never disagree about a code.
  const warnings = mapped.filter(isAdvisoryLintIssue);
  const flagged = mapped.filter((issue) => !isAdvisoryLintIssue(issue));
  // The cross-bundle env dangerous-key sweep (see `runEnvDangerousKeyPass`'s
  // doc comment) ran for every non-akm adapter via the STASH_SUBDIRS
  // fallthrough this dispatch replaces — EXCEPT `okf`, which the old code
  // special-cased out before ever reaching that pass. Preserve both halves of
  // that history exactly: skip only for `okf`. Some adapters (`dotenv`) ALSO
  // find the same `dangerous-env-key` findings natively through their own
  // `validate()` (reusing the same `dangerousEnvKeyDiagnostics` rule) — dedupe
  // by `(file, issue, detail)` so a bundle covered both ways reports each
  // finding once, not twice.
  if (adapterId !== "okf") {
    const seen = new Set(flagged.map(lintIssueDedupeKey));
    for (const issue of runEnvDangerousKeyPass(stashRoot, extraStashRoots, sources, cfg)) {
      const key = lintIssueDedupeKey(issue);
      if (seen.has(key)) continue;
      seen.add(key);
      flagged.push(issue);
    }
  }
  return {
    ok: true,
    fixed: [],
    flagged,
    warnings,
    summary: { fixed: 0, flagged: flagged.length, warnings: warnings.length },
  };
}

function lintIssueDedupeKey(issue: LintIssue): string {
  return `${issue.file} ${issue.issue} ${issue.detail}`;
}

function collectEnvFiles(dir: string): string[] {
  const results: string[] = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) results.push(...collectEnvFiles(full));
      else if (entry.isFile() && entry.name.endsWith(".env")) results.push(full);
    }
  } catch {
    /* dir may not exist */
  }
  return results;
}

/**
 * Scan every `env/`/`secrets/` `.env` file across `[stashRoot, ...extraStashRoots]`
 * for keys that are known to enable process-execution hijacking. This is a
 * cross-bundle SECURITY sweep, not per-adapter validation — it has always run
 * regardless of which format family a given root's OWN files are (verbatim
 * extraction of the pass `lintAkmSweep` still runs inline; kept byte-identical
 * there per the CRITICAL akm-path constraint, and reused here for the
 * non-akm dispatch path so a non-akm PRIMARY bundle keeps the exact
 * cross-bundle coverage it already had — the pass previously reached every
 * non-akm adapter's bundle via the accidental STASH_SUBDIRS fallthrough this
 * change replaces with real dispatch).
 */
function runEnvDangerousKeyPass(
  stashRoot: string,
  extraStashRoots: string[],
  sources: SearchSource[],
  cfg: AkmConfig,
): LintIssue[] {
  const flagged: LintIssue[] = [];
  const envRoots = [stashRoot, ...extraStashRoots];
  const bundleIdByRoot = new Map(sources.map((source) => [path.resolve(source.path), source.registryId]));
  for (const root of envRoots) {
    const bundleId = bundleIdByRoot.get(path.resolve(root));
    // `env` assets live under `env/`, whole-file `secret` assets under
    // `secrets/`. `displayRefForConceptId` owns the short-default /
    // qualified-secondary `Ref:` spelling `akm show` emits — the old
    // hand-built `env:<base>` colon grammar is rejected by the 0.9.0 ref
    // parser, which dead-ended a user copying the ref off a security finding.
    for (const assetType of ["env", "secret"] as const) {
      const dir = path.join(root, stashDirFor(assetType) as string);
      if (!fs.existsSync(dir)) continue;
      for (const envPath of collectEnvFiles(dir)) {
        const conceptId = conceptIdForStashFile(assetType, root, envPath);
        const ref = displayRefForConceptId(conceptId, bundleId, cfg.defaultBundle);
        const relPath = path.relative(root, envPath);
        for (const issue of checkEnvForDangerousKeys(envPath, relPath, ref)) {
          flagged.push(issue);
        }
      }
    }
  }
  return flagged;
}

/**
 * Refuse `--fix` against a bundle the config marks `writable: false`, BEFORE
 * the sweep touches a single file (issue #761).
 *
 * Every other mutating command routes through `core/write-source.ts`'s
 * `ensureWritable`/`resolveWritable` pair; `akm lint --fix` writes and deletes
 * directly and never consulted the flag, so it happily rewrote frontmatter in a
 * bundle explicitly configured read-only. `SearchSource.writable` is already the
 * EFFECTIVE policy (`resolveWritable` applied — see `resolveSourceEntries`), so
 * this reads the same answer the write path would, without a second resolver.
 *
 * A root that is not a configured source at all (an ad-hoc `--dir`) carries no
 * policy and stays fixable, exactly as today.
 */
function assertFixTargetWritable(stashRoot: string, sources: SearchSource[]): void {
  const target = sources.find((source) => path.resolve(source.path) === path.resolve(stashRoot));
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

// ── Per-file lint dispatch (was registry.ts + the 9 per-type linter classes) ──
//
// akm 0.9.0 chunk-3 (plan §12): the 9 `BaseLinter` subclasses + `LINTER_MAP`/
// `getLinterForType` are gone. The format-generic checks are the shared
// `runBaseChecks` (`./base-linter`); the per-`type` RULES are the `akm`
// adapter's `validate` surface (`core/adapter/adapters/akm-lint.ts`), imported
// here so both the read-only adapter and this fix-capable CLI sweep share ONE
// definition of each finding. The adapter never writes; the delete-fix for the
// two stub types is applied HERE (a core/CLI concern), reproducing the old
// MemoryLinter/WorkflowLinter `--fix` behavior byte-for-byte.

/**
 * Reproduce `SkillLinter.lintDirectory`: a skill subdirectory with no
 * `SKILL.md` is flagged `missing-skill-md` (never auto-fixable). Exported for
 * the lint-parity golden (`tests/integration/goldens-lint-output.test.ts`).
 */
export function lintSkillDirectory(subdirPath: string, stashRoot: string): LintIssue[] {
  if (fs.existsSync(path.join(subdirPath, "SKILL.md"))) return [];
  const relDir = path.relative(stashRoot, subdirPath);
  return [{ file: relDir, issue: "missing-skill-md", detail: `no SKILL.md in ${relDir}/`, fixed: false }];
}

/** MemoryLinter's `orphaned-stub` check WITH its `--fix` delete (memory-linter.ts:19-65). */
function appendMemoryStubIssue(ctx: LintContext, issues: LintIssue[]): void {
  if (!memoryOrphanStubApplies(ctx.data, ctx.body)) return;
  const derivedPath = `${ctx.filePath.replace(/\.md$/i, "")}.derived.md`;
  if (fs.existsSync(derivedPath)) return;
  if (ctx.fix) {
    try {
      fs.unlinkSync(ctx.filePath);
      issues.push({ file: ctx.relPath, issue: "orphaned-stub", detail: "deleted orphaned stub", fixed: true });
    } catch (e) {
      issues.push({
        file: ctx.relPath,
        issue: "orphaned-stub",
        detail: `could not delete: ${e instanceof Error ? e.message : String(e)}`,
        fixed: "failed",
      });
    }
    return;
  }
  issues.push({ file: ctx.relPath, issue: "orphaned-stub", detail: ORPHANED_STUB_DETAIL, fixed: false });
}

/**
 * WorkflowLinter's `placeholder-stub` check WITH its `--fix` delete
 * (workflow-linter.ts:22-79). Its sibling `invalid-workflow-structure` check is
 * deliberately NOT here: parse+compile is a single pass shared with the
 * advisory channel, so {@link lintAkmSweep} runs it once per file and routes
 * both halves.
 */
function appendWorkflowStubIssue(ctx: LintContext, issues: LintIssue[]): void {
  const placeholder = matchWorkflowPlaceholder(ctx.body);
  if (!placeholder) return;
  if (ctx.fix) {
    try {
      fs.unlinkSync(ctx.filePath);
      issues.push({
        file: ctx.relPath,
        issue: "placeholder-stub",
        detail: `deleted: found "${placeholder}"`,
        fixed: true,
      });
    } catch (e) {
      issues.push({
        file: ctx.relPath,
        issue: "placeholder-stub",
        detail: `could not delete: ${e instanceof Error ? e.message : String(e)}`,
        fixed: "failed",
      });
    }
    return;
  }
  issues.push({
    file: ctx.relPath,
    issue: "placeholder-stub",
    detail: `placeholder text: "${placeholder}"`,
    fixed: false,
  });
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
  switch (subdir) {
    case "agents":
      issues.push(...(nameOrTypeDiagnostics(ctx.relPath, ctx.data, ctx.frontmatter, ["agent"]) as LintIssue[]));
      break;
    case "commands":
      issues.push(...(nameOrTypeDiagnostics(ctx.relPath, ctx.data, ctx.frontmatter, ["command"]) as LintIssue[]));
      break;
    case "facts":
      issues.push(...(factDiagnostics(ctx.relPath, ctx.data) as LintIssue[]));
      break;
    case "tasks":
      issues.push(...(taskDiagnostics(ctx.relPath, ctx.raw, ctx.stashRoot) as LintIssue[]));
      break;
    case "memories":
      appendMemoryStubIssue(ctx, issues);
      break;
    case "workflows":
      appendWorkflowStubIssue(ctx, issues);
      break;
    // knowledge / lessons / skills: base checks only (skill directory-level
    // `missing-skill-md` runs separately, per-subdir, in the sweep loop).
  }
  return issues;
}

// ── Main ──────────────────────────────────────────────────────────────────────

/**
 * The `akm`-adapter sweep: STASH_SUBDIRS walk + per-file `lintAssetFile` +
 * the env dangerous-key pass. UNTOUCHED by the adapter-dispatch wiring above
 * (CRITICAL CONSTRAINT — the overwhelming majority of real bundles use `akm`,
 * and its findings / `--fix` behavior / exact `LintIssueType` codes are
 * pinned by goldens + a large test suite). Only reached when the resolved
 * adapter id is `"akm"` (or, defensively, an unregistered adapter id —
 * see {@link lintViaAdapter}'s fallback).
 */
function lintAkmSweep(
  stashRoot: string,
  extraStashRoots: string[],
  cfg: AkmConfig,
  sources: SearchSource[],
  options: AkmLintOptions,
): AkmLintResult {
  const fix = options.fix === true;
  // #884: the dangling-edge repair writes too, so it clears the same
  // read-only gate `--fix` does.
  if (fix || options.pruneDanglingEdges === true) assertFixTargetWritable(stashRoot, sources);
  const fixed: LintIssue[] = [];
  const flagged: LintIssue[] = [];
  const warnings: LintIssue[] = [];

  const dirsToScan = options.typeFilter ? STASH_SUBDIRS.filter((d) => d === options.typeFilter) : STASH_SUBDIRS;

  for (const subdir of dirsToScan) {
    const dirPath = path.join(stashRoot, subdir);
    // Tasks have their own `.yml` plus near-miss collector. Workflows accept
    // peer `.md`/`.yml` sources; every remaining AKM subdir is Markdown.
    const files =
      subdir === "tasks"
        ? collectTaskFiles(dirPath)
        : subdir === "workflows"
          ? collectWorkflowFiles(dirPath)
          : collectMarkdownFiles(dirPath, true);
    let assetFiles =
      subdir === "workflows" ? files.filter((file) => path.basename(file).toLowerCase() !== "readme.md") : files;
    if (subdir === "workflows") {
      assetFiles = assetFiles.filter((file) => !isAkmRegistryCachePath(file));
      const ownership = resolveWorkflowLintOwnership(stashRoot, assetFiles);
      assetFiles = ownership.files;
      flagged.push(...ownership.issues);
    }

    // Directory-level check: skills require a SKILL.md entry point (was
    // SkillLinter.lintDirectory). Run once per direct subdirectory before the
    // per-file loop.
    if (subdir === "skills" && fs.existsSync(dirPath)) {
      for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        for (const issue of lintSkillDirectory(path.join(dirPath, entry.name), stashRoot)) {
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
      const relPath = path.relative(stashRoot, filePath);
      let raw: string;
      try {
        raw = fs.readFileSync(filePath, "utf8");
      } catch {
        continue;
      }

      // GitHub-shaped YAML is a peer workflow source, not a Markdown document:
      // no frontmatter/base/stub checks and no `--fix` mutation apply. Compile
      // once through the shared source-IR frontend and route its findings.
      if (subdir === "workflows" && path.extname(filePath).toLowerCase() === ".yml") {
        const frontend = workflowYamlSourceDiagnostics(relPath, raw, filePath, stashRoot);
        for (const finding of [...frontend.errors, ...frontend.warnings]) {
          if (isAdvisoryLintIssue(finding)) {
            warnings.push(finding);
          } else {
            flagged.push(finding);
          }
        }
        continue;
      }

      let data: Record<string, unknown>;
      let body: string;
      let frontmatter: string | null;
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
        ({ data, content: body, frontmatter } = parseFrontmatter(raw));
      }

      // One file's checks — including its `--fix` mutations — must never abort
      // the sweep: an uncaught throw here left the caller with an exception and
      // no record of which earlier files had ALREADY been rewritten on disk
      // (issue #761). A failure is reported per-file, in-band, and the sweep
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
              fix,
              pruneDanglingEdges: options.pruneDanglingEdges === true,
              stashRoot,
              extraStashRoots,
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
        continue;
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

      if (fileDeleted) continue; // file is gone — skip any remaining checks

      // The workflow frontend is ONE parse+compile whose output feeds BOTH
      // channels, so it runs here — once per file — rather than inside
      // `lintAssetFile`, which is an errors-only surface (pinned by the lint
      // golden). Which channel a finding lands in is decided by
      // `ADVISORY_LINT_ISSUES`, never by which half of the pass produced it, so
      // a future compile-warning kind carrying a fatal code cannot slip past
      // `--fail-on-flagged`.
      // The CLI passes the absolute filePath to the shared source-IR frontend,
      // whereas the adapter passes the change relPath.
      if (subdir === "workflows") {
        const frontend = workflowFrontendDiagnostics(relPath, raw, filePath);
        for (const finding of [...frontend.errors, ...frontend.warnings]) {
          if (isAdvisoryLintIssue(finding)) {
            warnings.push(finding);
          } else {
            flagged.push(finding);
          }
        }
      }
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
  return {
    ok: true,
    fixed,
    flagged,
    warnings,
    summary: { fixed: fixed.length, flagged: flagged.length, warnings: warnings.length },
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
  // Fail closed on a mistyped invocation (§24.2 "Lint" release gate): a
  // nonexistent --dir used to walk nothing and report a clean
  // `ok:true, flagged:0`, silently passing scripted --fail-on-flagged gates.
  if (options.dir !== undefined && !fs.statSync(options.dir, { throwIfNoEntry: false })?.isDirectory()) {
    throw new UsageError(`lint: --dir "${options.dir}" is not a directory.`, "INVALID_FLAG_VALUE");
  }
  // Collect secondary stash roots from configured filesystem sources so that
  // cross-stash refs (e.g. referencing assets in dimm-city/agent-stash) are
  // not falsely flagged as missing-ref.
  const cfg = options.config ?? loadConfig();
  // 0.9.0 (spec §10.1): the primary stash is the defaultBundle's path.
  const stashRoot = options.dir ?? primaryBundlePath(cfg) ?? resolveStashDir();
  const sources = resolveSourceEntries(stashRoot, cfg);
  const configuredAdapter = sources.find((source) => path.resolve(source.path) === path.resolve(stashRoot))?.adapterId;
  const adapterId = configuredAdapter ?? detectAdapterId(stashRoot);
  const extraStashRoots = sources.map((s) => s.path).filter((p) => p !== stashRoot && fs.existsSync(p));

  if (adapterId !== "akm") return lintViaAdapter(adapterId, stashRoot, extraStashRoots, sources, cfg, options);
  // Same fail-closed rule for --type on the akm sweep: an unknown value used
  // to filter the walk to ZERO directories — a false-clean result on the
  // classic singular/plural typo ("workflow" for "workflows"). Non-akm
  // adapters keep their own type vocabularies (see lintViaAdapter).
  if (options.typeFilter && !(STASH_SUBDIRS as readonly string[]).includes(options.typeFilter)) {
    warn(
      `Warning: lint --type "${options.typeFilter}" is not a recognized akm stash subdirectory — ` +
        `valid types: ${STASH_SUBDIRS.join(", ")}. The whole bundle was validated.`,
    );
    options = { ...options, typeFilter: undefined };
  }
  return lintAkmSweep(stashRoot, extraStashRoots, cfg, sources, options);
}
