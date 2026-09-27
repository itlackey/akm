// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Per-`type` validate checks for the `akm` adapter — akm 0.9.0 chunk-2, WI-C,
 * implementing spec §6 (the per-`type` validation column) as a
 * behavior-preserving port of `src/commands/lint/*`'s type linters. The `akm`
 * adapter's `validate` = shared base checks (WI-A `shared.ts`) + these per-type
 * extra checks, keyed on the winning `type`, reproducing today's
 * `getLinterForType(subdir).lint(ctx)` dispatch. The FROZEN lint golden
 * (`tests/fixtures/goldens/lint/all-types.json`, `perType`) is the conformance
 * gate.
 *
 * ── type → linter mapping (registry.ts `getLinterForType`) ──
 *
 *   command → CommandLinter | agent → AgentLinter (missing-name-or-type +
 *   invalid `type` value); fact → FactLinter (missing-category); task →
 *   TaskLinter (invalid-task-yaml); workflow(.md) → WorkflowLinter
 *   (placeholder-stub READ-ONLY + invalid-workflow-structure); memory →
 *   MemoryLinter (orphaned-stub READ-ONLY); skill → SkillLinter directory check
 *   (missing-skill-md, see {@link skillDirectoryDiagnostics}); env/secret → the
 *   env dangerous-key scan (lint/index.ts:191-218, `.env`-suffix-narrow);
 *   knowledge/lesson/script/secret/wiki/session → DefaultLinter (base only).
 *
 * ── READ-ONLY discipline ──
 *
 * `placeholder-stub` and `orphaned-stub` carry a `--fix` DELETE in the live
 * linters; `BundleAdapter.validate` MUST NOT write, so both are emitted as
 * non-fixable Diagnostics here (never delete). All reads route through
 * `ValidateContext` (the run snapshot + pending overlay) — the live linters'
 * `fs.existsSync` sibling/SKILL.md probes become `ctx.readFile` lookups.
 *
 * ── env/secret dangerous-key narrowness (PRESERVED, spec §6) ──
 *
 * Today's scan (`collectEnvFiles`) only visits `.env`-SUFFIXED files under
 * `env/` and `secrets/`, so `secrets/<bare-name>` is NOT scanned. This port
 * keeps that exact narrowness: {@link dangerousEnvKeyDiagnostics} runs only when
 * the path's basename ends in `.env`. NOT widened.
 *
 * ── Cycle-safety (chunk-2 ratchet, baseline 18) ──
 *
 * Imported ONLY by `akm-adapter.ts` (no inbound `src/` edge) → can never join a
 * cycle. It VALUE-imports the one `compileWorkflowSource` frontend and the pure
 * predicate `isDangerousEnvKey`
 * from `commands/lint/env-key-rules` — the predicate is imported, not copied,
 * precisely so the 40+ security-sensitive dangerous-key names cannot drift from
 * the canonical set; importing it is ratchet-neutral (verified: 18). The small
 * key-scan / suppression-comment logic IS ported (content-based, reads the
 * overlay `raw`, not disk). `type` determination stays in `akm-adapter.ts`
 * (which owns `recognizeMatch`) so this leaf never imports back into the
 * adapter.
 */

import path from "node:path";
import { isDangerousEnvKey } from "../../../commands/lint/env-key-rules";
import { parseTaskSource } from "../../../tasks/source/parse-task-source";
import { taskSourceErrorDetail } from "../../../tasks/source-v3";
import { checkWorkflowPlan, compileWorkflowSource } from "../../../workflows/compile";
import { conceptIdForStashFile } from "../../asset/resolve-ref";
import { isAkmRegistryCachePath, scanEnvKeyNames } from "../../common";
import type { BundleComponent, Diagnostic, ValidateContext } from "../types";

/** Recommended `category` values for facts — `commands/lint/fact-linter.ts:9`. */
const KNOWN_CATEGORIES = new Set(["personal", "team", "project", "convention", "meta"]);

/** Placeholder markers a workflow stub carries — `commands/lint/workflow-linter.ts:10`. */
const PLACEHOLDER_STRINGS = ["Describe what this workflow accomplishes", "Example Workflow"];

/** Inline suppression token — `commands/lint/env-key-rules.ts:138` (not exported there; reproduced verbatim). */
const SUPPRESSION_COMMENT = "# akm-lint-ok: dangerous-env-key";

// ── BaseLinter protected-method ports (base-linter.ts:520-551) ───────────────

/** Port of `BaseLinter.checkMissingNameOrType` (`:520-527`). */
function checkMissingNameOrType(data: Record<string, unknown>, frontmatter: string | null): string | null {
  if (!frontmatter) return null;
  const missingFields: string[] = [];
  if (!("name" in data) || !data.name) missingFields.push("name");
  if (!("type" in data) || !data.type) missingFields.push("type");
  if (missingFields.length === 0) return null;
  return `missing fields: ${missingFields.join(", ")}`;
}

/** Port of `BaseLinter.checkInvalidTypeValue` (`:534-539`). */
function checkInvalidTypeValue(data: Record<string, unknown>, allowedTypes: readonly string[]): string | null {
  if (!("type" in data) || !data.type) return null;
  const value = String(data.type);
  if (allowedTypes.includes(value)) return null;
  return `type field has invalid value '${value}'; expected one of: ${allowedTypes.join(", ")}`;
}

/** Port of `BaseLinter.suggestSlug` (`:544-551`). */
function suggestSlug(filePath: string): string {
  return path
    .basename(filePath, ".md")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

// ── name/type linter (CommandLinter / AgentLinter) ───────────────────────────

/** Reproduce CommandLinter/AgentLinter's extra checks (`command-linter.ts` / `agent-linter.ts`). */
export function nameOrTypeDiagnostics(
  relPath: string,
  data: Record<string, unknown>,
  frontmatter: string | null,
  allowedTypes: readonly string[],
): Diagnostic[] {
  const missingFieldDetail = checkMissingNameOrType(data, frontmatter);
  if (missingFieldDetail) {
    const slug = suggestSlug(relPath);
    return [
      {
        file: relPath,
        issue: "missing-name-or-type",
        detail: `${missingFieldDetail}; suggested slug: ${slug}`,
        fixed: false,
      },
    ];
  }
  const invalidTypeDetail = checkInvalidTypeValue(data, allowedTypes);
  if (invalidTypeDetail) {
    return [{ file: relPath, issue: "missing-name-or-type", detail: invalidTypeDetail, fixed: false }];
  }
  return [];
}

// ── env dangerous-key scan (content-based port of env-key-rules.ts) ──────────

/** Port of `env-key-rules.ts#collectSuppressedKeys` (`:144-164`) — content-based. */
function collectSuppressedKeys(raw: string): Set<string> {
  const suppressed = new Set<string>();
  const lines = raw.split(/\r?\n/);
  let prevNonEmpty = "";
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const keyMatch = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (keyMatch && prevNonEmpty.toLowerCase() === SUPPRESSION_COMMENT) {
      suppressed.add(keyMatch[1]!);
    }
    prevNonEmpty = trimmed;
  }
  return suppressed;
}

/**
 * env/secret dangerous-key scan (`lint/index.ts:191-218` + `env-key-rules.ts#checkEnvForDangerousKeys`),
 * keyed on `type` and preserving the `.env`-suffix narrowness (see file header).
 * Reads the overlay `raw`, not disk.
 *
 * The emitted `Ref:` comes from `conceptIdForStashFile` — the one place that
 * spells a diagnostic ref the way `akm show` accepts it. It used to be
 * hand-built as `env:<base>` / `secret:<base>`, a colon grammar the 0.9.0 ref
 * parser rejects outright — a dead-end ref on a *security* finding.
 */
export function dangerousEnvKeyDiagnostics(type: string | undefined, relPath: string, raw: string): Diagnostic[] {
  if (type !== "env" && type !== "secret") return [];
  const baseNameWithExt = path.basename(relPath);
  if (!baseNameWithExt.endsWith(".env")) return []; // NARROWNESS: collectEnvFiles only visits *.env
  // `relPath` is already stash-root-relative, so "." IS the stash root here.
  const ref = conceptIdForStashFile(type, ".", relPath);

  const keys = scanEnvKeyNames(raw);
  const suppressed = collectSuppressedKeys(raw);
  const diagnostics: Diagnostic[] = [];
  for (const key of keys) {
    if (!isDangerousEnvKey(key)) continue;
    if (suppressed.has(key)) continue;
    diagnostics.push({
      file: relPath,
      issue: "dangerous-env-key",
      detail: `Env key \`${key}\` can be used to hijack process execution when injected via \`akm env run\`. Ref: ${ref}. Review this file before running \`akm env run\` commands against untrusted stashes. (suppress with: ${SUPPRESSION_COMMENT} on previous line)`,
      fixed: false,
    });
  }
  return diagnostics;
}

// ── skill directory check (SkillLinter.lintDirectory) ────────────────────────

/** The akm-native skill placement dir — the default gate for {@link skillDirectoryDiagnostics}. */
const AKM_SKILL_DIRS: ReadonlySet<string> = new Set(["skills"]);

/**
 * Reproduce `SkillLinter.lintDirectory` (`skill-linter.ts:31-45`) in the
 * change-set model: for a change under `<skillDir>/<name>/…`, emit
 * `missing-skill-md` when `<skillDir>/<name>/SKILL.md` is absent from the
 * overlay. `seen` dedups so a dir with multiple changed files reports once
 * (matching the per-subdir call). `file`/`detail` mirror the live check exactly
 * (relDir + `no SKILL.md in <relDir>/`).
 *
 * `skillDirs` defaults to the akm-native `skills/` placement dir. Tool-dir
 * adapters pass their own canonical placement directory.
 */
export async function skillDirectoryDiagnostics(
  relPath: string,
  seen: Set<string>,
  ctx: ValidateContext,
  skillDirs: ReadonlySet<string> = AKM_SKILL_DIRS,
): Promise<Diagnostic[]> {
  const segments = relPath
    .replace(/\\/g, "/")
    .split("/")
    .filter((s) => s.length > 0);
  if (segments.length < 3 || !skillDirs.has(segments[0]!)) return []; // must be <skillDir>/<name>/<file…>
  const skillDir = `${segments[0]}/${segments[1]}`;
  if (seen.has(skillDir)) return [];
  seen.add(skillDir);
  const skillMd = await ctx.readFile(`${skillDir}/SKILL.md`);
  if (skillMd !== null) return [];
  return [{ file: skillDir, issue: "missing-skill-md", detail: `no SKILL.md in ${skillDir}/`, fixed: false }];
}

// ── per-type dispatch (mirrors getLinterForType) ─────────────────────────────

export interface PerTypeCheckArgs {
  type: string | undefined;
  relPath: string;
  raw: string;
  /** Parsed frontmatter data (or parsed YAML for `task`). */
  data: Record<string, unknown>;
  /** Frontmatter block text, or `null` (non-md / task). */
  frontmatter: string | null;
  /** Frontmatter-stripped body (`parsed.content`) — MemoryLinter/WorkflowLinter's `ctx.body`. */
  body: string;
  /** File extension incl. dot, lower-cased (`.md`, `.yaml`, …). */
  ext: string;
  ctx: ValidateContext;
  /** Materialized component root used for physical working-directory containment. */
  workspaceRoot?: string;
}

/**
 * The winning `type`'s per-type EXTRA validate checks (base checks run
 * separately in `akm-adapter.ts`). Async: memory's orphaned-stub sibling probe
 * routes through `ctx`.
 */
export async function perTypeValidateChecks(args: PerTypeCheckArgs): Promise<Diagnostic[]> {
  const { type, relPath, raw, data, frontmatter, body, ext, ctx, workspaceRoot } = args;
  switch (type) {
    case "command":
      return nameOrTypeDiagnostics(relPath, data, frontmatter, ["command"]);
    case "agent":
      return nameOrTypeDiagnostics(relPath, data, frontmatter, ["agent"]);
    case "fact":
      return factDiagnostics(relPath, data);
    case "task":
      return taskDiagnostics(relPath, raw, workspaceRoot);
    case "workflow":
      // Markdown lint handles `.md`; peer GitHub-shaped `.yml` sources enter through the workflow source adapter.
      return ext === ".md" ? workflowDiagnostics(relPath, raw, body) : [];
    case "memory":
      return memoryDiagnostics(relPath, data, body, ctx);
    case "env":
    case "secret":
      return dangerousEnvKeyDiagnostics(type, relPath, raw);
    default:
      // knowledge / lesson / script / wiki / session → DefaultLinter (base only).
      return [];
  }
}

/** FactLinter extra check (`fact-linter.ts:23-44`). */
export function factDiagnostics(relPath: string, data: Record<string, unknown>): Diagnostic[] {
  const category = typeof data.category === "string" ? data.category.trim() : "";
  if (!category) {
    return [
      {
        file: relPath,
        issue: "missing-category",
        detail: "fact is missing a `category` (personal|team|project|convention|meta)",
        fixed: false,
      },
    ];
  }
  if (!KNOWN_CATEGORIES.has(category)) {
    return [
      {
        file: relPath,
        issue: "missing-category",
        detail: `unrecognized category "${category}" (expected one of: ${[...KNOWN_CATEGORIES].join(", ")})`,
        fixed: false,
      },
    ];
  }
  return [];
}

/**
 * Task validation has one semantic owner: the version-routed task source
 * parser (spec docs/plans/specs/p2a-task-source-v4.md §3.6) — `version: 3`
 * through the strict task-v3 grammar, `version: 4` through task source v4.
 * Keeping raw YAML at this boundary preserves duplicate-key, alias/tag,
 * source-location, descriptor, resource-bound, and migration-hint behavior.
 */
export function taskDiagnostics(relPath: string, raw: string, workspaceRoot?: string): Diagnostic[] {
  try {
    parseTaskSource({
      filePath: relPath,
      yaml: raw,
      ...(workspaceRoot ? { workspaceRoot } : {}),
    });
    return [];
  } catch (cause) {
    return [
      {
        file: relPath,
        issue: "invalid-task-yaml",
        detail: taskSourceErrorDetail(cause),
        fixed: false,
      },
    ];
  }
}

/**
 * The first placeholder marker present in a workflow body, or `null`
 * (`workflow-linter.ts:80-85` `#checkPlaceholderStub`). Shared with the live
 * `akmLint --fix` path (`commands/lint/index.ts`) so the placeholder-stub RULE
 * has ONE home; the caller decides fixability (validate flags, the CLI deletes).
 */
export function matchWorkflowPlaceholder(body: string): string | null {
  return PLACEHOLDER_STRINGS.find((p) => body.includes(p)) ?? null;
}

/**
 * WorkflowLinter's `invalid-workflow-structure` check (`workflow-linter.ts:48-77`):
 * the ERROR half of {@link workflowFrontendDiagnostics}, for the read-only
 * adapter `validate` path. A caller that ALSO surfaces advisories must call
 * {@link workflowFrontendDiagnostics} once instead of pairing this with a
 * second view. NEVER writes.
 */
export function workflowStructureDiagnostics(
  relPath: string,
  raw: string,
  parsePath: string,
): WorkflowFrontendDiagnostic[] {
  return workflowFrontendDiagnostics(relPath, raw, parsePath).errors;
}

/**
 * The `Diagnostic.line` fragment for a line-anchored workflow finding. Every
 * `WorkflowError` carries a 1-indexed `line`; this used to be DROPPED here, so
 * an author linting a 300-line workflow got a message with no location while
 * the same error rendered as `path:line — message` on the `workflow create`
 * path. Spread (`...lineOf(err)`) rather than assigned, so a nonsense line
 * never materializes the optional key on a whole-file finding.
 */
function lineOf(err: { line?: number }): { line?: number } {
  return typeof err.line === "number" && Number.isFinite(err.line) && err.line > 0 ? { line: err.line } : {};
}

/**
 * One workflow frontend finding. The issue code is narrowed to the only two
 * codes this pass emits, so a caller can route the result onto its own closed
 * issue union (`commands/lint/types.ts`'s `LintIssueType`) without a cast.
 */
export type WorkflowFrontendDiagnostic = Diagnostic & {
  issue: "invalid-workflow-structure" | "workflow-warning";
};

/** Both halves of one parse+compile — see {@link workflowFrontendDiagnostics}. */
export interface WorkflowFrontendDiagnostics {
  errors: WorkflowFrontendDiagnostic[];
  warnings: WorkflowFrontendDiagnostic[];
}

/**
 * Compile one peer GitHub-shaped `.yml` source through the shared source-IR
 * frontend. YAML has no Markdown frontmatter/base/stub pass and currently
 * emits fatal source diagnostics only; keeping the same two-channel result
 * shape lets the ordinary sweep and both workflow adapters route it exactly
 * like the established Markdown frontend without inventing another parser.
 */
export function workflowYamlSourceDiagnostics(
  relPath: string,
  raw: string,
  parsePath: string,
  workspaceRoot: string,
): WorkflowFrontendDiagnostics {
  if (isAkmRegistryCachePath(parsePath)) return { errors: [], warnings: [] };
  const compiled = compileWorkflowSource(raw, { path: parsePath, workspaceRoot });
  if (compiled.ok) return { errors: [], warnings: [] };
  return {
    errors: compiled.errors.map((error) => ({
      file: relPath,
      issue: "invalid-workflow-structure",
      detail: error.message,
      fixed: false,
      ...lineOf(error),
    })),
    warnings: [],
  };
}

/**
 * ONE parse+compile of a workflow through the unified frontend, returning both
 * halves of what it produces: fatal `invalid-workflow-structure` findings, and
 * `compileWorkflowPlan`'s non-fatal `workflow-warning` advisories (a step with
 * no `output:` schema, a reference to an undeclared param). The read-only
 * `/.cache/` + `/registry/` cached copies are skipped, and nothing is written.
 *
 * `parsePath` is the source identity handed to `compileWorkflowSource` (the
 * adapter passes the change relPath; the CLI passes the absolute filePath).
 *
 * A caller that surfaces BOTH halves must call this once and route the result
 * itself. The frontend is expensive — instruction bodies reach
 * `WORKFLOW_MAX_INSTRUCTION_BYTES` — so asking for each half through its own
 * view parses and compiles every workflow in the stash twice.
 */
export function workflowFrontendDiagnostics(
  relPath: string,
  raw: string,
  parsePath: string,
): WorkflowFrontendDiagnostics {
  const none: WorkflowFrontendDiagnostics = { errors: [], warnings: [] };
  if (isAkmRegistryCachePath(parsePath)) return none;
  const errors: WorkflowFrontendDiagnostic[] = [];
  const warnings: WorkflowFrontendDiagnostic[] = [];
  try {
    const result = compileWorkflowSource(raw, { path: parsePath });
    if (!result.ok) {
      for (const err of result.errors ?? []) {
        errors.push({
          file: relPath,
          issue: "invalid-workflow-structure",
          detail: err.message ?? String(err),
          fixed: false,
          ...lineOf(err),
        });
      }
      return { errors, warnings };
    }
    const compiled = checkWorkflowPlan(result.plan);
    if (!compiled.ok) {
      for (const err of compiled.errors) {
        errors.push({
          file: relPath,
          issue: "invalid-workflow-structure",
          detail: err.message,
          fixed: false,
          ...lineOf(err),
        });
      }
      return { errors, warnings };
    }
    for (const warning of compiled.warnings) {
      warnings.push({
        file: relPath,
        issue: "workflow-warning",
        detail: warning.message,
        fixed: false,
        ...lineOf(warning),
      });
    }
  } catch (e) {
    errors.push({
      file: relPath,
      issue: "invalid-workflow-structure",
      detail: `workflow parser error: ${e instanceof Error ? e.message : String(e)}`,
      fixed: false,
    });
  }
  return { errors, warnings };
}

/**
 * WorkflowLinter extra checks (`workflow-linter.ts:22-79`), READ-ONLY:
 * `placeholder-stub` is NEVER deleted here (validate MUST NOT write) — emitted
 * as a non-fixable Diagnostic. `invalid-workflow-structure` parses and compiles
 * the whole `raw` through the unified workflow frontend.
 */
function workflowDiagnostics(relPath: string, raw: string, body: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const placeholderMatch = matchWorkflowPlaceholder(body);
  if (placeholderMatch) {
    diagnostics.push({
      file: relPath,
      issue: "placeholder-stub",
      detail: `placeholder text: "${placeholderMatch}"`,
      fixed: false,
    });
  }
  diagnostics.push(...workflowStructureDiagnostics(relPath, raw, relPath));
  return diagnostics;
}

/** The non-fixable orphaned-stub finding detail (`memory-linter.ts` no-fix branch). Shared with the live linter. */
export const ORPHANED_STUB_DETAIL = "inferenceProcessed stub with no derived sibling";

/**
 * The CONTENT half of MemoryLinter's orphaned-stub predicate
 * (`memory-linter.ts:67-73` `#isOrphanedStub`, minus the sibling probe):
 * `inferenceProcessed: true` AND a body under 100 chars. The `.derived.md`
 * sibling existence is I/O and is checked by the caller (the CLI via
 * `fs.existsSync`, the adapter via `ctx.readFile`), so the RULE stays here while
 * each caller supplies its own read.
 */
export function memoryOrphanStubApplies(data: Record<string, unknown>, body: string): boolean {
  return data.inferenceProcessed === true && body.trim().length < 100;
}

/**
 * MemoryLinter extra check (`memory-linter.ts:19-65`), READ-ONLY: the
 * `orphaned-stub` DELETE fix is dropped (validate MUST NOT write) — emitted as
 * a non-fixable Diagnostic. The `<name>.derived.md` sibling probe routes
 * through `ctx.readFile` (overlay), not `fs.existsSync`.
 */
async function memoryDiagnostics(
  relPath: string,
  data: Record<string, unknown>,
  body: string,
  ctx: ValidateContext,
): Promise<Diagnostic[]> {
  if (!memoryOrphanStubApplies(data, body)) return [];
  const derivedPath = `${relPath.replace(/\.md$/, "")}.derived.md`;
  const sibling = await ctx.readFile(derivedPath);
  if (sibling !== null) return [];
  return [{ file: relPath, issue: "orphaned-stub", detail: ORPHANED_STUB_DETAIL, fixed: false }];
}

// Re-export the component type so `akm-adapter.ts` can share it without a
// second import site if it ever needs it here (keeps the leaf self-describing).
export type { BundleComponent };
