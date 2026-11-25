// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fs from "node:fs";
import path from "node:path";
import { documentStashDirFor, refForFile, typeForStashDir } from "../../core/asset/asset-placement";
import { displayRefForConceptId } from "../../core/asset/resolve-ref";
import { lintAssetText, lintBundle, lintLooseFile } from "../../core/assets/gate";
import { storeFindings } from "../../core/assets/validate";
import { bundleSourceAt } from "../../core/bundle-at-dir";
import { deriveBundleIds } from "../../core/bundle-id";
import { resolveStashDir, samePath } from "../../core/common";
import type { AkmConfig } from "../../core/config/config";
import { loadConfig, primaryBundlePath } from "../../core/config/config";
import { bundleAtDir } from "../../core/config/config-sources";
import { UsageError } from "../../core/errors";
import { bundleLintSkip } from "../../core/lint/bundle-skip";
import { diagnosticToLintIssue } from "../../core/lint/diagnostics";
import { type ReadMoves, readRecordedMoves } from "../../core/lint/moved-refs";
import {
  type AkmLintOptions,
  isAdvisoryLintIssue,
  LINT_RULES,
  type LintBundle,
  type LintFindings,
  type LintIssue,
} from "../../core/lint/types";
import { warn } from "../../core/warn";
import { resolveSourceEntries, type SearchSource } from "../../indexer/search/search-source";
import { trackedSecretIssues } from "./tracked-secrets";

// ── Public API types (re-exported for consumers) ──────────────────────────────

export type { AkmLintOptions, LintIssue, LintIssueType } from "../../core/lint/types";

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

/** The bundle at `stashRoot` among the configured `sources`, under the id refs name it by (its path when none is configured there). */
function lintBundleOf(adapterId: string | undefined, stashRoot: string, sources: SearchSource[]): LintBundle {
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
  const ctx = { config: cfg, readMoves: options.readMoves ?? readRecordedMoves };
  for (const diagnostic of await storeFindings(sources, ctx)) {
    const issue = { ...diagnosticToLintIssue(diagnostic), ref: diagnostic.ref };
    (isAdvisoryLintIssue(issue) ? found.warnings : found.flagged).push(issue);
  }
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
 * `akm lint <file>`: the bundle that holds the file lints just that file (its adapter's findings narrowed to it), and a
 * file outside every bundle is read as the akm document type `--type` names.
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
  if (root === undefined) {
    return finishLint(lintLooseFile({ given: file, real: absFile }, cfg, options), cfg, options);
  }
  const sources = resolveSourceEntries(root, cfg);
  const found = await lintBundle({
    bundle: lintBundleOf(bundleSourceAt(root, cfg).adapterId, root, sources),
    // asset-io: bundle-root root probe
    extraStashRoots: sources.map((s) => s.path).filter((p) => p !== root && fs.existsSync(p)),
    sources,
    cfg,
    options,
    file: { given: file, real: absFile },
  });
  return finishLint(found, cfg, options, root);
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
  const sinks = lintAssetText({ ...input, cfg, readMoves: input.readMoves ?? readRecordedMoves });
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
 * Lint the resolved bundle at `options.dir` (default: the primary bundle) through its adapter's `lint`: one pipeline
 * for every adapter. `async` because `BundleAdapter.validate()` is async by interface contract
 * (`core/adapter/bundle-adapter.ts`); every existing caller already runs inside an async context
 * (`commands/agent/contribute-cli.ts`, `commands/improve/preparation.ts`) or is a test that can `await` it.
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
  const bundle = lintBundleOf(
    sources.find((source) => samePath(source.path, stashRoot))?.adapterId,
    stashRoot,
    sources,
  );
  // The adapter's checks and the sweep both ask about moved refs: the recorded moves are read once between them.
  const readMoves = options.readMoves ?? readRecordedMoves;
  let moves: ReturnType<ReadMoves> | undefined;
  options = { ...options, readMoves: () => (moves ??= readMoves()) };
  const found = await lintBundle({
    bundle,
    // asset-io: bundle-root root probe
    extraStashRoots: sources.map((s) => s.path).filter((p) => p !== stashRoot && fs.existsSync(p)),
    sources,
    cfg,
    options,
  });
  found.flagged.push(...trackedSecretIssues(stashRoot));
  await addStoreFindings(found, sources, cfg, options);
  return finishLint(found, cfg, options, stashRoot);
}
