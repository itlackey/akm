// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { StalePathFields } from "../../core/asset/stale-path";
import type { MovedRefs } from "./moved-refs";

/** Every rule `akm lint` reports; a rule name in `lint.skip` or `--rule` is one of these. */
export const LINT_RULES = [
  "unquoted-colon",
  "missing-updated",
  "orphaned-stub",
  "placeholder-stub",
  "missing-name-or-type",
  "missing-type",
  "stale-path",
  "missing-skill-md",
  "invalid-task-yaml",
  "missing-ref",
  "redacted-content",
  "dangerous-env-key",
  "tracked-secrets",
  "invalid-workflow-structure",
  "missing-category",
  /**
   * A file the sweep reached but could not finish checking — the per-file
   * dispatch threw (unreadable mid-run, a `--fix` write that failed in a way
   * the fixer could not absorb). Reported in-band so a partial sweep is
   * VISIBLE: before this code existed the throw escaped `akmLint()` entirely
   * and the caller learned neither which file failed nor which fixes had
   * already landed on disk (issue #761).
   */
  "lint-failed",
  // ── non-akm adapter `validate()` codes (akm) ──
  //
  // These four are `llm-wiki`'s native structural checks
  // (`core/adapter/adapters/llm-wiki-adapter.ts`), reachable now that `akm lint`
  // dispatches every non-akm bundle through its OWN adapter's `validate()`
  // instead of the akm-shaped per-file sweep. `missing-type` / `missing-ref`
  // above are shared with `okf` (already closed members of this union).
  "uncited-raw",
  "missing-description",
  "broken-xref",
  "broken-source",
  /** A concept stored under more than one spelling: the first is used and the others ignored (`BundleAdapter.read`). */
  "shadowed-spelling",
  /** An akm asset whose content suggests another type than its path gives: akm goes by the path. */
  "type-from-content",
  /**
   * Non-fatal workflow compile ADVISORY (`compileWorkflowPlan().warnings` —
   * e.g. a step with no `output:` schema, or a `params.<name>` reference to an
   * undeclared param). Routed into `AkmLintResult.warnings`, never `flagged`,
   * so `--fail-on-flagged` ignores it (see
   * `core/adapter/adapters/akm-lint.ts#workflowFrontendDiagnostics`).
   */
  "workflow-warning",
  /**
   * Fallback for a `Diagnostic.issue` code this union does not (yet) name.
   * `Diagnostic.issue` (`core/adapter/types.ts`) is deliberately an OPEN
   * `string` — any current or future `BundleAdapter.validate()` may emit a
   * code this closed lint-command union has never heard of. Rather than
   * silently dropping that finding (or throwing at the CLI boundary), the
   * lint→adapter mapping (`commands/lint/index.ts#diagnosticToLintIssue`)
   * folds an unrecognized code onto this member and preserves the ORIGINAL
   * code in `detail` (prefixed `[<issue>] `) so nothing an adapter reports is
   * ever lost, even though the closed union can't type it precisely.
   */
  "adapter-diagnostic",
] as const;

export type LintIssueType = (typeof LINT_RULES)[number];

/**
 * The issue codes that are ADVISORY: surfaced in lint output but never routed
 * into `flagged`, so `--fail-on-flagged` cannot fail a run over one.
 *
 * ONE home for that decision. EVERY routing point consults it — the adapter
 * path (`lint/index.ts#lintViaAdapter`), the sweep's per-file loop, and the
 * sweep's workflow-frontend pass — so a new advisory code cannot be classified
 * correctly in one place and land in `flagged` (exit 1) in another; a finding
 * is never filed by which producer emitted it. A future advisory belongs in
 * BOTH this set and {@link LintIssueType}: an unrecognized code is folded onto
 * `adapter-diagnostic` at the adapter boundary, which is deliberately NOT
 * advisory, so a code missing from the union cannot be routed by this set.
 *
 * Advisory-ness is deliberately NOT a field on {@link LintIssue}: issues are
 * serialized verbatim by `--format json`, and a new key on every advisory
 * would change every consumer's output to restate what `issue` already says.
 */
export const ADVISORY_LINT_ISSUES: ReadonlySet<string> = new Set<LintIssueType>(["workflow-warning"]);

/** True when `issue` belongs to the advisory channel — see {@link ADVISORY_LINT_ISSUES}. */
export function isAdvisoryLintIssue(issue: { issue: string }): boolean {
  return ADVISORY_LINT_ISSUES.has(issue.issue);
}

export interface LintIssue extends Partial<StalePathFields> {
  /** The asset ref `akm show` takes, when the finding is about one asset of the linted bundle. */
  ref?: string;
  /** A `missing-ref` to an asset the index recorded as moved: the link as written, and the ref the asset has now. */
  movedFrom?: string;
  movedTo?: string;
  file: string;
  issue: LintIssueType;
  detail: string;
  /** `true` = fix applied; `false` = not fixable or no fix requested; `"failed"` = no safe replacement was produced or written. */
  fixed: boolean | "failed";
  /**
   * 1-indexed line in `file`, when the producing check knows one — the same
   * optional field `Diagnostic.line` carries (`core/adapter/types.ts`), kept
   * OPTIONAL because most lint checks are whole-file and have no location.
   * Workflow parse/compile findings are line-anchored
   * (`WorkflowError.line`), so `akm lint` renders them as `file:line` in text
   * output and emits `"line": <n>` in `--format json`.
   */
  line?: number;
}

export interface LintContext {
  filePath: string;
  relPath: string;
  raw: string;
  data: Record<string, unknown>;
  body: string;
  frontmatter: string | null;
  /** File line the body starts on (frontmatter findings sit on lines from 2). */
  bodyStartLine: number;
  fix: boolean;
  /** #884: opt-in dangling belief-edge repair. Independent of `fix`. */
  pruneDanglingEdges?: boolean;
  stashRoot: string;
  /** Roots that make an absolute path judgeable for `stale-path`; see `stalePathRoots`. */
  stalePathRoots: string[];
  /** Additional stash roots (secondary sources) for cross-stash ref resolution. */
  extraStashRoots?: string[];
  /** Issue types to skip for this file: the bundle's `lint.skip` rules that match its path, plus the run's own. */
  lintSkip?: readonly string[];
  /** The refs the index recorded as moved; a `missing-ref` to one carries the new ref. */
  moves?: MovedRefs;
  /** Bundle id to root, so a qualified ref is checked in the bundle it names. */
  bundleRoots?: ReadonlyMap<string, string>;
  /** Rewrite the links to moved refs only (`fix` rewrites them too, with every other fix). */
  fixMovedRefs?: boolean;
}
