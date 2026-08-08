// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import {
  factDiagnostics,
  matchWorkflowPlaceholder,
  memoryOrphanStubApplies,
  nameOrTypeDiagnostics,
  ORPHANED_STUB_DETAIL,
  taskDiagnostics,
  workflowCompileWarnings,
  workflowStructureDiagnostics,
} from "../../core/adapter/adapters/akm-lint";
import { detectAdapterId } from "../../core/adapter/detect-adapter";
import { adapterForId } from "../../core/adapter/registry";
import type { Diagnostic } from "../../core/adapter/types";
import { createValidateContext } from "../../core/adapter/validate-context";
import { stashDirFor } from "../../core/asset/asset-placement";
import { parseFrontmatter } from "../../core/asset/frontmatter";
import { conceptIdForStashFile, displayRefForConceptId } from "../../core/asset/resolve-ref";
import { deriveBundleIds } from "../../core/bundle-id";
import { resolveStashDir } from "../../core/common";
import type { AkmConfig } from "../../core/config/config";
import { loadConfig, primaryBundlePath } from "../../core/config/config";
import { UsageError } from "../../core/errors";
import type { FileChange } from "../../core/file-change";
import { resolveSourceEntries, type SearchSource } from "../../indexer/search/search-source";
import { runBaseChecks } from "./base-linter";
import { checkEnvForDangerousKeys } from "./env-key-rules";
import type { LintContext, LintIssue, LintIssueType } from "./types";

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

function collectYamlFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectYamlFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".yml")) {
      results.push(full);
    }
  }
  return results;
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
// This is intentionally the ONLY branch this module adds: the `akm` sweep
// below is completely untouched (pinned by the goldens/test suite —
// CRITICAL: akm findings/`--fix` must not move).

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
        // Compare PATH SEGMENTS, not raw substrings: `path.join` yields `\` on
        // Windows so a `"/.cache/"` substring test never matches there, and a
        // substring test would also skip a legitimately-named `registry` file.
        const segments = path.relative(root, full).split(/[\\/]/);
        if (segments.includes(".cache") || segments.includes("registry")) continue;
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
  "dangerous-env-key",
  "uncited-raw",
  "missing-description",
  "broken-xref",
  "broken-source",
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
  // `--fail-on-flagged` gate is not tripped by a non-fatal warning.
  const warnings = mapped.filter((issue) => issue.issue === "workflow-warning");
  const flagged = mapped.filter((issue) => issue.issue !== "workflow-warning");
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

/** WorkflowLinter's `placeholder-stub` (WITH `--fix` delete) + `invalid-workflow-structure` (workflow-linter.ts:22-79). */
function appendWorkflowIssues(ctx: LintContext, issues: LintIssue[]): void {
  const placeholder = matchWorkflowPlaceholder(ctx.body);
  if (placeholder) {
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
      return; // WorkflowLinter returns before the structure check once a stub is fixed.
    }
    issues.push({
      file: ctx.relPath,
      issue: "placeholder-stub",
      detail: `placeholder text: "${placeholder}"`,
      fixed: false,
    });
  }
  // NB: the CLI passes the ABSOLUTE filePath to parseWorkflow (matching the old
  // WorkflowLinter), whereas the adapter passes the change relPath.
  issues.push(...(workflowStructureDiagnostics(ctx.relPath, ctx.raw, ctx.filePath) as LintIssue[]));
}

/**
 * Lint ONE asset file: the shared base checks, then the winning stash subdir's
 * per-`type` extra rules. Replaces `getLinterForType(subdir).lint(ctx)`.
 * `--fix` mutations (frontmatter rewrites inside `runBaseChecks`; stub deletes
 * here) are applied when `ctx.fix` is set.
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
      issues.push(...(taskDiagnostics(ctx.relPath, ctx.data) as LintIssue[]));
      break;
    case "memories":
      appendMemoryStubIssue(ctx, issues);
      break;
    case "workflows":
      appendWorkflowIssues(ctx, issues);
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
  const fixed: LintIssue[] = [];
  const flagged: LintIssue[] = [];
  const warnings: LintIssue[] = [];

  const dirsToScan = options.typeFilter ? STASH_SUBDIRS.filter((d) => d === options.typeFilter) : STASH_SUBDIRS;

  for (const subdir of dirsToScan) {
    const dirPath = path.join(stashRoot, subdir);
    // Tasks are .yml files; everything else (including workflows, one
    // markdown format now) is .md
    const files = subdir === "tasks" ? collectYamlFiles(dirPath) : collectMarkdownFiles(dirPath, true);
    const assetFiles =
      subdir === "workflows" ? files.filter((file) => path.basename(file).toLowerCase() !== "readme.md") : files;

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
      if (filePath.includes("/.cache/") || filePath.includes("/registry/")) continue;
      const relPath = path.relative(stashRoot, filePath);
      let raw: string;
      try {
        raw = fs.readFileSync(filePath, "utf8");
      } catch {
        continue;
      }

      let data: Record<string, unknown>;
      let body: string;
      let frontmatter: string | null;

      if (subdir === "tasks") {
        // Task files are pure YAML — parseFrontmatter returns empty data for them.
        try {
          const parsed = parseYaml(raw);
          data =
            parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
        } catch {
          data = {};
        }
        body = raw;
        frontmatter = null;
      } else {
        ({ data, content: body, frontmatter } = parseFrontmatter(raw));
      }

      const issues = lintAssetFile(
        { filePath, relPath, raw, data, body, frontmatter, fix, stashRoot, extraStashRoots },
        subdir,
      );

      let fileDeleted = false;
      for (const issue of issues) {
        if (isFileDeletion(issue)) {
          fileDeleted = true;
          fixed.push(issue);
        } else if (issue.fixed === true) {
          fixed.push(issue);
        } else {
          // fixed === false (not fixable / no fix requested) or "failed" (fix attempted but threw)
          flagged.push(issue);
        }
      }

      if (fileDeleted) continue; // file is gone — skip any remaining checks

      // Workflow compile warnings are non-fatal advisories (`compileWorkflowPlan`'s
      // `warnings`): surfaced in the result's separate `warnings` channel so
      // they reach human + JSON lint output without tripping `--fail-on-flagged`.
      if (subdir === "workflows") {
        warnings.push(...(workflowCompileWarnings(relPath, raw, filePath) as LintIssue[]));
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
    throw new UsageError(
      `lint: unknown --type "${options.typeFilter}". Valid types: ${STASH_SUBDIRS.join(", ")}.`,
      "INVALID_FLAG_VALUE",
    );
  }
  return lintAkmSweep(stashRoot, extraStashRoots, cfg, sources, options);
}
