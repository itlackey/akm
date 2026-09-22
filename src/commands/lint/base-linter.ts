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
// The lock is enforced by `tests/integration/contracts/ref-resolver-contract.test.ts`,
// which drives this implementation through a canonical fixture set. The
// akm-plugins repo ships an equivalent test that drives its copy through the
// SAME inputs and asserts identical outcomes. Any change to the resolver
// behavior on either side MUST update both contract tests in lockstep, or one
// will fail.
//
// Cases the contract covers (see fixture in the contract test):
//   - existing memory / knowledge / agent / workflow / skill refs
//   - namespaced knowledge paths (knowledge/<category>/<slug>.md)
//   - skill multi-file layout (skills/<slug>/SKILL.md)
//   - namespaced slugs containing `/`
//   - env (`env/.env`, `env/<name>.env`) and secret (`secrets/<name>`) refs
//   - non-existent refs
//   - script paths with explicit extensions
//
// As of 0.9 the path mapping in `refToRelPath` is DERIVED FROM THE PLACEMENT
// SPECS (`assetPathForName` in `src/core/asset/asset-placement.ts`) rather than
// hand-encoded, so it can no longer drift from the placement layer. `env`/
// `secret`, `script`, and `task` refs are path-resolved.
// ----------------------------------------------------------------------------

import fs from "node:fs";
import path from "node:path";
import { isScalar, parseDocument } from "yaml";
import { assetPathCandidatesForName, assetPathForName, stashDirFor } from "../../core/asset/asset-placement";
import { BUNDLE_REF_RE } from "../../core/asset/asset-ref";
import {
  removeFrontmatterListValues,
  rewriteFrontmatterListValue,
  spliceFrontmatterLine,
} from "../../core/asset/frontmatter";
import { checkUnquotedDescriptionColon } from "../../core/asset/frontmatter-lint";
import { isArchivedRelPath } from "../../core/asset/memory-archive";
import { conceptIdFromTypeName, typeNameFromConceptId } from "../../core/asset/resolve-ref";
import { localDateStamp } from "../../core/common";
import { containsRedactedContent, REDACTED_CONTENT_MARKER } from "../../core/content-safety";
import { findFenceRegions } from "./markdown-insertion";
import type { LintContext, LintIssue } from "./types";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Fold physically wrapped prose the same way a YAML plain scalar does. */
function foldDescriptionLines(lines: string[]): string {
  let value = "";
  let blankLines = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      blankLines++;
      continue;
    }
    if (value) value += blankLines > 0 ? "\n".repeat(blankLines) : " ";
    value += trimmed;
    blankLines = 0;
  }
  return value;
}

/**
 * Recover a description from malformed wrapped YAML.
 *
 * Older producers emitted a valid quoted first physical line followed by
 * indented prose outside the quote. The full document cannot be parsed, but
 * the first line can still be decoded independently and the continuation can
 * be folded without guessing at escape sequences in that first segment.
 */
function recoverMalformedDescription(firstSegment: string, continuation: string[]): string | null {
  const firstLine = parseDocument(`description: ${firstSegment}`);
  const firstValue = firstLine.get("description", true);
  const decodedFirst =
    firstLine.errors.length === 0 && isScalar(firstValue) && typeof firstValue.value === "string"
      ? firstValue.value
      : firstSegment.trim();
  const value = foldDescriptionLines([decodedFirst, ...continuation]);
  return value || null;
}

/**
 * Quote the complete description scalar, including physical continuation
 * lines, and verify that the replacement is valid YAML before returning it.
 */
function fixUnquotedColon(raw: string): string | null {
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const lines = raw.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return null;
  const closeIdx = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  if (closeIdx === -1) return null;
  for (let i = 1; i < closeIdx; i++) {
    const m = lines[i]?.match(/^(description:\s*)(.*)/);
    if (!m) continue;
    const [, prefix, firstSegment] = m;
    if (prefix === undefined || firstSegment === undefined) continue;

    let continuationEnd = i + 1;
    while (continuationEnd < closeIdx) {
      const continuationLine = lines[continuationEnd];
      if (continuationLine === undefined || (!/^[ \t]/.test(continuationLine) && continuationLine.trim())) break;
      continuationEnd++;
    }

    const frontmatter = lines.slice(1, closeIdx).join("\n");
    const document = parseDocument(frontmatter);
    const description = document.get("description", true);
    const value =
      document.errors.length === 0 && isScalar(description) && typeof description.value === "string"
        ? description.value
        : recoverMalformedDescription(firstSegment.trim(), lines.slice(i + 1, continuationEnd));
    if (value === null) return null;

    lines.splice(i, continuationEnd - i, `${prefix}${JSON.stringify(value)}`);
    const candidate = lines.join(eol);
    const candidateCloseIdx = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
    const candidateDocument = parseDocument(lines.slice(1, candidateCloseIdx).join("\n"));
    const candidateDescription = candidateDocument.get("description", true);
    if (
      candidateDocument.errors.length > 0 ||
      !isScalar(candidateDescription) ||
      candidateDescription.value !== value
    ) {
      return null;
    }
    return candidate;
  }
  return null;
}

function checkMissingUpdated(data: Record<string, unknown>, frontmatterText: string | null): boolean {
  return frontmatterText !== null && !("updated" in data);
}

function fixMissingUpdated(raw: string, mtime: Date): string {
  return spliceFrontmatterLine(raw, `updated: ${localDateStamp(mtime)}`) ?? raw;
}

// ── stale-path helpers ────────────────────────────────────────────────────────

/**
 * A path segment shaped like a run-time filename template rather than a
 * literal reference: `<timestamp>`-style angle brackets, `{stamp}`/`${VAR}`
 * braces, a `YYYYMMDD`/`HHMMSS`-style run of date-format letters, or a glob
 * character. Such a path never exists under its literal spelling, so
 * `stale-path` skips it instead of flagging it.
 */
const PATH_PLACEHOLDER_PATTERN = /[<{]|[*?]|[YMDHS]{4,}/;

function checkStalePath(body: string): string[] {
  const pathRe = /(?:\/home\/|\/tmp\/|\/var\/|\/root\/|\/opt\/)[^\s"'`)\]>,\n]+/g;
  let match: RegExpExecArray | null;
  const stale: string[] = [];
  // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic regex loop
  while ((match = pathRe.exec(body)) !== null) {
    const candidate = match[0];
    if (PATH_PLACEHOLDER_PATTERN.test(candidate)) continue;
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
 * Map from ref type to relative path pattern within stashRoot. Returns null to
 * skip (type is unresolvable by the slug walker).
 *
 * Path layout is owned by the placement layer: we resolve through
 * `assetPathForName(type, stashDirFor(type), name)` so the linter and the
 * rest of the CLI agree on where an asset lives.
 *
 * Exported for contract testing — see header CONTRACT block.
 */
export function refToRelPath(refType: string, refName: string): string | null {
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
  // #884: a memory pruned by `analyzeMemoryCleanup` was ARCHIVED, not deleted —
  // its bytes and identity live on under `.akm/memory-cleanup/archive`. Inbound
  // belief edges to it are satisfied, not dangling, so resolve the tombstone
  // rather than reporting `missing-ref`. Checked only after every live location
  // misses: a tombstone must never shadow a real file, and the scan then costs
  // one directory read per root instead of one per ref.
  //
  // Existence ONLY. `resolveRefPathInStash` deliberately does NOT consult the
  // archive: it hands back a path callers MUTATE (SPEC-5 `--supersedes`
  // demotion), and writing into an archived tombstone would corrupt the audit
  // record while leaving the live stash untouched.
  return memoryArchiveHasRef(refType, refName, stashRoots);
}

/**
 * True when `(refType, refName)` names a memory that prune archived in any
 * root. Mirrors `resolveRefPathInStash`'s candidate set so a ref that resolved
 * through the `.derived.md` twin (#882) still resolves once archived.
 */
function memoryArchiveHasRef(refType: string, refName: string, stashRoots: string[]): boolean {
  if (refType !== "memory") return false; // only memories are ever archived
  const typeDir = stashDirFor(refType);
  if (typeDir === undefined) return false;
  const candidates = assetPathCandidatesForName(refType, typeDir, refName);
  for (const root of stashRoots) {
    for (const candidate of candidates) {
      if (isArchivedRelPath(candidate, root)) return true;
    }
  }
  return false;
}

/**
 * Resolve the on-disk primary file for a ref within a SINGLE stash root, using
 * the same reachability rules (in the same order) as
 * {@link refExistsInAnyStash}, which delegates here. Returns the absolute path
 * of the file that makes the ref "exist" — for a multi-file skill directory
 * that is its `SKILL.md` primary, for a `memory` ref its `.derived.md` twin
 * when the plain `.md` is absent (#882, see `assetPathCandidatesForName`) —
 * or `null` when the ref does not resolve in this root.
 *
 * Extracted for SPEC-5 (`--supersedes` demotion): write commands need the
 * superseded asset's actual file to mutate, and forking a second resolver
 * would drift from lint's. NOT part of the akm-plugins ref-resolver contract
 * (the contract pins `refToRelPath` + `refExistsInAnyStash`; this is the
 * shared internal both build on).
 */
export function resolveRefPathInStash(relPath: string, refType: string, refName: string, root: string): string | null {
  const typeDir = stashDirFor(refType);
  const candidates = typeDir === undefined ? [relPath] : assetPathCandidatesForName(refType, typeDir, refName);
  for (const candidate of candidates) {
    const absPath = path.join(root, candidate);
    if (fs.existsSync(absPath)) return absPath;
  }
  return null;
}

/**
 * A `(refType, refName)` pair that is not a lint-checkable local asset ref —
 * shared skip-guard for recognized `bundle//conceptId` refs. Filters the
 * false-positive patterns:
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
    const token = match[1]!; // e.g. "core//memories/foo"
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
  const conceptId = rawConceptId.split("#", 1)[0]!;
  const parts = typeNameFromConceptId(conceptId) ?? legacyTypeSlugParts(conceptId);
  if (parts === undefined) return null; // foreign type / not a local asset ref
  return localRefMissingRelPath(parts.type, parts.name, allRoots);
}

/**
 * Read-only fallback for the retired `type:slug` xref grammar (see
 * resolve-ref.ts Q-02 — the write boundary no longer emits or accepts it).
 * Stash content written before that retirement still carries it in frontmatter
 * `xrefs:` lists, and `typeNameFromConceptId` (conceptId-only) returns
 * `undefined` for it, so without this it was silently skipped rather than
 * validated (#882). `refToRelPath`/`refExistsInAnyStash` already key off a bare
 * `(type, slug)` pair — the same shape `type:slug` already is — so this only
 * needs to split the token; no new resolution logic.
 */
function legacyTypeSlugParts(rawConceptId: string): { type: string; name: string } | undefined {
  const colon = rawConceptId.indexOf(":");
  if (colon <= 0) return undefined;
  const type = rawConceptId.slice(0, colon);
  const name = rawConceptId.slice(colon + 1);
  if (!name || name.includes("/") || name.includes(":")) return undefined;
  return stashDirFor(type) === undefined ? undefined : { type, name };
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
    // Un-prefixed: a 0.9.0 short `conceptId`. (Post-Chunk-8 the durable
    // frontmatter xref channel is conceptId-spelled — the legacy `type:name`
    // ref-list arm is retired.)
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
 * typed channel; wiki `sources:` is checked by lintWiki). `evidenceSources:` is
 * excluded because it can point at merged-away or pruned assets.
 */
const XREF_FRONTMATTER_KEYS = ["xrefs", "supersededBy", "contradictedBy"] as const;

/**
 * The belief-graph subset of {@link XREF_FRONTMATTER_KEYS} — the only channels
 * `--prune-dangling-edges` will repair (#884). Typed as `readonly string[]` so
 * `.includes` accepts any xref key without a cast.
 */
const BELIEF_EDGE_KEYS: readonly string[] = ["supersededBy", "contradictedBy"];

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
  while (i < lines.length && i < 3 && lines[i]!.trim() === "") i += 1;
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
      currentList.push(listItem[1]!.trim().replace(/^["'](.*)["']$/, "$1"));
      continue;
    }
    const inlineFlow = line.match(/^(\w[\w-]*):\s*\[(.*)\]\s*$/);
    if (inlineFlow) {
      currentKey = inlineFlow[1]!;
      const items = inlineFlow[2]!
        .split(",")
        .map((s) => s.trim().replace(/^["'](.*)["']$/, "$1"))
        .filter(Boolean);
      data[currentKey] = items;
      currentList = null;
      continue;
    }
    const kv = line.match(/^(\w[\w-]*):\s*(.*)$/);
    if (!kv) continue;
    currentKey = kv[1]!;
    const value = kv[2]!.trim();
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

// ── Base checks ─────────────────────────────────────────────────────────────

/**
 * The cross-type checks every asset linter runs first: `unquoted-colon`,
 * `missing-updated`, `stale-path`, and `missing-ref`.
 *
 * akm 0.9.0 chunk-3 (plan §12): this was the `BaseLinter.runBaseChecks`
 * protected method every per-type linter class inherited. Those classes are
 * gone — the format-generic checks live here as ONE shared function (this), and
 * the per-`type` extra rules moved to the `akm` adapter's `validate`
 * (`core/adapter/adapters/akm-lint.ts`). The live `akmLint` command
 * (`commands/lint/index.ts`) calls this directly, then appends the adapter's
 * per-type findings.
 *
 * File mutations triggered by the fixable base checks (`unquoted-colon`,
 * `missing-updated`) are flushed to disk here when `ctx.fix` is set, and
 * `ctx.raw` is updated in place so a caller can re-parse the post-fix content.
 * A failed flush (read-only file, full disk) DOWNGRADES the optimistic
 * `fixed: true` findings this call made to `fixed: "failed"` rather than
 * throwing — an uncaught throw here used to kill the whole sweep and hide
 * which earlier files had already been rewritten (issue #761).
 */
export function runBaseChecks(ctx: LintContext): LintIssue[] {
  const issues: LintIssue[] = [];
  let currentRaw = ctx.raw;
  let modified = false;
  /** Findings whose `fixed: true` is only true once the flush below succeeds. */
  const pendingFixes: LintIssue[] = [];

  // M8: Parse lint_skip from frontmatter for per-file rule suppression.
  // Accept both an array (`lint_skip: [missing-ref, stale-path]`) and a
  // single scalar (`lint_skip: missing-ref`). Non-string entries are coerced
  // and trimmed so loosely-typed YAML still gates correctly.
  const rawLintSkip = ctx.data?.lint_skip;
  const lintSkip: string[] = (Array.isArray(rawLintSkip) ? rawLintSkip : rawLintSkip != null ? [rawLintSkip] : [])
    .map((v) => String(v).trim())
    .filter(Boolean);
  const shouldRun = (issueType: string) => !lintSkip.includes(issueType);

  if (shouldRun("redacted-content") && containsRedactedContent(currentRaw)) {
    issues.push({
      file: ctx.relPath,
      issue: "redacted-content",
      detail: `asset contains ${REDACTED_CONTENT_MARKER}; restore the original non-secret prose from version history`,
      fixed: false,
    });
  }

  // ── 1. unquoted-colon ──────────────────────────────────────────────────
  if (shouldRun("unquoted-colon")) {
    const unquotedColonDetail = checkUnquotedDescriptionColon(ctx.frontmatter);
    if (unquotedColonDetail) {
      if (ctx.fix) {
        const fixedRaw = fixUnquotedColon(currentRaw);
        if (fixedRaw === null) {
          issues.push({
            file: ctx.relPath,
            issue: "unquoted-colon",
            detail: `${unquotedColonDetail} — could not construct a valid YAML replacement`,
            fixed: "failed",
          });
        } else {
          currentRaw = fixedRaw;
          modified = true;
          const issue: LintIssue = {
            file: ctx.relPath,
            issue: "unquoted-colon",
            detail: unquotedColonDetail,
            fixed: true,
          };
          issues.push(issue);
          pendingFixes.push(issue);
        }
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
      const issue: LintIssue = {
        file: ctx.relPath,
        issue: "missing-updated",
        detail: `stamped updated: ${localDateStamp(mtime)}`,
        fixed: true,
      };
      issues.push(issue);
      pendingFixes.push(issue);
    } else {
      issues.push({
        file: ctx.relPath,
        issue: "missing-updated",
        detail: "no updated field in frontmatter",
        fixed: false,
      });
    }
  }

  /**
   * Flush accumulated mutations to disk. Called after the fixable checks above
   * AND again at the very end, because the `missing-ref` section below can also
   * mutate (`--prune-dangling-edges`, #884) and used to run PAST this point —
   * its edits were computed and then silently dropped.
   *
   * Mirrors the two stub-delete call sites in `commands/lint/index.ts`
   * (`appendMemoryStubIssue`/`appendWorkflowStubIssue`), which already report
   * a failed mutation as `fixed: "failed"` instead of throwing. Without this
   * the sweep aborted mid-run on the first unwritable file and the caller got
   * an exception instead of a result naming the fixes that HAD landed.
   */
  const flushIfModified = (): void => {
    if (!modified) return;
    modified = false;
    try {
      fs.writeFileSync(ctx.filePath, currentRaw, "utf8");
      // Propagate the mutated raw back so subclasses can re-parse if needed
      ctx.raw = currentRaw;
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      for (const issue of pendingFixes) {
        issue.fixed = "failed";
        issue.detail = `${issue.detail} — could not write fix: ${reason}`;
      }
    }
  };

  flushIfModified();

  // ── 3. stale-path ──────────────────────────────────────────────────────
  // M3: checkStalePath returns all stale matches; push one issue per path.
  // M4: Also scan ctx.frontmatter for stale paths (absolute paths in frontmatter).
  if (shouldRun("stale-path")) {
    const staleInBody = checkStalePath(ctx.body);
    const staleInFrontmatter = ctx.frontmatter ? checkStalePath(ctx.frontmatter) : [];
    for (const candidate of [...staleInBody, ...staleInFrontmatter]) {
      // M4: Suggest portable replacement when path is under stashRoot.
      const portableHint = candidate.startsWith(ctx.stashRoot)
        ? ` (portable form: $AKM_BUNDLE_DIR${candidate.slice(ctx.stashRoot.length)})`
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
  const missingRefPass = runMissingRefChecks(ctx, currentRaw, shouldRun, pendingFixes);
  issues.push(...missingRefPass.issues);
  if (missingRefPass.modified) {
    currentRaw = missingRefPass.raw;
    modified = true;
  }

  flushIfModified();

  return issues;
}

/**
 * The `missing-ref` pass, extracted from {@link runBaseChecks} so that function
 * stays under the src fn-size ratchet after #884 gave this pass its own
 * (opt-in) mutation path. Pure move plus the explicit state hand-off: `raw` in,
 * `{raw, modified}` out, `issues`/`pendingFixes` appended in place.
 */
function runMissingRefChecks(
  ctx: LintContext,
  raw: string,
  shouldRun: (issueType: string) => boolean,
  pendingFixes: LintIssue[],
): { issues: LintIssue[]; raw: string; modified: boolean } {
  const issues: LintIssue[] = [];
  let currentRaw = raw;
  let modified = false;
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
  if (!shouldRun("missing-ref")) return { issues, raw, modified };
  {
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

        // `lint --fix` migration for the retired `type:slug` xref grammar
        // (see legacyTypeSlugParts): rewrite a value to its conceptId form
        // ONLY when the rewritten spelling still resolves to a real asset —
        // a dangling legacy ref must stay reported as `missing-ref` in its
        // original spelling, never rewritten into a differently-spelled
        // dangling ref. Runs before the missing-ref scan below so a value
        // this loop rewrites is checked (and reported, if still dangling)
        // under its ORIGINAL spelling by that scan, and never double-fixed.
        if (ctx.fix) {
          const legacyRewrites = new Map<string, string>();
          for (const raw of values) {
            const value = raw.trim();
            const parts = legacyTypeSlugParts(value);
            if (parts === undefined) continue;
            const relPath = refToRelPath(parts.type, parts.name);
            if (relPath === null) continue;
            if (!refExistsInAnyStash(relPath, parts.type, parts.name, [ctx.stashRoot, ...(ctx.extraStashRoots ?? [])]))
              continue; // dangling — leave reported as missing-ref, unrewritten
            legacyRewrites.set(value, conceptIdFromTypeName(parts.type, parts.name));
          }
          if (legacyRewrites.size > 0) {
            const rewritten = rewriteFrontmatterListValue(currentRaw, key, legacyRewrites);
            if (rewritten !== null) {
              currentRaw = rewritten;
              modified = true;
              for (const [oldValue, newValue] of legacyRewrites) {
                const issue: LintIssue = {
                  file: ctx.relPath,
                  issue: "missing-ref",
                  detail: `legacy xref grammar migrated: ${key} ${oldValue} -> ${newValue}`,
                  fixed: true,
                };
                issues.push(issue);
                pendingFixes.push(issue);
              }
            }
          }
        }

        const missingXrefs = checkMissingRefsInList(values, ctx.stashRoot, ctx.extraStashRoots);

        // #884 opt-in repair. Scoped to the BELIEF channels only: an edge whose
        // target has neither a file nor a prune tombstone asserts a
        // relationship to a memory that no longer exists in any form, and
        // carrying it forward corrupts every belief-graph read. `xrefs` is
        // excluded — a stale xref is an ordinary broken link (the 3 skill refs
        // in #884), and repairing it by DELETION would throw away a pointer the
        // author may simply need to re-target.
        const repairable = ctx.pruneDanglingEdges === true && BELIEF_EDGE_KEYS.includes(key) && missingXrefs.length > 0;
        if (repairable) {
          const dropped = missingXrefs.map(({ ref }) => ref);
          const rewritten = removeFrontmatterListValues(currentRaw, key, dropped);
          if (rewritten !== null) {
            currentRaw = rewritten;
            modified = true;
            for (const { ref, resolvedRelPath } of missingXrefs) {
              const issue: LintIssue = {
                file: ctx.relPath,
                issue: "missing-ref",
                detail: `dangling ${key} edge dropped: ${ref} (no file and no prune tombstone at ${resolvedRelPath})`,
                fixed: true,
              };
              issues.push(issue);
              pendingFixes.push(issue);
            }
            continue;
          }
        }

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
  return { issues, raw: currentRaw, modified };
}
