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
// As of 0.9 the path mapping in `refToRelPath` is DERIVED FROM THE PLACEMENT
// SPECS (`assetPathForName` in `src/core/asset/asset-placement.ts`) rather than
// hand-encoded, so it can no longer drift from the placement layer. `env`/
// `secret` refs are path-resolved. `script` stays unresolvable and `task`
// keeps its legacy `.md` resolution (see refToRelPath for both).
// ----------------------------------------------------------------------------

import fs from "node:fs";
import path from "node:path";
import { assetPathForName, stashDirFor } from "../../core/asset/asset-placement";
import { BUNDLE_REF_RE } from "../../core/asset/asset-ref";
import { typeNameFromConceptId } from "../../core/asset/resolve-ref";
import { findFenceRegions, findSafeInsertionPoint } from "./markdown-insertion";
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
  const lines = raw.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return raw;
  const closeIdx = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  if (closeIdx === -1) return raw;
  for (let i = 1; i < closeIdx; i++) {
    const m = lines[i].match(/^(description:\s*)(.*)/);
    if (!m) continue;
    const prefix = m[1];
    const value = m[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    )
      continue;
    lines[i] = `${prefix}"${value.replace(/"/g, '\\"')}"`;
    break;
  }
  return lines.join("\n");
}

function checkMissingUpdated(data: Record<string, unknown>, frontmatterText: string | null): boolean {
  return frontmatterText !== null && !("updated" in data);
}

function fixMissingUpdated(raw: string, mtime: Date): string {
  const dateStr = formatDate(mtime);
  const lines = raw.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return raw;
  const closeIdx = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  if (closeIdx === -1) return raw;
  lines.splice(closeIdx, 0, `updated: ${dateStr}`);
  return lines.join("\n");
}

// ── stale-path helpers ────────────────────────────────────────────────────────

function checkStalePath(body: string): string[] {
  const pathRe = /(?:\/home\/|\/tmp\/|\/var\/|\/root\/|\/opt\/)[^\s"'`)\]>,\n]+/g;
  let match: RegExpExecArray | null;
  const stale: string[] = [];
  // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic regex loop
  while ((match = pathRe.exec(body)) !== null) {
    const candidate = match[0];
    if (!fs.existsSync(candidate)) {
      stale.push(candidate);
    }
  }
  return stale;
}

// ── fence-strip helper ────────────────────────────────────────────────────────

/**
 * Returns `body` with all fenced code block lines replaced by empty strings,
 * so that ref-shaped tokens inside ``` examples are not flagged as broken refs.
 */
function stripFencedBlocks(body: string): string {
  const lines = body.split(/\r?\n/);
  const regions = findFenceRegions(lines);
  if (regions.length === 0) return body;
  for (const { start, end } of regions) {
    for (let i = start; i <= end; i++) lines[i] = "";
  }
  return lines.join("\n");
}

// ── missing-ref helpers ───────────────────────────────────────────────────────

/**
 * Body-ref boundary grammar, shared with `akm mv`'s ref-rewrite pattern —
 * `src/commands/mv-cli.ts` imports these constants so the two grammars cannot
 * drift. Any character-class change here retargets both the lint missing-ref
 * scan and mv's inbound-xref rewriting.
 *
 * `REF_BOUNDARY_PREFIX_CLASS_SRC` is the character class a ref may start
 * after (a ref also matches at line start): whitespace, backtick, quote,
 * `(`, `[`, or `,` — the `[` admits markdown-link-style refs like
 * `see [memory:foo]`, which the legacy class silently skipped, and the `,`
 * admits the ref AFTER a bare comma in a no-space flow list like
 * `xrefs: [memory:a,memory:b]` (valid YAML). `,` is already a slug
 * TERMINATOR (excluded from `REF_SLUG_CHAR_CLASS_SRC`), so `a,b` splits
 * cleanly and adding it here cannot extend any existing match; false
 * positives are fenced by the type alternation — a comma only starts a match
 * when a literal `<type>:` follows it.
 *
 * `REF_SLUG_CHAR_CLASS_SRC` is the character class a ref's `<type>:<slug>`
 * token is made of; the first excluded character ends the ref.
 */
export const REF_BOUNDARY_PREFIX_CLASS_SRC = "[\\s`\"'(,\\[]";
export const REF_SLUG_CHAR_CLASS_SRC = "[^\\s\"'`)\\]>,\\n]";

/**
 * Map from ref type to relative path pattern within stashRoot. Returns null to
 * skip (type is unresolvable by the slug walker).
 *
 * Path layout is owned by the placement layer: we resolve through
 * `assetPathForName(type, stashDirFor(type), name)` so the linter and the
 * rest of the CLI agree on where an asset lives. Two legacy carve-outs are
 * preserved to keep pre-0.9 behaviour byte-identical:
 *   - `script`: returns null (scripts live in nested dirs with arbitrary
 *     extensions — unresolvable by the slug-based walker, as the contract pins).
 *   - `task`: M1 fix — tasks are stored as `<id>.yml` on disk, so resolve
 *     `task:` refs against `tasks/<id>.yml` to match actual on-disk layout.
 *
 * Exported for contract testing — see header CONTRACT block.
 */
export function refToRelPath(refType: string, refName: string): string | null {
  // script is intentionally unresolvable (contract-pinned).
  if (refType === "script") return null;
  // M1: tasks are stored as .yml on disk; resolve task: refs against tasks/<id>.yml.
  if (refType === "task") return path.join(stashDirFor("task") ?? "tasks", `${refName}.yml`);

  const typeDir = stashDirFor(refType);
  if (!typeDir) return null; // unknown type — skip
  // assetPathForName returns a path rooted at the type dir we pass in,
  // i.e. "<typeDir>/<...>" — exactly the stash-relative path this helper has
  // always returned.
  return assetPathForName(refType, typeDir, refName);
}

/**
 * Returns true if `relPath` resolves to a real file (or multi-file directory
 * primary) in ANY of the provided stash roots.
 *
 * Exported for contract testing — see header CONTRACT block.
 */
export function refExistsInAnyStash(relPath: string, refType: string, refName: string, stashRoots: string[]): boolean {
  for (const root of stashRoots) {
    if (resolveRefPathInStash(relPath, refType, refName, root) !== null) return true;
  }
  return false;
}

/**
 * Resolve the on-disk primary file for a ref within a SINGLE stash root, using
 * the same reachability rules (in the same order) as
 * {@link refExistsInAnyStash}, which delegates here. Returns the absolute path
 * of the file that makes the ref "exist" — for a multi-file skill directory
 * that is its `SKILL.md` primary — or `null` when the ref does not resolve in
 * this root.
 *
 * Extracted for SPEC-5 (`--supersedes` demotion): write commands need the
 * superseded asset's actual file to mutate, and forking a second resolver
 * would drift from lint's. NOT part of the akm-plugins ref-resolver contract
 * (the contract pins `refToRelPath` + `refExistsInAnyStash`; this is the
 * shared internal both build on).
 */
export function resolveRefPathInStash(relPath: string, refType: string, refName: string, root: string): string | null {
  const absPath = path.join(root, relPath);
  if (fs.existsSync(absPath)) return absPath;
  // Multi-file skill layout: directory containing SKILL.md
  const bareDir = absPath.replace(/\.md$/, "");
  if (fs.existsSync(bareDir) && fs.existsSync(path.join(bareDir, "SKILL.md"))) {
    return path.join(bareDir, "SKILL.md");
  }
  // .derived.md variant for memory refs
  if (refType === "memory") {
    const derivedPath = path.join(root, "memories", `${refName}.derived.md`);
    if (fs.existsSync(derivedPath)) return derivedPath;
  }
  // Knowledge-specific: search subdirectories like knowledge/projects/, knowledge/tools/, etc.
  if (refType === "knowledge") {
    try {
      const knowledgeDir = path.join(root, "knowledge");
      if (fs.existsSync(knowledgeDir) && fs.statSync(knowledgeDir).isDirectory()) {
        const entries = fs.readdirSync(knowledgeDir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const subPath = path.join(knowledgeDir, entry.name, `${refName}.md`);
          if (fs.existsSync(subPath)) return subPath;
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
  if (fs.existsSync(directPath)) return directPath;
  const directDir = path.join(root, refName);
  if (fs.existsSync(directDir) && fs.existsSync(path.join(directDir, "SKILL.md"))) {
    return path.join(directDir, "SKILL.md");
  }
  return null;
}

/**
 * A `(refType, refName)` pair that is not a lint-checkable local asset ref —
 * shared skip-guard for BOTH recognition arms (legacy `type:name` and the 0.9.0
 * `bundle//conceptId` grammar). Filters the false-positive patterns:
 *   - Shell variables: memory:$(cmd) or knowledge:${VAR} (guarded by callers on
 *     the raw token, before it is split).
 *   - Empty names or names that look like absolute paths / home dirs / URLs.
 *   - Incomplete/placeholder refs: single-character slug or "**".
 *   - Template placeholder refs like skill:<name> / workflow:<my-workflow>.
 */
function isNonRefName(refName: string): boolean {
  if (!refName || refName.startsWith("/") || refName.startsWith("~") || refName.startsWith("http")) return true;
  if (refName.length <= 1 || refName === "**") return true;
  if (refName.startsWith("<") || refName.includes("<")) return true;
  return false;
}

/**
 * Resolve a `(refType, refName)` pair against `allRoots`. Returns the resolved
 * stash-relative path when the ref is MISSING (no file under any root), or
 * `null` when it resolves, is a skipped/unresolvable type, or is a
 * non-ref-shaped name. The single existence check both grammars route through.
 */
function localRefMissingRelPath(refType: string, refName: string, allRoots: string[]): string | null {
  if (isNonRefName(refName)) return null;
  const relPath = refToRelPath(refType, refName);
  if (relPath === null) return null; // type is skipped / unresolvable
  return refExistsInAnyStash(relPath, refType, refName, allRoots) ? null : relPath;
}

/**
 * 0.9.0 grammar recognition: fully-qualified `bundle//conceptId` body-refs
 * (`BUNDLE_REF_RE`, the anchored prose form — spec §11.1 / ref-grammar decision
 * D-R3). The conceptId is reverse-translated to its legacy `type`/`name` via the
 * D-R2 static table (`typeNameFromConceptId`) so the SAME on-disk existence
 * check applies; a conceptId whose leading segment names no known stash-subdir
 * is not a local asset ref and is skipped (foreign-adapter / cross-bundle prose).
 */
function scanBundleRefs(scanBody: string, allRoots: string[]): Array<{ ref: string; resolvedRelPath: string }> {
  const missing: Array<{ ref: string; resolvedRelPath: string }> = [];
  const re = new RegExp(BUNDLE_REF_RE.source, BUNDLE_REF_RE.flags);
  let match: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic regex loop
  while ((match = re.exec(scanBody)) !== null) {
    const token = match[1]; // e.g. "core//memories/foo"
    if (token.includes("$(") || token.includes("${") || token.includes("::")) continue;
    const boundary = token.indexOf("//");
    if (boundary < 0) continue;
    const found = classifyConceptRef(token.slice(boundary + 2), allRoots);
    if (found !== null) missing.push({ ref: token, resolvedRelPath: found });
  }
  return missing;
}

/**
 * Map a bare 0.9.0 conceptId (`<stash-subdir>/<name>`, e.g. `memories/foo`) to
 * its legacy `type`/`name` and run the shared existence check. Returns the
 * missing relPath, or `null` when it resolves or is not a known local
 * asset-type prefix. Drops a trailing `#fragment` (export selector) before
 * mapping.
 */
function classifyConceptRef(rawConceptId: string, allRoots: string[]): string | null {
  const conceptId = rawConceptId.split("#", 1)[0];
  const legacy = typeNameFromConceptId(conceptId);
  if (legacy === undefined) return null; // foreign type / not a local asset ref
  return localRefMissingRelPath(legacy.type, legacy.name, allRoots);
}

/**
 * Returns an array of {ref, resolvedRelPath} for every local AKM ref in the
 * PROSE body that does not resolve to a real file under any of the provided
 * stash roots. Recognizes the 0.9.0 fully-qualified `bundle//conceptId` grammar
 * ({@link scanBundleRefs}). Bare short conceptIds are NOT refs in prose (D-R3) —
 * those are recognized only in the ref-list channels
 * ({@link checkMissingRefsInList}).
 */
function checkMissingRefs(
  body: string,
  stashRoot: string,
  extraStashRoots: string[] = [],
): Array<{ ref: string; resolvedRelPath: string }> {
  const allRoots = [stashRoot, ...extraStashRoots];
  // C1: Strip fenced code blocks so example refs inside ``` are not flagged.
  const scanBody = stripFencedBlocks(body);
  return dedupeMissing(scanBundleRefs(scanBody, allRoots));
}

/**
 * Missing-ref check for the REF-LIST channels (frontmatter `refs:` /
 * `xrefs:` / `supersededBy:` / `contradictedBy:`) where EACH value is a whole
 * ref, not prose. Unlike the body scan, a bare short conceptId (`memories/foo`)
 * IS a ref here (the value's whole purpose is to name one asset), so the flipped
 * short-conceptId frontmatter the 0.9.0 output emits is no longer invisible.
 * Recognizes, per value:
 *   - fully-qualified `bundle//conceptId`;
 *   - bare short `conceptId` (`<stash-subdir>/<name>`).
 */
function checkMissingRefsInList(
  values: string[],
  stashRoot: string,
  extraStashRoots: string[] = [],
): Array<{ ref: string; resolvedRelPath: string }> {
  const allRoots = [stashRoot, ...extraStashRoots];
  const missing: Array<{ ref: string; resolvedRelPath: string }> = [];
  for (const raw of values) {
    const value = raw.trim();
    if (!value || value.includes("$(") || value.includes("${") || value.includes("::")) continue;
    const boundary = value.indexOf("//");
    if (boundary >= 0) {
      // Qualified: `bundle//conceptId` (0.9.0). A colon in the tail marks a
      // legacy/remote `origin//type:name` — not the new grammar, so skip it.
      const tail = value.slice(boundary + 2);
      if (tail.includes(":")) continue;
      const rel = classifyConceptRef(tail, allRoots);
      if (rel !== null) missing.push({ ref: value, resolvedRelPath: rel });
      continue;
    }
    // Un-prefixed: a 0.9.0 short `conceptId`.
    const rel = classifyConceptRef(value, allRoots);
    if (rel !== null) missing.push({ ref: value, resolvedRelPath: rel });
  }
  return dedupeMissing(missing);
}

/** Dedupe missing-ref records by their `ref` token (both arms can flag one ref). */
function dedupeMissing(
  rows: Array<{ ref: string; resolvedRelPath: string }>,
): Array<{ ref: string; resolvedRelPath: string }> {
  const seen = new Set<string>();
  const out: Array<{ ref: string; resolvedRelPath: string }> = [];
  for (const row of rows) {
    if (seen.has(row.ref)) continue;
    seen.add(row.ref);
    out.push(row);
  }
  return out;
}

// ── frontmatter refs ─────────────────────────────────────────────────────────

/**
 * Frontmatter keys that carry cross-reference lists per the stash
 * organization conventions: `xrefs:` (provenance / associative links),
 * `supersededBy:` and `contradictedBy:` (belief-state correction links).
 * The missing-ref check validates each of these in ADDITION to the body /
 * `refs:` scan — they are the channel the conventions mandate, and a rename
 * would otherwise dangle them silently.
 *
 * `sources:` is deliberately excluded (non-wiki `sources:` was rejected as a
 * typed channel; wiki `sources:` is checked by lintWiki). `source_refs:` /
 * `evidenceSources:` are excluded too — they legitimately point at
 * merged-away or pruned assets (historical provenance).
 */
const XREF_FRONTMATTER_KEYS = ["xrefs", "supersededBy", "contradictedBy"] as const;

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
    // Session-checkpoint bodies are raw transcripts; ref-shaped tokens in the
    // body are literals (grep patterns, JSON, tool output), not live refs.
    // Return [] so missing-ref skips the body scan entirely.
    if (typeof innerData.akm_memory_kind === "string") return [];
  }
  // Same guard for outer frontmatter (e.g. opencode session files).
  if (typeof data.akm_memory_kind === "string") return [];
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
 * Like {@link readRefsArray} but also accepts a single scalar string,
 * normalizing it to a one-element list. The indexer's
 * `normalizeNonEmptyStringList` treats `supersededBy: memory:x` and
 * `supersededBy: [memory:x]` identically — both are live data — so the
 * frontmatter xref-channel check must validate both shapes; the array-only
 * reader silently skipped dangling scalar refs. Returns `null` for any other
 * type (missing key, number, object) and for a blank scalar.
 */
function readRefStringOrArray(value: unknown): string[] | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : null;
  }
  return readRefsArray(value);
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
   * Check for missing `name` or `type` fields in frontmatter.
   *
   * Returns a detail string if fields are absent/empty, `null` if all present.
   */
  protected checkMissingNameOrType(data: Record<string, unknown>, frontmatterText: string | null): string | null {
    if (!frontmatterText) return null;
    const missingFields: string[] = [];
    if (!("name" in data) || !data.name) missingFields.push("name");
    if (!("type" in data) || !data.type) missingFields.push("type");
    if (missingFields.length === 0) return null;
    return `missing fields: ${missingFields.join(", ")}`;
  }

  /**
   * Validate that the `type` field value is one of an allowed set.
   *
   * Returns a detail string if the value is present but invalid, `null` if valid or absent.
   */
  protected checkInvalidTypeValue(data: Record<string, unknown>, allowedTypes: readonly string[]): string | null {
    if (!("type" in data) || !data.type) return null; // absent — covered by checkMissingNameOrType
    const value = String(data.type);
    if (allowedTypes.includes(value)) return null;
    return `type field has invalid value '${value}'; expected one of: ${allowedTypes.join(", ")}`;
  }

  /**
   * Derive a URL-safe slug from a file path.
   */
  protected suggestSlug(filePath: string): string {
    return path
      .basename(filePath, ".md")
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
  }

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

    // M8: Parse lint_skip from frontmatter for per-file rule suppression.
    // Accept both an array (`lint_skip: [missing-ref, stale-path]`) and a
    // single scalar (`lint_skip: missing-ref`). Non-string entries are coerced
    // and trimmed so loosely-typed YAML still gates correctly.
    const rawLintSkip = ctx.data?.lint_skip;
    const lintSkip: string[] = (Array.isArray(rawLintSkip) ? rawLintSkip : rawLintSkip != null ? [rawLintSkip] : [])
      .map((v) => String(v).trim())
      .filter(Boolean);
    const shouldRun = (issueType: string) => !lintSkip.includes(issueType);

    // ── 1. unquoted-colon ──────────────────────────────────────────────────
    if (shouldRun("unquoted-colon")) {
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
    } // end shouldRun("unquoted-colon")

    // ── 2. missing-updated ─────────────────────────────────────────────────
    if (shouldRun("missing-updated") && checkMissingUpdated(ctx.data, ctx.frontmatter)) {
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
    // M3: checkStalePath returns all stale matches; push one issue per path.
    // M4: Also scan ctx.frontmatter for stale paths (absolute paths in frontmatter).
    if (shouldRun("stale-path")) {
      const staleInBody = checkStalePath(ctx.body);
      const staleInFrontmatter = ctx.frontmatter ? checkStalePath(ctx.frontmatter) : [];
      for (const candidate of [...staleInBody, ...staleInFrontmatter]) {
        // M4: Suggest portable replacement when path is under stashRoot.
        const portableHint = candidate.startsWith(ctx.stashRoot)
          ? ` (portable form: $AKM_STASH_DIR${candidate.slice(ctx.stashRoot.length)})`
          : "";
        issues.push({
          file: ctx.relPath,
          issue: "stale-path",
          detail: `nonexistent path: ${candidate}${portableHint}`,
          fixed: false,
        });
      }
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
    if (shouldRun("missing-ref")) {
      const explicitRefs = extractFrontmatterRefs(ctx.data, ctx.body);
      // An explicit `refs:` array is a REF LIST (each value is a whole ref —
      // short conceptIds included); a bare body is PROSE (anchored refs only).
      const missingRefs =
        explicitRefs !== null
          ? checkMissingRefsInList(explicitRefs, ctx.stashRoot, ctx.extraStashRoots)
          : checkMissingRefs(ctx.body, ctx.stashRoot, ctx.extraStashRoots);
      for (const { ref, resolvedRelPath } of missingRefs) {
        issues.push({
          file: ctx.relPath,
          issue: "missing-ref",
          detail: `missing ref: ${ref} (resolved to ${resolvedRelPath})`,
          fixed: false,
        });
      }

      // Frontmatter xref channels (xrefs / supersededBy / contradictedBy).
      // Runs regardless of the `refs:` body-scan carve-out above — that
      // carve-out governs only the BODY scan (`refs: []` declares "no
      // outbound refs in the body", not "skip my correction links").
      // Non-ref-shaped values (URLs, `raw/<slug>`, `<placeholder>`
      // templates, shell vars) fall out via checkMissingRefs' guards.
      //
      // Gate: runs when the file has a frontmatter block OR when an
      // authoritative `refs:` list was extracted. On the task/YAML path
      // (lint/index.ts) ctx.frontmatter is always null and the whole file
      // IS the body (`body === raw`); the top-level YAML keys land in
      // ctx.data. Without `refs:` the body scan above already catches ref
      // values under these keys, so running the pass would double-report —
      // skip it. With `refs:` present the body scan is suppressed
      // (refSource is the refs list), so this pass is the ONLY thing that
      // validates the xref keys — it must run or dangling task xrefs go
      // unreported. The two cases are mutually exclusive, so no ref is
      // ever double-reported. Md files without a frontmatter block and
      // without `refs:` land in the skip branch with empty ctx.data, so
      // nothing is lost for them either.
      if (ctx.frontmatter !== null || explicitRefs !== null) {
        for (const key of XREF_FRONTMATTER_KEYS) {
          const values = readRefStringOrArray(ctx.data?.[key]);
          if (values === null) continue;
          const missingXrefs = checkMissingRefsInList(values, ctx.stashRoot, ctx.extraStashRoots);
          for (const { ref, resolvedRelPath } of missingXrefs) {
            issues.push({
              file: ctx.relPath,
              issue: "missing-ref",
              detail: `missing ref: ${ref} (frontmatter ${key}; resolved to ${resolvedRelPath})`,
              fixed: false,
            });
          }
        }
      }
    }

    return issues;
  }
}
