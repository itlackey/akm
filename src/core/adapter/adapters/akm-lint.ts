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
 * cycle. It VALUE-imports `parseWorkflow` (already transitively reachable from
 * `akm-adapter` via `matchers.ts`) and the PURE predicate `isDangerousVaultKey`
 * from `commands/lint/env-key-rules` — the predicate is imported, not copied,
 * precisely so the 40+ security-sensitive dangerous-key names cannot drift from
 * the canonical set; importing it is ratchet-neutral (verified: 18). The small
 * key-scan / suppression-comment logic IS ported (content-based, reads the
 * overlay `raw`, not disk). `type` determination stays in `akm-adapter.ts`
 * (which owns `recognizeMatch`) so this leaf never imports back into the
 * adapter.
 */

import path from "node:path";
import { isDangerousVaultKey } from "../../../commands/lint/env-key-rules";
import { parseWorkflow } from "../../../workflows/parser";
import type { BundleComponent, Diagnostic, ValidateContext } from "../types";

/** Recommended `category` values for facts — `commands/lint/fact-linter.ts:9`. */
const KNOWN_CATEGORIES = new Set(["personal", "team", "project", "convention", "meta"]);

/** Placeholder markers a workflow stub carries — `commands/lint/workflow-linter.ts:10`. */
const PLACEHOLDER_STRINGS = ["Describe what this workflow accomplishes", "Example Workflow"];

/** Inline suppression token — `commands/lint/env-key-rules.ts:138` (not exported there; reproduced verbatim). */
const SUPPRESSION_COMMENT = "# akm-lint-ok: dangerous-vault-key";

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
function nameOrTypeDiagnostics(
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

/** Matches a KEY=value assignment line, capturing only the key — `commands/env/env.ts:62`. */
const ASSIGN_RE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;

/** Port of `commands/env/env.ts#scanKeys` (`:65-77`) — content-based (overlay `raw`, not disk). */
function scanKeys(text: string): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(ASSIGN_RE);
    if (!m) continue;
    const key = m[1];
    if (seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }
  return keys;
}

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
      suppressed.add(keyMatch[1]);
    }
    prevNonEmpty = trimmed;
  }
  return suppressed;
}

/**
 * env/secret dangerous-key scan (`lint/index.ts:191-218` + `env-key-rules.ts#checkVaultForDangerousKeys`),
 * keyed on `type` and preserving the `.env`-suffix narrowness (see file header).
 * Reads the overlay `raw`, not disk. `type`==="env" ⇒ ref prefix `env:`;
 * `type`==="secret" ⇒ `secret:` (`lint/index.ts:201-204`).
 */
export function dangerousEnvKeyDiagnostics(type: string | undefined, relPath: string, raw: string): Diagnostic[] {
  if (type !== "env" && type !== "secret") return [];
  const baseNameWithExt = path.basename(relPath);
  if (!baseNameWithExt.endsWith(".env")) return []; // NARROWNESS: collectEnvFiles only visits *.env
  const refPrefix = type === "env" ? "env" : "secret";
  const baseName = path.basename(relPath, ".env");
  const ref = baseName === "" ? `${refPrefix}:.env` : `${refPrefix}:${baseName}`;

  const keys = scanKeys(raw);
  const suppressed = collectSuppressedKeys(raw);
  const diagnostics: Diagnostic[] = [];
  for (const key of keys) {
    if (!isDangerousVaultKey(key)) continue;
    if (suppressed.has(key)) continue;
    diagnostics.push({
      file: relPath,
      issue: "dangerous-vault-key",
      detail: `Env key \`${key}\` can be used to hijack process execution when injected via \`akm env run\`. Ref: ${ref}. Review this file before running \`akm env run\` commands against untrusted stashes. (suppress with: ${SUPPRESSION_COMMENT} on previous line)`,
      fixed: false,
    });
  }
  return diagnostics;
}

// ── skill directory check (SkillLinter.lintDirectory) ────────────────────────

/**
 * Reproduce `SkillLinter.lintDirectory` (`skill-linter.ts:31-45`) in the
 * change-set model: for a change under `skills/<name>/…`, emit `missing-skill-md`
 * when `skills/<name>/SKILL.md` is absent from the overlay. `seen` dedups so a
 * dir with multiple changed files reports once (matching the per-subdir call).
 * `file`/`detail` mirror the live check exactly (relDir + `no SKILL.md in <relDir>/`).
 */
export async function skillDirectoryDiagnostics(
  relPath: string,
  seen: Set<string>,
  ctx: ValidateContext,
): Promise<Diagnostic[]> {
  const segments = relPath
    .replace(/\\/g, "/")
    .split("/")
    .filter((s) => s.length > 0);
  if (segments.length < 3 || segments[0] !== "skills") return []; // must be skills/<name>/<file…>
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
}

/**
 * The winning `type`'s per-type EXTRA validate checks (base checks run
 * separately in `akm-adapter.ts`). Async: memory's orphaned-stub sibling probe
 * routes through `ctx`.
 */
export async function perTypeValidateChecks(args: PerTypeCheckArgs): Promise<Diagnostic[]> {
  const { type, relPath, raw, data, frontmatter, body, ext, ctx } = args;
  switch (type) {
    case "command":
      return nameOrTypeDiagnostics(relPath, data, frontmatter, ["command"]);
    case "agent":
      return nameOrTypeDiagnostics(relPath, data, frontmatter, ["agent"]);
    case "fact":
      return factDiagnostics(relPath, data);
    case "task":
      return taskDiagnostics(relPath, data);
    case "workflow":
      // WorkflowLinter only ever sees `.md` in production (collectMarkdownFiles
      // filters `.md`); YAML programs are not a lint path (lint golden pins the
      // workflow-program via parseWorkflowProgram, not a linter). So the extra
      // checks apply to markdown workflows only.
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
function factDiagnostics(relPath: string, data: Record<string, unknown>): Diagnostic[] {
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

/** TaskLinter extra check (`task-linter.ts:25-58`). `data` is the parsed YAML. */
function taskDiagnostics(relPath: string, data: Record<string, unknown>): Diagnostic[] {
  if (data === null || Object.keys(data).length === 0) return [];
  const missing: string[] = [];
  if (!("schedule" in data) || typeof data.schedule !== "string" || data.schedule.trim() === "") {
    missing.push("schedule");
  }
  if (!("enabled" in data) || typeof data.enabled !== "boolean") {
    missing.push("enabled (must be a boolean)");
  }
  const hasTarget = "prompt" in data || "workflow" in data || "command" in data;
  if (!hasTarget) missing.push("prompt, workflow, or command");
  if (missing.length > 0) {
    return [
      {
        file: relPath,
        issue: "invalid-task-yaml",
        detail: `missing required fields: ${missing.join(", ")}`,
        fixed: false,
      },
    ];
  }
  return [];
}

/**
 * WorkflowLinter extra checks (`workflow-linter.ts:22-79`), READ-ONLY:
 * `placeholder-stub` is NEVER deleted here (validate MUST NOT write) — emitted
 * as a non-fixable Diagnostic. `invalid-workflow-structure` re-parses via
 * `parseWorkflow` over the whole `raw` (mirroring `parseWorkflow(ctx.raw, …)`).
 */
function workflowDiagnostics(relPath: string, raw: string, body: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const placeholderMatch = PLACEHOLDER_STRINGS.find((p) => body.includes(p)) ?? null;
  if (placeholderMatch) {
    diagnostics.push({
      file: relPath,
      issue: "placeholder-stub",
      detail: `placeholder text: "${placeholderMatch}"`,
      fixed: false,
    });
  }
  // The live linter skips `/.cache/` and `/registry/` (read-only cached copies).
  if (!relPath.includes("/.cache/") && !relPath.includes("/registry/")) {
    try {
      const result = parseWorkflow(raw, { path: relPath });
      if (!result.ok) {
        for (const err of result.errors ?? []) {
          diagnostics.push({
            file: relPath,
            issue: "invalid-workflow-structure",
            detail: err.message ?? String(err),
            fixed: false,
          });
        }
      }
    } catch (e) {
      diagnostics.push({
        file: relPath,
        issue: "invalid-workflow-structure",
        detail: `workflow parser error: ${e instanceof Error ? e.message : String(e)}`,
        fixed: false,
      });
    }
  }
  return diagnostics;
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
  if (data.inferenceProcessed !== true) return [];
  if (body.trim().length >= 100) return [];
  const derivedPath = `${relPath.replace(/\.md$/, "")}.derived.md`;
  const sibling = await ctx.readFile(derivedPath);
  if (sibling !== null) return [];
  return [
    { file: relPath, issue: "orphaned-stub", detail: "inferenceProcessed stub with no derived sibling", fixed: false },
  ];
}

// Re-export the component type so `akm-adapter.ts` can share it without a
// second import site if it ever needs it here (keeps the leaf self-describing).
export type { BundleComponent };
