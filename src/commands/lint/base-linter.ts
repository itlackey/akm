// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// CONTRACT: ref-resolver
// ----------------------------------------------------------------------------
// The `refExistsInAnyStash` and `refToRelPath` helpers below are contract-
// locked: a sister copy lives in the akm-plugins repo at
// `shared/ref-extraction.ts` (and the runtime-shipped duplicate at
// `claude/shared/ref-extraction.ts`). Both implementations resolve the same
// `<type>:<slug>` -> on-disk-asset question and MUST agree on the set of
// reachable refs for any given stash layout.
//
// The lock is enforced by `tests/contracts/ref-resolver-contract.test.ts`,
// which drives this implementation through a canonical fixture set. The
// akm-plugins repo ships an equivalent test that drives its copy through the
// SAME inputs and asserts identical outcomes. Any change to the resolver
// behavior on either side MUST update both contract tests in lockstep, or one
// will fail.
//
// Cases the contract covers (see fixture in the contract test):
//   - existing memory / knowledge / agent / workflow / skill refs
//   - knowledge subdirectory layout (knowledge/<category>/<slug>.md)
//   - skill multi-file layout (skills/<slug>/SKILL.md)
//   - memory `.derived.md` sibling
//   - namespaced slugs containing `/`
//   - env (`env/.env`, `env/<name>.env`) and secret (`secrets/<name>`) refs
//   - non-existent refs
//   - script type (unresolvable by design — both must return false)
//
// As of 0.9 the type alternation in `REF_RE` and the path mapping in
// `refToRelPath` are DERIVED FROM THE ASSET REGISTRY (`getAssetTypes()` /
// `resolveAssetPathFromName` in `src/core/asset/asset-spec.ts`) rather than
// hand-encoded, so they can no longer drift from the registry. The previously
// hand-listed `vault` type was removed from the registry in 0.9 (replaced by
// `env`); `vault:` refs are therefore no longer matched here. `env:`/`secret:`
// refs are now matched and path-resolved. `script` stays unresolvable and
// `task` keeps its legacy `.md` resolution (see refToRelPath for both).
// ----------------------------------------------------------------------------

import fs from "node:fs";
import path from "node:path";
import { getAssetTypes, resolveAssetPathFromName, TYPE_DIRS } from "../../core/asset/asset-spec";
import { findSafeInsertionPoint } from "./markdown-insertion";
import type { AssetLinter, LintContext, LintIssue } from "./types";

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function checkUnquotedColon(frontmatterText: string | null): string | null {
  if (!frontmatterText) return null;
  for (const line of frontmatterText.split(/\r?\n/)) {
    const match = line.match(/^description:\s*(.*)/);
    if (!match) continue;
    const value = match[1].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      return null;
    }
    if (value.includes(":")) {
      return `description value contains unquoted colon: ${value}`;
    }
  }
  return null;
}

function fixUnquotedColon(raw: string): string {
  return raw.replace(/^(description:\s*)(.*)/m, (_match, prefix, value) => {
    const trimmed = value.trim();
    if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
      return _match;
    }
    const escaped = trimmed.replace(/"/g, '\\"');
    return `${prefix}"${escaped}"`;
  });
}

function checkMissingUpdated(data: Record<string, unknown>, frontmatterText: string | null): boolean {
  return frontmatterText !== null && !("updated" in data);
}

function fixMissingUpdated(raw: string, mtime: Date): string {
  const dateStr = formatDate(mtime);
  return raw.replace(/^(---\n[\s\S]*?)\n---/m, `$1\nupdated: ${dateStr}\n---`);
}

// ── stale-path helpers ────────────────────────────────────────────────────────

function checkStalePath(body: string): string | null {
  const pathRe = /\/home\/[^\s"'`)\]>,]+/g;
  let match: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic regex loop
  while ((match = pathRe.exec(body)) !== null) {
    const candidate = match[0];
    if (!fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

// ── missing-ref helpers ───────────────────────────────────────────────────────

/**
 * Type alternation for {@link REF_RE}, derived from the asset registry at
 * module load so it can never drift from `ASSET_SPECS`. Longest-first ordering
 * is defensive (no built-in type is a prefix of another, but a future custom
 * `registerAssetType` one might be) so the alternation prefers the longest
 * match. Regex metacharacters are escaped in case a custom type introduces one.
 */
function buildRefTypeAlternation(): string {
  const types = [...getAssetTypes()].sort((a, b) => b.length - a.length);
  return types.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
}

// Only the TYPE alternation is registry-derived; the surrounding grammar
// (boundary prefix, capture group, slug charset) is byte-identical to the
// legacy hand-written pattern. Deriving the types from `getAssetTypes()` means
// `env`/`secret` (added in 0.9) are now matched, and the removed `vault` type
// is not — both follow the registry automatically.
const REF_RE = new RegExp(`(?:^|[\\s\`"'(])((${buildRefTypeAlternation()}):[^\\s"'\`)\\]>,\\n]+)`, "gm");

/**
 * Map from ref type to relative path pattern within stashRoot. Returns null to
 * skip (type is unresolvable by the slug walker).
 *
 * Path layout is owned by the asset registry: we resolve through
 * `resolveAssetPathFromName(type, TYPE_DIRS[type], name)` so the linter and the
 * rest of the CLI agree on where an asset lives. Two legacy carve-outs are
 * preserved to keep pre-0.9 behaviour byte-identical:
 *   - `script`: returns null (scripts live in nested dirs with arbitrary
 *     extensions — unresolvable by the slug-based walker, as the contract pins).
 *   - `task`: the registry stores tasks as `<id>.yml`, but the missing-ref
 *     linter has always resolved `task:` refs against `tasks/<id>.md`; that
 *     behaviour is held constant here (non-env/secret behaviour is unchanged).
 *
 * Exported for contract testing — see header CONTRACT block.
 */
export function refToRelPath(refType: string, refName: string): string | null {
  // script is intentionally unresolvable (contract-pinned).
  if (refType === "script") return null;
  // Preserve the legacy `.md` resolution for tasks.
  if (refType === "task") return path.join(TYPE_DIRS.task ?? "tasks", `${refName}.md`);

  const typeDir = TYPE_DIRS[refType];
  if (!typeDir) return null; // unknown type — skip
  // resolveAssetPathFromName returns a path rooted at the type dir we pass in,
  // i.e. "<typeDir>/<...>" — exactly the stash-relative path this helper has
  // always returned.
  return resolveAssetPathFromName(refType, typeDir, refName);
}

/**
 * Returns true if `relPath` resolves to a real file (or multi-file directory
 * primary) in ANY of the provided stash roots.
 *
 * Exported for contract testing — see header CONTRACT block.
 */
export function refExistsInAnyStash(relPath: string, refType: string, refName: string, stashRoots: string[]): boolean {
  for (const root of stashRoots) {
    const absPath = path.join(root, relPath);
    if (fs.existsSync(absPath)) return true;
    // Multi-file skill layout: directory containing SKILL.md
    const bareDir = absPath.replace(/\.md$/, "");
    if (fs.existsSync(bareDir) && fs.existsSync(path.join(bareDir, "SKILL.md"))) return true;
    // .derived.md variant for memory refs
    if (refType === "memory") {
      const derivedPath = path.join(root, "memories", `${refName}.derived.md`);
      if (fs.existsSync(derivedPath)) return true;
    }
    // Knowledge-specific: search subdirectories like knowledge/projects/, knowledge/tools/, etc.
    if (refType === "knowledge") {
      try {
        const knowledgeDir = path.join(root, "knowledge");
        if (fs.existsSync(knowledgeDir) && fs.statSync(knowledgeDir).isDirectory()) {
          const entries = fs.readdirSync(knowledgeDir);
          for (const entry of entries) {
            const subPath = path.join(knowledgeDir, entry, `${refName}.md`);
            if (fs.existsSync(subPath)) return true;
          }
        }
      } catch {
        // Ignore errors reading directory
      }
    }
    // Fallback: the refName may already encode the full stash-relative path
    // (e.g. knowledge:skills/foo/references/bar where the file lives at
    // <stash>/skills/foo/references/bar.md, not <stash>/knowledge/skills/...).
    const directPath = path.join(root, `${refName}.md`);
    if (fs.existsSync(directPath)) return true;
    const directDir = path.join(root, refName);
    if (fs.existsSync(directDir) && fs.existsSync(path.join(directDir, "SKILL.md"))) return true;
  }
  return false;
}

/**
 * Returns an array of {ref, resolvedRelPath} for every local AKM ref in the
 * body that does not resolve to a real file under any of the provided stash roots.
 *
 * Skips false-positive patterns:
 * - Shell variables: memory:$(cmd) or knowledge:${VAR}
 * - ACP type notation: agent::Type (double colons are C++/ACP syntax)
 * - Incomplete/placeholder refs: slug is single character or "**"
 */
function checkMissingRefs(
  body: string,
  stashRoot: string,
  extraStashRoots: string[] = [],
): Array<{ ref: string; resolvedRelPath: string }> {
  const allRoots = [stashRoot, ...extraStashRoots];
  const missing: Array<{ ref: string; resolvedRelPath: string }> = [];
  let match: RegExpExecArray | null;
  const re = new RegExp(REF_RE.source, REF_RE.flags);

  // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic regex loop
  while ((match = re.exec(body)) !== null) {
    const fullRef = match[1]; // e.g. "workflow:foo" or "local//workflow:foo"

    // Skip shell variables: memory:$(cmd) or knowledge:${VAR}
    if (fullRef.includes("$(") || fullRef.includes("${")) {
      continue;
    }

    // Skip ACP type notation: agent::Type (double colons)
    if (fullRef.includes("::")) {
      continue;
    }

    // Strip leading "local//" prefix if present
    let ref = fullRef;
    if (ref.startsWith("local//")) {
      ref = ref.slice("local//".length);
    } else if (fullRef.includes("//")) {
      // Has a remote origin prefix (e.g. "npm:", "github:", "owner/repo//") — skip
      continue;
    }

    // Skip refs that start with obvious remote prefixes
    const colonIdx = ref.indexOf(":");
    if (colonIdx === -1) continue;
    const refType = ref.slice(0, colonIdx);
    const refName = ref.slice(colonIdx + 1);

    // Guard against empty names or names that look like paths/URLs
    if (!refName || refName.startsWith("/") || refName.startsWith("~") || refName.startsWith("http")) {
      continue;
    }

    // Skip placeholder/incomplete refs: single character slug or "**"
    if (refName.length <= 1 || refName === "**") {
      continue;
    }

    const relPath = refToRelPath(refType, refName);
    if (relPath === null) continue; // type is skipped

    if (!refExistsInAnyStash(relPath, refType, refName, allRoots)) {
      missing.push({ ref: fullRef, resolvedRelPath: relPath });
    }
  }

  return missing;
}

// ── frontmatter refs ─────────────────────────────────────────────────────────

/**
 * Return the `refs:` array from frontmatter when it is present and is an
 * array of strings; otherwise return `null` to signal the caller should
 * fall back to scanning the body. An empty array (`refs: []`) is also
 * treated as authoritative — it explicitly declares "this asset has no
 * outbound refs" and suppresses the body scan.
 *
 * The `refs:` frontmatter key is used by the claude-code session-capture
 * hook (see `shared/ref-extraction.ts` in the akm-plugins repo) to
 * persist a validated outbound-ref list alongside the raw transcript.
 * Hand-written memories rarely populate this key — for those the body
 * scan remains the source of truth.
 *
 * Session-checkpoint memories use a nested frontmatter pattern: `akm
 * remember` wraps the file in `---\n…\n---` and the hook's own
 * `---\nakm_memory_kind: session_checkpoint\n…\n---` block is preserved
 * inside the body. We look in both places so the `refs:` key works
 * regardless of where the producer wrote it.
 */
function extractFrontmatterRefs(data: Record<string, unknown>, body: string): string[] | null {
  const fromOuter = readRefsArray(data.refs);
  if (fromOuter !== null) return fromOuter;
  const innerData = parseInnerFrontmatterBlock(body);
  if (innerData) {
    const fromInner = readRefsArray(innerData.refs);
    if (fromInner !== null) return fromInner;
  }
  return null;
}

function readRefsArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry === "string" && entry.trim()) out.push(entry.trim());
  }
  return out;
}

/**
 * Detect a leading nested frontmatter block in `body` (i.e. a `---\n…\n---`
 * pair that opens within the first few lines of the body). When present,
 * parse a minimal subset of YAML — top-level scalars and block-list
 * arrays — sufficient to recognise the `refs:` key. Anything fancier is
 * silently ignored.
 *
 * This is a deliberately narrow parser: lint must never throw on
 * unexpected YAML, and the only key we care about here is `refs:`.
 */
function parseInnerFrontmatterBlock(body: string): Record<string, unknown> | null {
  // Skip up to three blank/header lines, then require `---` to open the block.
  const lines = body.split(/\r?\n/);
  let i = 0;
  while (i < lines.length && i < 3 && lines[i].trim() === "") i += 1;
  if (lines[i] !== "---") return null;
  const open = i;
  let close = -1;
  for (let j = open + 1; j < lines.length; j += 1) {
    if (lines[j] === "---") {
      close = j;
      break;
    }
  }
  if (close === -1) return null;
  const block = lines.slice(open + 1, close);
  const data: Record<string, unknown> = {};
  let currentKey: string | null = null;
  let currentList: string[] | null = null;
  for (const line of block) {
    const listItem = line.match(/^(?: {2})?- (.*)$/);
    if (listItem && currentList) {
      currentList.push(listItem[1].trim().replace(/^["'](.*)["']$/, "$1"));
      continue;
    }
    const inlineFlow = line.match(/^(\w[\w-]*):\s*\[(.*)\]\s*$/);
    if (inlineFlow) {
      currentKey = inlineFlow[1];
      const items = inlineFlow[2]
        .split(",")
        .map((s) => s.trim().replace(/^["'](.*)["']$/, "$1"))
        .filter(Boolean);
      data[currentKey] = items;
      currentList = null;
      continue;
    }
    const kv = line.match(/^(\w[\w-]*):\s*(.*)$/);
    if (!kv) continue;
    currentKey = kv[1];
    const value = kv[2].trim();
    if (value === "") {
      currentList = [];
      data[currentKey] = currentList;
    } else {
      data[currentKey] = value.replace(/^["'](.*)["']$/, "$1");
      currentList = null;
    }
  }
  return data;
}

// ── BaseLinter ────────────────────────────────────────────────────────────────

/**
 * Abstract base class providing the two cross-type checks shared by all asset
 * linters: `unquoted-colon` and `missing-updated`.
 *
 * Subclasses call `runBaseChecks(ctx)` and append any type-specific issues.
 * File mutations triggered by base checks are flushed to disk inside this
 * method; subclasses must re-read `ctx.raw` if they need the post-fix content
 * (in practice the base class updates `ctx.raw` in place when `fix` is true).
 */
export abstract class BaseLinter implements AssetLinter {
  abstract readonly types: readonly string[];
  abstract lint(ctx: LintContext): LintIssue[];

  /**
   * Insert one or more lines into a markdown body at a safe location.
   *
   * "Safe" means: not inside a markdown table, HTML table, fenced code block,
   * or indented code block. If `proposedLineNumber` falls inside one of those
   * regions, the helper pushes the insertion to immediately after the region.
   * This is a regression guard against the class of bug where an auto-fix
   * splits a table fence by injecting a callout between the separator row
   * and the first data row (broke `knowledge/akm-cli-reference.md` in 0.8.0).
   *
   * Subclasses that perform line-based body insertion MUST route through this
   * helper instead of calling `splice` directly. Insertion fixers must NOT
   * touch frontmatter — use `fixMissingUpdated` / `fixUnquotedColon` style
   * regex edits for that case (those already operate inside the `---…---`
   * fence and don't intersect with body line numbers).
   *
   * @param raw                 Full file contents (frontmatter + body).
   * @param newLines            Lines to insert (without trailing newlines).
   * @param proposedLineNumber  0-based line index within `raw` where the
   *                            caller wants the new content to appear.
   * @returns The mutated file contents with `newLines` spliced at the
   *          adjusted safe position.
   */
  protected insertLinesSafely(raw: string, newLines: string[], proposedLineNumber: number): string {
    const lines = raw.split(/\r?\n/);
    const safeIdx = findSafeInsertionPoint(lines, proposedLineNumber);
    lines.splice(safeIdx, 0, ...newLines);
    return lines.join("\n");
  }

  protected runBaseChecks(ctx: LintContext): LintIssue[] {
    const issues: LintIssue[] = [];
    let currentRaw = ctx.raw;
    let modified = false;

    // ── 1. unquoted-colon ──────────────────────────────────────────────────
    const unquotedColonDetail = checkUnquotedColon(ctx.frontmatter);
    if (unquotedColonDetail) {
      if (ctx.fix) {
        currentRaw = fixUnquotedColon(currentRaw);
        modified = true;
        issues.push({
          file: ctx.relPath,
          issue: "unquoted-colon",
          detail: unquotedColonDetail,
          fixed: true,
        });
      } else {
        issues.push({
          file: ctx.relPath,
          issue: "unquoted-colon",
          detail: unquotedColonDetail,
          fixed: false,
        });
      }
    }

    // ── 2. missing-updated ─────────────────────────────────────────────────
    if (checkMissingUpdated(ctx.data, ctx.frontmatter)) {
      if (ctx.fix) {
        let mtime: Date;
        try {
          mtime = fs.statSync(ctx.filePath).mtime;
        } catch {
          mtime = new Date();
        }
        currentRaw = fixMissingUpdated(currentRaw, mtime);
        modified = true;
        issues.push({
          file: ctx.relPath,
          issue: "missing-updated",
          detail: `stamped updated: ${formatDate(mtime)}`,
          fixed: true,
        });
      } else {
        issues.push({
          file: ctx.relPath,
          issue: "missing-updated",
          detail: "no updated field in frontmatter",
          fixed: false,
        });
      }
    }

    if (modified) {
      fs.writeFileSync(ctx.filePath, currentRaw, "utf8");
      // Propagate the mutated raw back so subclasses can re-parse if needed
      ctx.raw = currentRaw;
    }

    // ── 3. stale-path ──────────────────────────────────────────────────────
    const stalePathMatch = checkStalePath(ctx.body);
    if (stalePathMatch) {
      issues.push({
        file: ctx.relPath,
        issue: "stale-path",
        detail: `nonexistent path: ${stalePathMatch}`,
        fixed: false,
      });
    }

    // ── 4. missing-ref ─────────────────────────────────────────────────────
    // Carve-out for assets that declare an explicit `refs:` array in
    // frontmatter (e.g. session-checkpoint memories captured by the
    // claude-code hook). The frontmatter array is the *authoritative*
    // ref list — any ref-shaped tokens in the body are treated as
    // literal strings (heredocs, grep patterns, JSON values, regex
    // patterns embedded in tool transcripts). Without this carve-out
    // every session capture produces a fresh batch of `missing-ref`
    // flags on every literal `<type>:<slug>` token in a transcript.
    //
    // The producer guarantees that entries in `refs:` already resolve
    // (it validates against the live stash before writing), so we
    // still run `checkMissingRefs` against the array itself to catch
    // refs that were valid at capture time but later removed from the
    // stash.
    const explicitRefs = extractFrontmatterRefs(ctx.data, ctx.body);
    const refSource = explicitRefs !== null ? explicitRefs.join("\n") : ctx.body;
    const missingRefs = checkMissingRefs(refSource, ctx.stashRoot, ctx.extraStashRoots);
    for (const { ref, resolvedRelPath } of missingRefs) {
      issues.push({
        file: ctx.relPath,
        issue: "missing-ref",
        detail: `missing ref: ${ref} (resolved to ${resolvedRelPath})`,
        fixed: false,
      });
    }

    return issues;
  }
}
