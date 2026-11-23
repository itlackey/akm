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
//   - namespaced knowledge paths (knowledge/<category>/<slug>.md)
//   - skill multi-file layout (skills/<slug>/SKILL.md)
//   - namespaced slugs containing `/`
//   - env (`env/.env`, `env/<name>.env`) and secret (`secrets/<name>`) refs
//   - non-existent refs
//   - script paths with explicit extensions
//
// The path mapping in `refToRelPath` is DERIVED FROM THE PLACEMENT
// SPECS (`assetPathForName` in `src/core/asset/asset-placement.ts`) rather than
// hand-encoded, so it cannot drift from the placement layer. `env`/
// `secret`, `script`, and `task` refs are path-resolved.
// ----------------------------------------------------------------------------

import fs from "node:fs";
import path from "node:path";
import { isScalar, parseDocument } from "yaml";
import {
  assetPathCandidatesForName,
  assetPathForName,
  filesForRef,
  stashDirFor,
  stashDirNames,
} from "../../core/asset/asset-placement";
import { BUNDLE_REF_RE } from "../../core/asset/asset-ref";
import {
  removeFrontmatterListValues,
  rewriteFrontmatterListValue,
  spliceFrontmatterLine,
} from "../../core/asset/frontmatter";
import { checkUnquotedDescriptionColon } from "../../core/asset/frontmatter-lint";
import { ruleApplies } from "../../core/asset/lint-text";
import { isArchivedRelPath } from "../../core/asset/memory-archive";
import { conceptIdFromTypeName } from "../../core/asset/resolve-ref";
import { findStalePaths } from "../../core/asset/stale-path";
import { localDateStamp } from "../../core/common";
import { containsRedactedContent, REDACTED_CONTENT_MARKER } from "../../core/content-safety";
import { DERIVED_SUFFIX } from "../../core/recognition-util";
import { DECLARED_REF_FRONTMATTER_KEYS, declaredLinkTarget } from "../../indexer/links/declared-links";
import { findFenceRegions } from "./markdown-insertion";
import { rewriteMovedLinks } from "./moved-refs";
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

function fixMissingUpdated(raw: string, mtime: Date): string {
  return spliceFrontmatterLine(raw, `updated: ${localDateStamp(mtime)}`) ?? raw;
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

/**
 * `raw` without fenced and indented code blocks, table rows, inline code spans,
 * double-quoted text and blockquote lines: places where `[REDACTED]` is
 * documented or quoted as an example rather than left behind by damaged content.
 */
function stripQuotedExamples(raw: string): string {
  let inIndentedCode = true; // an indented line starts a code block at the top or after a blank line
  return stripFencedBlocks(raw)
    .split("\n")
    .filter((line) => {
      const blank = line.trim() === "";
      const indented = /^(?: {4}|\t)/.test(line);
      const code = indented && inIndentedCode;
      inIndentedCode = blank || code;
      return !code && !/^\s*[>|]/.test(line);
    })
    .join("\n")
    .replace(/`[^`\n]*`|"[^"\n]*"|\u201c[^\u201d\n]*\u201d/g, "");
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
  // #884: an asset `analyzeMemoryCleanup` pruned, or a consolidate
  // pair-pass `retire` proposal or a promotion's source memory retired, was
  // ARCHIVED, not deleted — its bytes and identity live on under
  // `.akm/memory-cleanup/archive`. Inbound refs to it are satisfied, not
  // dangling, so resolve the tombstone rather than reporting `missing-ref`.
  // Checked only after every live location misses: a tombstone must never
  // shadow a real file, and the scan then costs one directory read per root
  // instead of one per ref.
  //
  // Existence ONLY. `resolveRefPathInStash` deliberately does NOT consult the
  // archive: it hands back a path callers MUTATE (SPEC-5 `--supersedes`
  // demotion), and writing into an archived tombstone would corrupt the audit
  // record while leaving the live stash untouched.
  return memoryArchiveHasRef(refType, refName, stashRoots);
}

/**
 * The stash-relative files that satisfy a ref, in preference order: its own
 * placement spellings, then, for a memory, the `<name>.derived.md` child (#882),
 * so an edge to a parent whose plain `.md` is gone still reaches the child it was
 * distilled into. This is lint's reachability rule only; the child owns
 * `memories/<name>.derived`, never `memories/<name>`.
 */
function refPathCandidates(refType: string, typeDir: string, refName: string): string[] {
  const candidates = assetPathCandidatesForName(refType, typeDir, refName);
  if (refType !== "memory" || refName.endsWith(DERIVED_SUFFIX)) return candidates;
  return [...candidates, assetPathForName(refType, typeDir, `${refName}${DERIVED_SUFFIX}`)];
}

/**
 * True when `(refType, refName)` names an asset the cleanup archive holds a
 * tombstone for, in any root. Mirrors `resolveRefPathInStash`'s candidate set
 * so a memory ref that resolved through the `.derived.md` child (#882) still
 * resolves once archived.
 *
 * Originally memory-only (#884: only `.derived` memories were ever pruned).
 * `archiveCleanupCandidate` also archives any memory, knowledge or lesson file (a consolidate pair-pass `retire` proposal, or an
 * accepted promotion's source memory), so this must check every type, not
 * just `memory` — otherwise an xref to a retired knowledge or lesson asset
 * reports `missing-ref` even though it resolves fine through the tombstone.
 */
function memoryArchiveHasRef(refType: string, refName: string, stashRoots: string[]): boolean {
  const typeDir = stashDirFor(refType);
  if (typeDir === undefined) return false;
  const candidates = refPathCandidates(refType, typeDir, refName);
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
 * that is its `SKILL.md` primary, for a `memory` ref its `.derived.md` child
 * when the plain `.md` is absent (#882, see {@link refPathCandidates}) —
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
  const candidates = typeDir === undefined ? [relPath] : refPathCandidates(refType, typeDir, refName);
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
 * Grammar recognition: fully-qualified `bundle//conceptId` body-refs
 * (`BUNDLE_REF_RE`, the anchored prose form). The conceptId is
 * is checked on disk by {@link classifyConceptRef}; a conceptId whose leading
 * segment names no known stash-subdir is not a local asset ref and is skipped (foreign-adapter / cross-bundle prose).
 */
function scanBundleRefs(
  scanBody: string,
  allRoots: string[],
  movedConcepts: MovedConcepts,
  bundleRoots: ReadonlyMap<string, string>,
): Array<{ ref: string; resolvedRelPath: string }> {
  const missing: Array<{ ref: string; resolvedRelPath: string }> = [];
  const re = new RegExp(BUNDLE_REF_RE.source, BUNDLE_REF_RE.flags);
  let match: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic regex loop
  while ((match = re.exec(scanBody)) !== null) {
    const token = match[1]!; // e.g. "core//memories/foo"
    if (token.includes("$(") || token.includes("${") || token.includes("::")) continue;
    const boundary = token.indexOf("//");
    if (boundary < 0) continue;
    const found = classifyConceptRef(
      token.slice(boundary + 2),
      rootsOfBundle(token.slice(0, boundary), allRoots, bundleRoots),
      movedConcepts,
    );
    if (found !== null) missing.push({ ref: token, resolvedRelPath: found });
  }
  return missing;
}

/** The concept ids some recorded move left; asked only of a ref that did not resolve. */
type MovedConcepts = { has(concept: string): boolean };

const NO_CONCEPTS: MovedConcepts = new Set<string>();
const NO_BUNDLES: ReadonlyMap<string, string> = new Map();

/** A qualified ref is checked in the bundle it names; a bundle the config does not name is checked as an unqualified ref is. */
function rootsOfBundle(bundle: string, allRoots: string[], bundleRoots: ReadonlyMap<string, string>): string[] {
  const root = bundleRoots.get(bundle);
  return root === undefined ? allRoots : [root];
}

/**
 * Run the existence check for a bare conceptId. Returns the missing relPath, or
 * `null` when it resolves or does not read as a local asset ref. A ref is the
 * file's path inside its bundle minus the type's suffix, so any placement spec's
 * spelling of it satisfies it, and so does the type-folder-prefixed spelling
 * earlier releases wrote for a loose file. A conceptId that does not lead with a
 * stash folder is foreign-adapter / cross-bundle prose and is skipped. Drops a
 * trailing `#fragment` (export selector) before mapping.
 */
function classifyConceptRef(
  rawConceptId: string,
  allRoots: string[],
  movedConcepts: MovedConcepts = NO_CONCEPTS,
  declared = false,
): string | null {
  const conceptId = rawConceptId.split("#", 1)[0]!;
  const legacy = legacyTypeSlugParts(conceptId);
  if (legacy !== undefined) return localRefMissingRelPath(legacy.type, legacy.name, allRoots);
  const slash = conceptId.indexOf("/");
  if (slash <= 0 || !stashDirNames().includes(conceptId.slice(0, slash))) {
    // What an asset declares as a ref is one wherever it points: it must exist as a file of that concept id.
    if (declared) {
      const files = [`${conceptId}.md`, ...filesForRef("", conceptId)];
      const found = allRoots.some((root) =>
        files.some((file) => fs.existsSync(path.join(root, file)) || isArchivedRelPath(file, root)),
      );
      return found ? null : `${conceptId}.md`;
    }
    // A path ref outside the type folders is checked only when the index recorded a move away from it.
    const gone =
      !allRoots.some((root) => fs.existsSync(path.join(root, `${conceptId}.md`))) && movedConcepts.has(conceptId);
    return gone ? `${conceptId}.md` : null;
  }
  if (isNonRefName(conceptId.slice(slash + 1))) return null;
  const spellings = [conceptId, conceptId.slice(slash + 1)];
  // A memory's `<name>.derived.md` child also reaches an edge to its parent (#882).
  const candidates = spellings.flatMap((id) => [
    ...filesForRef("", id),
    ...(id.endsWith(DERIVED_SUFFIX) ? [] : filesForRef("", `${id}${DERIVED_SUFFIX}`)),
  ]);
  for (const root of allRoots) {
    for (const candidate of candidates) {
      if (fs.existsSync(path.join(root, candidate)) || isArchivedRelPath(candidate, root)) return null;
    }
  }
  return `${conceptId}.md`;
}

/**
 * Read-only fallback for the retired `type:slug` xref grammar (see
 * resolve-ref.ts — the write boundary neither emits nor accepts it).
 * Older stash content may still carry it in frontmatter
 * `xrefs:` lists, and the conceptId check returns
 * `null` for it, so without this it was silently skipped rather than
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
 * stash roots. Recognizes the fully-qualified `bundle//conceptId` grammar
 * ({@link scanBundleRefs}). Bare short conceptIds are NOT refs in prose (D-R3) —
 * those are recognized only in the ref-list channels
 * ({@link checkMissingRefsInList}).
 */
function checkMissingRefs(
  body: string,
  stashRoot: string,
  extraStashRoots: string[] = [],
  movedConcepts: MovedConcepts = NO_CONCEPTS,
  bundleRoots: ReadonlyMap<string, string> = NO_BUNDLES,
): Array<{ ref: string; resolvedRelPath: string }> {
  const allRoots = [stashRoot, ...extraStashRoots];
  // C1: Strip fenced code blocks so example refs inside ``` are not flagged.
  const scanBody = stripFencedBlocks(body);
  return dedupeMissing(scanBundleRefs(scanBody, allRoots, movedConcepts, bundleRoots));
}

/**
 * Missing-ref check for the REF-LIST channels (frontmatter `refs:` /
 * `xrefs:` / `supersededBy:` / `contradictedBy:`) where EACH value is a whole
 * ref, not prose. Unlike the body scan, a bare short conceptId (`memories/foo`)
 * IS a ref here (the value's whole purpose is to name one asset), so the flipped
 * short-conceptId frontmatter the current output emits is no longer invisible.
 * Recognizes, per value:
 *   - fully-qualified `bundle//conceptId`;
 *   - bare short `conceptId` (`<stash-subdir>/<name>`).
 */
function checkMissingRefsInList(
  values: string[],
  ownerRelPath: string,
  stashRoot: string,
  extraStashRoots: string[] = [],
  movedConcepts: MovedConcepts = NO_CONCEPTS,
  bundleRoots: ReadonlyMap<string, string> = NO_BUNDLES,
): Array<{ ref: string; resolvedRelPath: string }> {
  const allRoots = [stashRoot, ...extraStashRoots];
  const missing: Array<{ ref: string; resolvedRelPath: string }> = [];
  for (const raw of values) {
    const value = raw.trim();
    if (!value || value.includes("$(") || value.includes("${") || value.includes("::")) continue;
    const boundary = value.indexOf("//");
    // A colon in the tail of a qualified value marks a legacy/remote `origin//type:name`, not the grammar.
    if (boundary >= 0 && value.slice(boundary + 2).includes(":")) continue;
    // The retired `type:slug` spelling is read as it always was; every other value is a ref as the index reads it.
    const target: { bundle?: string; conceptId: string } | undefined =
      boundary < 0 && legacyTypeSlugParts(value) !== undefined
        ? { conceptId: value }
        : declaredLinkTarget(value, ownerRelPath.replace(/\\/g, "/").replace(/\.md$/i, ""));
    if (target === undefined) continue;
    const rel = classifyConceptRef(
      target.conceptId,
      target.bundle === undefined ? allRoots : rootsOfBundle(target.bundle, allRoots, bundleRoots),
      movedConcepts,
      true,
    );
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
 * The belief-graph subset of {@link DECLARED_REF_FRONTMATTER_KEYS} — the only channels
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
 * The format-generic checks live here as ONE shared function, and the
 * per-`type` extra rules live in the `akm` adapter's `validate`
 * (`core/adapter/adapters/akm-lint.ts`). The `akmLint` command
 * (`commands/lint/index.ts`) calls this directly, then appends the adapter's
 * per-type findings.
 *
 * File mutations triggered by the fixable base checks (`unquoted-colon`,
 * `missing-updated`) are flushed to disk here when `ctx.fix` is set, and
 * `ctx.raw` is updated in place so a caller can re-parse the post-fix content.
 * A failed flush (read-only file, full disk) DOWNGRADES the optimistic
 * `fixed: true` findings this call made to `fixed: "failed"` rather than
 * throwing — an uncaught throw here would kill the whole sweep and hide
 * which earlier files had already been rewritten.
 */
export function runBaseChecks(ctx: LintContext): LintIssue[] {
  const issues: LintIssue[] = [];
  let currentRaw = ctx.raw;
  let modified = false;
  /** Findings whose `fixed: true` is only true once the flush below succeeds. */
  const pendingFixes: LintIssue[] = [];

  const shouldRun = (rule: string) =>
    ruleApplies(rule, { relPath: ctx.relPath, llmWiki: ctx.llmWiki, skip: ctx.lintSkip });

  if (shouldRun("redacted-content") && containsRedactedContent(stripQuotedExamples(currentRaw))) {
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
  if (shouldRun("missing-updated") && ctx.frontmatter !== null && !("updated" in ctx.data)) {
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
   * mutate (`--prune-dangling-edges`, #884) and runs after the first flush —
   * its edits must not be silently dropped.
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
  if (shouldRun("stale-path")) {
    const { frontmatter, body, bodyStartLine } = ctx;
    const stale = [
      ...(frontmatter ? findStalePaths(frontmatter, 2, ctx.stalePathRoots, ctx.stashRoot) : []),
      ...findStalePaths(body, bodyStartLine, ctx.stalePathRoots, ctx.stashRoot),
    ];
    for (const { detail, ...finding } of stale) {
      issues.push({ file: ctx.relPath, issue: "stale-path", detail, fixed: false, ...finding });
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
  const allRoots = [ctx.stashRoot, ...(ctx.extraStashRoots ?? [])];
  const moves = ctx.moves;
  const movedConcepts: MovedConcepts = moves ? { has: (concept) => moves.concepts.has(concept) } : NO_CONCEPTS;
  const bundleRoots = ctx.bundleRoots ?? NO_BUNDLES;
  // Links to an asset the index recorded as moved: reported with the new ref, and rewritten under `--fix`.
  const movedLinks = new Map<string, string>();
  const movedFinding = (ref: string, where: string): LintIssue | undefined => {
    const moved = ctx.moves?.target(ref);
    const concept = moved?.to.slice(moved.to.indexOf("//") + 2);
    if (
      !moved ||
      concept === undefined ||
      classifyConceptRef(
        concept,
        rootsOfBundle(moved.to.slice(0, moved.to.indexOf("//")), allRoots, bundleRoots),
        new Set([concept]),
      ) !== null
    )
      return undefined;
    const issue: LintIssue = {
      file: ctx.relPath,
      issue: "missing-ref",
      detail: `missing ref: ${ref} (${where}moved to ${moved.to})`,
      fixed: false,
      movedFrom: ref,
      movedTo: moved.to,
    };
    if (ctx.fix || ctx.fixMovedRefs) {
      movedLinks.set(ref.split("#", 1)[0] as string, moved.spelled);
      issue.fixed = true;
      issue.detail = `moved ref updated: ${ref} -> ${moved.spelled}`;
      pendingFixes.push(issue);
    }
    return issue;
  };
  {
    const explicitRefs = extractFrontmatterRefs(ctx.data, ctx.body);
    // An explicit `refs:` array is a REF LIST (each value is a whole ref —
    // short conceptIds included); a bare body is PROSE (anchored refs only).
    const missingRefs =
      explicitRefs !== null
        ? checkMissingRefsInList(
            explicitRefs,
            ctx.relPath,
            ctx.stashRoot,
            ctx.extraStashRoots,
            movedConcepts,
            bundleRoots,
          )
        : checkMissingRefs(ctx.body, ctx.stashRoot, ctx.extraStashRoots, movedConcepts, bundleRoots);
    for (const { ref, resolvedRelPath } of missingRefs) {
      issues.push(
        movedFinding(ref, "") ?? {
          file: ctx.relPath,
          issue: "missing-ref",
          detail: `missing ref: ${ref} (resolved to ${resolvedRelPath})`,
          fixed: false,
        },
      );
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
      for (const key of DECLARED_REF_FRONTMATTER_KEYS) {
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

        const allMissingXrefs = checkMissingRefsInList(
          values,
          ctx.relPath,
          ctx.stashRoot,
          ctx.extraStashRoots,
          movedConcepts,
          bundleRoots,
        );
        // A moved ref is a link to update, never a dangling edge to drop.
        const movedXrefs = allMissingXrefs.flatMap(({ ref }) => movedFinding(ref, `frontmatter ${key}; `) ?? []);
        issues.push(...movedXrefs);
        const missingXrefs = allMissingXrefs.filter(({ ref }) => !movedXrefs.some((issue) => issue.movedFrom === ref));

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
  if (movedLinks.size > 0) {
    const rewritten = rewriteMovedLinks(currentRaw, movedLinks);
    if (rewritten !== currentRaw) {
      currentRaw = rewritten;
      modified = true;
    } else {
      for (const issue of issues.filter((found) => found.movedTo !== undefined && found.fixed === true)) {
        issue.fixed = "failed";
        issue.detail = `${issue.detail} — could not find the link in the file to rewrite`;
      }
    }
  }
  return { issues, raw: currentRaw, modified };
}
