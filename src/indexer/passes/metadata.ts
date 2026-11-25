// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fs from "node:fs";
import path from "node:path";
import type { extractPackageMetadata } from "../../core/adapter/adapters/akm-metadata";
import type { buildFileContext } from "../../core/adapter/directory/file-context";
// The durable indexed-entry shape is `IndexDocument`. Its body
// — and the sub-shapes it references — live in `core/adapter/types.ts` so
// `IndexDocument` can reference them without a `metadata.ts ↔ types.ts` cycle;
// they are imported (and re-exported below) here. `SCOPE_KEYS` (a value) stays.
import type { IndexDocument, ScopeFilters, ScopeKey, StashEntryScope, StashIntent } from "../../core/adapter/types";
import { parseBundleRef } from "../../core/asset/asset-ref";
import { parseFrontmatter, readFrontmatterDate } from "../../core/asset/frontmatter";
import { asNonEmptyString } from "../../core/common";
import { isoDay } from "../../core/time";
import { isVerbose, warn, warnOnce } from "../../core/warn";
import {
  isWikiRole,
  normalizeNonEmptyStringList,
  normalizeQuality,
  normalizeScopeObject,
  normalizeTerms,
  SCOPE_KEYS,
} from "./entry-normalize";
import {
  getMarkdownFragmentContent,
  hasMarkdownFragmentContent,
  hasSessionMemoryMarker,
  MARKDOWN_CONTENT_MAX_CHARS,
  projectMarkdownContent,
  projectMarkdownFragmentContent,
  setMarkdownFragmentContent,
} from "./markdown-projection";

import {
  type CommentMetadata,
  extractCommandParameters,
  extractCommentMetadata,
  extractFrontmatterParameters,
  extractScriptParameters,
  mergeParameters,
} from "./script-metadata";

// ── Schema ──────────────────────────────────────────────────────────────────

export type {
  AssetParameter,
  IndexDocument,
  ScopeFilters,
  ScopeKey,
  StashEntryScope,
  StashIntent,
} from "../../core/adapter/types";

/** Every frontmatter key that carries scope: the flat `scope_*` keys and a legacy nested `scope:`. */
export const SCOPE_FRONTMATTER_KEYS: readonly string[] = ["scope", ...SCOPE_KEYS.map((key) => `scope_${key}`)];

export interface StashFile {
  entries: IndexDocument[];
  warnings?: string[];
}

/**
 * Pull `scope_user` / `scope_agent` / `scope_run` / `scope_channel` out of
 * a parsed frontmatter block and attach them as `entry.scope`. Tolerates
 * missing or malformed values; legacy memories without these keys are left
 * untouched (no `scope` field added).
 */
export function applyScopeFrontmatter(entry: IndexDocument, fmData: Record<string, unknown>): void {
  const collected: Record<string, unknown> = {};
  for (const key of SCOPE_KEYS) {
    const fmKey = `scope_${key}`;
    if (Object.hasOwn(fmData, fmKey)) {
      collected[key] = fmData[fmKey];
    }
  }
  if (Object.keys(collected).length === 0) return;
  const scope = normalizeScopeObject(collected);
  if (scope) entry.scope = scope;
}

/** The same normalized tuple the index projects, including legacy nested scope. */
export function scopeFromFrontmatter(fm: Record<string, unknown>): StashEntryScope {
  const entry: IndexDocument = { type: "memory", name: "scope" };
  if (typeof fm.scope === "object" && fm.scope !== null && !Array.isArray(fm.scope)) {
    entry.scope = normalizeScopeObject(fm.scope as Record<string, unknown>);
  }
  applyScopeFrontmatter(entry, fm);
  return entry.scope ?? {};
}

/**
 * Frontmatter with its scope keys ({@link SCOPE_FRONTMATTER_KEYS}) replaced by `scope`'s flat keys, or removed when
 * `scope` is empty. `replaced` is true when the input carried a scope other than `scope`, so a caller can warn once.
 */
export function stampScope(
  data: Record<string, unknown>,
  scope: StashEntryScope,
): { data: Record<string, unknown>; replaced: boolean } {
  const out: Record<string, unknown> = { ...data };
  for (const key of SCOPE_FRONTMATTER_KEYS) delete out[key];
  for (const key of SCOPE_KEYS) if (scope[key] !== undefined) out[`scope_${key}`] = scope[key];
  const present = SCOPE_FRONTMATTER_KEYS.some((key) => Object.hasOwn(data, key));
  return { data: out, replaced: present && !sameScope(scopeFromFrontmatter(data), scope) };
}

/** `data` plus the `metadata` keys it lacks; the keys already in `data` win, and metadata never carries scope. */
export function fillMetadata(
  data: Record<string, unknown>,
  metadata: Record<string, unknown> = {},
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...data };
  for (const [key, value] of Object.entries(metadata)) {
    if (!Object.hasOwn(out, key) && !SCOPE_FRONTMATTER_KEYS.includes(key)) out[key] = value;
  }
  return out;
}

/**
 * The one selection rule: every supplied key must match (AND), and a key with
 * several values matches any of them (OR). A key is a scope key, `tag`/`tags`
 * (matched like the index normalises tags), or any other frontmatter key.
 * An empty value (`key=`) matches an entry that does not carry the key; any
 * other value never matches such an entry. `tag` always carries path-derived
 * tags, so `tag=` matches almost no assets.
 */
export function scopeMatchesFilters(
  entry: Pick<IndexDocument, "scope" | "tags" | "frontmatter">,
  filters: ScopeFilters,
): boolean {
  for (const [key, expected] of Object.entries(filters)) {
    if (expected === undefined) continue;
    const wanted = Array.isArray(expected) ? expected : [expected];
    const wantsAbsent = wanted.includes("");
    let values = wanted.filter((value) => value !== "");
    let have: readonly string[] | undefined;
    if ((SCOPE_KEYS as readonly string[]).includes(key)) {
      const value = entry.scope?.[key as ScopeKey];
      have = value === undefined ? undefined : [value];
    } else if (key === "tag" || key === "tags") {
      have = entry.tags;
      values = normalizeTerms(values);
    } else {
      have = entry.frontmatter && Object.hasOwn(entry.frontmatter, key) ? entry.frontmatter[key] : undefined;
    }
    if (!have?.length) {
      if (wantsAbsent) continue;
      return false;
    }
    if (!values.some((value) => have.includes(value))) return false;
  }
  return true;
}

/**
 * Whether an asset applies under `project`: it names that project (`project:` in its
 * frontmatter) or names none (shared). With no project, only shared assets apply.
 */
export function appliesToProject(
  entry: Pick<IndexDocument, "scope" | "tags" | "frontmatter">,
  project?: string,
): boolean {
  return scopeMatchesFilters(entry, { project: project === undefined ? "" : [project, ""] });
}

/** Exact maintenance equality: absence is a value, never a wildcard. */
export function sameScope(a: StashEntryScope, b: StashEntryScope): boolean {
  return SCOPE_KEYS.every((key) => a[key] === b[key]);
}

function normalizeIntent(value: unknown): StashIntent | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const intent: StashIntent = {};
  const when = asNonEmptyString(raw.when);
  const input = asNonEmptyString(raw.input);
  const output = asNonEmptyString(raw.output);
  if (when) intent.when = when;
  if (input) intent.input = input;
  if (output) intent.output = output;
  return Object.keys(intent).length > 0 ? intent : undefined;
}

/**
 * Normalize a current derived-memory parent ref to its `memories/<name>`
 * conceptId for the `derived_from` column. Returns `undefined` for a non-memory
 * or bare value so the caller can inspect the current `derivedFrom` key.
 */
function normalizeMemoryBackref(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const parsed = parseBundleRef(value);
    return parsed.fragment === undefined && parsed.conceptId.startsWith("memories/") ? parsed.conceptId : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve a derived memory's parent conceptId from its current `source:` backref
 * or, failing that, its bare `derivedFrom: <name>` frontmatter key.
 */
function derivedFromConceptId(source: string | undefined, derivedFrom: string | undefined): string | undefined {
  const fromSource = normalizeMemoryBackref(source);
  if (fromSource) return fromSource;
  const rawDerivedFrom = derivedFrom?.trim();
  if (!rawDerivedFrom) return undefined;
  const qualified = normalizeMemoryBackref(rawDerivedFrom);
  if (qualified) return qualified;
  if (rawDerivedFrom.includes(":") || rawDerivedFrom.includes("//")) return undefined;
  try {
    return parseBundleRef(`memories/${rawDerivedFrom}`).conceptId;
  } catch {
    return undefined;
  }
}

export function applyCuratedFrontmatter(entry: IndexDocument, fmData: Record<string, unknown>): void {
  const description = asNonEmptyString(fmData.description);
  if (description) {
    entry.description = description;
    entry.source = "frontmatter";
    entry.confidence = 0.9;
  }

  const tags = normalizeNonEmptyStringList(fmData.tags);
  if (tags) entry.tags = normalizeTerms(tags);

  const aliases = normalizeNonEmptyStringList(fmData.aliases);
  if (aliases) entry.aliases = normalizeTerms(aliases);

  const searchHints = normalizeNonEmptyStringList(fmData.searchHints);
  if (searchHints) entry.searchHints = searchHints;

  const usage = normalizeNonEmptyStringList(fmData.usage);
  if (usage) entry.usage = usage;

  const examples = normalizeNonEmptyStringList(fmData.examples);
  if (examples) entry.examples = examples;

  const run = asNonEmptyString(fmData.run);
  if (run) entry.run = run;
  const setup = asNonEmptyString(fmData.setup);
  if (setup) entry.setup = setup;
  const cwd = asNonEmptyString(fmData.cwd);
  if (cwd) entry.cwd = cwd;

  const quality = asNonEmptyString(fmData.quality);
  if (quality) entry.quality = normalizeQuality(quality);

  // Dates: kept as written when they start with a calendar day, ignored otherwise.
  const created = asNonEmptyString(fmData.created);
  if (created && isoDay(created)) entry.created = created;
  const updated = asNonEmptyString(fmData.updated);
  if (updated && isoDay(updated)) entry.updated = updated;
  const observed = readFrontmatterDate(fmData, "observed");
  if (observed && isoDay(observed)) entry.observed = observed;
  const expires = asNonEmptyString(fmData.expires);
  if (expires && isoDay(expires)) entry.expires = expires;

  // Capture the `category:` frontmatter key (e.g. `convention`,
  // `meta` on facts) must land on the indexed entry so category-keyed
  // policies can see it. Trimmed; blank/non-string values are ignored.
  const category = asNonEmptyString(fmData.category);
  if (category) entry.category = category;

  const beliefState = asNonEmptyString(fmData.beliefState);
  if (beliefState) entry.beliefState = beliefState as IndexDocument["beliefState"];

  const supersededBy = normalizeNonEmptyStringList(fmData.supersededBy);
  if (supersededBy) entry.supersededBy = supersededBy;

  const contradictedBy = normalizeNonEmptyStringList(fmData.contradictedBy);
  if (contradictedBy) entry.contradictedBy = contradictedBy;

  const currentBeliefRefs = normalizeNonEmptyStringList(fmData.currentBeliefRefs);
  if (currentBeliefRefs) entry.currentBeliefRefs = currentBeliefRefs;

  // captureMode: "hot" | "background" — strict whitelist; unknown values are ignored.
  if (fmData.captureMode === "hot" || fmData.captureMode === "background") {
    entry.captureMode = fmData.captureMode;
  }

  // when_to_use → whenToUse — free-form guidance for retrieval/intent matching.
  const whenToUse = asNonEmptyString(fmData.when_to_use);
  if (whenToUse) entry.whenToUse = whenToUse;

  // lessonStrength: array → length, number → direct. Negative numbers clamp to 0.
  if (Array.isArray(fmData.lessonStrength)) {
    entry.lessonStrength = fmData.lessonStrength.length;
  } else if (typeof fmData.lessonStrength === "number" && Number.isFinite(fmData.lessonStrength)) {
    entry.lessonStrength = Math.max(0, Math.floor(fmData.lessonStrength));
  }

  const evidenceSources = normalizeNonEmptyStringList(fmData.evidenceSources);
  if (evidenceSources) entry.evidenceSources = evidenceSources;
  if (typeof fmData.evidence === "string" && fmData.evidence.trim().length > 0) entry.evidence = fmData.evidence;

  // Capture the parent ref for derived memories.
  // Memory-inference writes `source: "memories/<parent>"` and `inferred: true`
  // (and a derived child name suffix `.derived`). We mirror that source ref into
  // `entry.derivedFrom` so the indexer can populate the dedicated `derived_from`
  // column. The column is stored as the `memories/<name>` conceptId, matching
  // the `getDerivedForParent` lookup key (search-hit-enrichers) so producer and
  // consumer speak one grammar.
  // Non-derived entries leave this field unset.
  if (entry.type === "memory") {
    const isDerivedByName = entry.name.toLowerCase().endsWith(".derived");
    const isDerivedByFm = fmData.inferred === true;
    if (isDerivedByName || isDerivedByFm) {
      const parent = derivedFromConceptId(asNonEmptyString(fmData.source), asNonEmptyString(fmData.derivedFrom));
      if (parent) entry.derivedFrom = parent;
    }
  }

  const intent = normalizeIntent(fmData.intent);
  if (intent) entry.intent = intent;

  if (typeof fmData.scope === "object" && fmData.scope !== null && !Array.isArray(fmData.scope)) {
    const normalizedScope = normalizeScopeObject(fmData.scope as Record<string, unknown>);
    if (normalizedScope) entry.scope = normalizedScope;
  }

  applyScopeFrontmatter(entry, fmData);
  applySelectionFrontmatter(entry, fmData);
}

/** Longest value kept for selection; a longer one is prose, not a label. */
const SELECTION_VALUE_MAX_CHARS = 200;

/**
 * Keep the frontmatter keys `--filter` / `--prefer` can select on (`team`, `project`, `category`, ...) as string
 * lists on `entry.frontmatter`. Scope keys and `tags` have their own homes; objects and prose are skipped.
 */
function applySelectionFrontmatter(entry: IndexDocument, fmData: Record<string, unknown>): void {
  const kept: Record<string, string[]> = Object.create(null);
  for (const [key, raw] of Object.entries(fmData)) {
    if (key === "tags" || SCOPE_FRONTMATTER_KEYS.includes(key)) continue;
    const values: string[] = [];
    for (const item of Array.isArray(raw) ? raw : [raw]) {
      if (typeof item !== "string" && typeof item !== "number" && typeof item !== "boolean") continue;
      const value = String(item).trim();
      if (value && value.length <= SELECTION_VALUE_MAX_CHARS) values.push(value);
    }
    if (values.length > 0) kept[key] = values;
    else if (key === "project" && raw !== undefined && raw !== null && raw !== "") {
      warnOnce(
        `project-unusable:${entry.name}`,
        `"${entry.name}": frontmatter \`project\` must be a name (or a list of names), so it is ignored and the asset counts as shared.`,
      );
    }
  }
  if (Object.keys(kept).length > 0) entry.frontmatter = kept;
}

/**
 * Extract wiki frontmatter fields (wikiRole, pageKind, xrefs, sources) from a parsed
 * frontmatter block and apply them to the entry. Tolerates missing or malformed values.
 */
export function applyWikiFrontmatter(entry: IndexDocument, fmData: Record<string, unknown>): void {
  if (isWikiRole(fmData.wikiRole)) entry.wikiRole = fmData.wikiRole;
  const pageKind = fmData.pageKind;
  if (typeof pageKind === "string" && pageKind.trim().length > 0) {
    entry.pageKind = pageKind.trim();
  }
  // Only lists: a bare string is not a citation list here.
  const xrefs = Array.isArray(fmData.xrefs) ? normalizeNonEmptyStringList(fmData.xrefs) : undefined;
  if (xrefs) entry.xrefs = xrefs;
  const sources = Array.isArray(fmData.sources) ? normalizeNonEmptyStringList(fmData.sources) : undefined;
  if (sources) entry.sources = sources;
}

/**
 * Parse one `verified:` family value into the `IndexDocument.provenance` shape.
 * Accepts OKF v0.2's list form and its documented single-mapping shorthand
 * ("consumers MUST treat a bare mapping as a one-element list", OKF v0.2 §5.2).
 * Tolerant: an entry without a usable `by` is dropped individually.
 */
function parseVerifiedFamily(value: unknown): { by: string; at?: string }[] {
  const entries = Array.isArray(value) ? value : [value];
  return entries
    .filter((v): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v))
    .map((v) => {
      const by = asNonEmptyString(v.by);
      if (!by) return undefined;
      const at = asNonEmptyString(v.at);
      return at ? { by, at } : { by };
    })
    .filter((v): v is { by: string; at?: string } => v !== undefined);
}

/**
 * Extract the OKF v0.2 provenance families that `promoteProposal` stamps onto
 * accepted AKM-native proposals (#730), and apply them to the entry.
 *
 * The on-disk shape is deliberately **hybrid** (#730 review):
 * `generated:` and `verified:` are stamped BARE at the top level, exactly as
 * OKF v0.2 spells them, because neither has any pre-existing AKM consumer — so
 * a third-party OKF v0.2 reader treating an AKM stash as an OKF bundle sees
 * spec-conformant trust metadata, which is what `okf-support.md`'s
 * "AKM Markdown is an OKF-compatible superset" positioning promises. Only
 * `sources` stays namespaced under `provenance:`, because a bare top-level
 * `sources:` genuinely collides with {@link applyWikiFrontmatter}'s
 * pre-existing citation-**string** convention (which silently drops
 * non-strings).
 *
 * The nested `provenance.generatedBy` / `.generatedAt` / `.verified` spellings
 * are still read as a fallback so assets stamped by an earlier build keep
 * resolving. Tolerant throughout: any malformed sub-field is
 * dropped individually rather than rejecting the whole block.
 */
export function applyProvenanceFrontmatter(entry: IndexDocument, fmData: Record<string, unknown>): void {
  const provenance = fmData.provenance;
  const nested: Record<string, unknown> =
    provenance !== null && typeof provenance === "object" && !Array.isArray(provenance)
      ? (provenance as Record<string, unknown>)
      : {};
  const result: NonNullable<IndexDocument["provenance"]> = {};

  // Bare `generated: {by, at}` (OKF v0.2 §5.3) wins; nested is the fallback.
  const generatedMapping =
    fmData.generated !== null && typeof fmData.generated === "object" && !Array.isArray(fmData.generated)
      ? (fmData.generated as Record<string, unknown>)
      : undefined;
  const generatedBy = asNonEmptyString(generatedMapping?.by) ?? asNonEmptyString(nested.generatedBy);
  if (generatedBy) result.generatedBy = generatedBy;
  const generatedAt = asNonEmptyString(generatedMapping?.at) ?? asNonEmptyString(nested.generatedAt);
  if (generatedAt) result.generatedAt = generatedAt;

  // Bare `verified:` (list or single mapping) wins; nested is the fallback.
  const verified =
    fmData.verified !== undefined ? parseVerifiedFamily(fmData.verified) : parseVerifiedFamily(nested.verified);
  if (verified.length > 0) result.verified = verified;

  // `sources` is namespaced-only — see the collision note above.
  if (Array.isArray(nested.sources)) {
    const sources = nested.sources
      .filter((s): s is Record<string, unknown> => s !== null && typeof s === "object" && !Array.isArray(s))
      .map((s) => {
        const resource = asNonEmptyString(s.resource);
        return resource ? { resource } : undefined;
      })
      .filter((s): s is { resource: string } => s !== undefined);
    if (sources.length > 0) result.sources = sources;
  }

  if (Object.keys(result).length > 0) entry.provenance = result;
}

export function applyCommentMetadata(entry: IndexDocument, metadata: CommentMetadata | undefined): void {
  if (!metadata) return;
  let usedCommentMetadata = false;
  const use = <K extends keyof IndexDocument>(key: K, value: IndexDocument[K]): void => {
    entry[key] = value;
    usedCommentMetadata = true;
  };

  if (metadata.description && !entry.description) use("description", metadata.description);
  if (metadata.tags?.length && (!entry.tags || entry.tags.length === 0)) use("tags", normalizeTerms(metadata.tags));
  if (metadata.aliases?.length) use("aliases", normalizeTerms(metadata.aliases));
  if (metadata.searchHints?.length) use("searchHints", metadata.searchHints);
  if (metadata.usage?.length) use("usage", metadata.usage);
  if (metadata.examples?.length) use("examples", metadata.examples);
  if (metadata.intent && Object.keys(metadata.intent).length > 0) use("intent", metadata.intent);
  if (metadata.run) use("run", metadata.run);
  if (metadata.setup) use("setup", metadata.setup);
  if (metadata.cwd) use("cwd", metadata.cwd);
  if (metadata.scope) use("scope", metadata.scope);

  if (usedCommentMetadata && entry.source !== "frontmatter" && entry.source !== "manual") {
    entry.source = "comments";
    entry.confidence = Math.max(entry.confidence ?? 0, 0.7);
  }
}

function mergeAliases(existing: string[] | undefined, generated: string[]): string[] | undefined {
  const merged = normalizeTerms([...(existing ?? []), ...generated]);
  return merged.length > 0 ? merged : undefined;
}

/**
 * A copy of `entry` carrying `filePath`'s size (and its fragment projection),
 * or `entry` itself when the file cannot be stat'ed.
 */
export function withFileSize(entry: IndexDocument, filePath: string): IndexDocument {
  try {
    // asset-io: disk-usage the indexed file's size
    const sized = { ...entry, fileSize: fs.statSync(filePath).size };
    if (hasMarkdownFragmentContent(entry)) setMarkdownFragmentContent(sized, getMarkdownFragmentContent(entry));
    return sized;
  } catch {
    return entry;
  }
}

// ── Metadata Generation ─────────────────────────────────────────────────────

/**
 * Priorities 1-2 of the metadata pipeline — package.json (P1), `.md`
 * frontmatter (P2), and script `@param`/comment metadata (P2b) — everything
 * that runs BEFORE the renderer-contributor step (P3). Shared by the `akm`
 * adapter's synchronous `recognize` and the live index-drain path; the two
 * differ ONLY in how they obtain the
 * P3 renderer metadata (the adapter uses the synchronous
 * `foldRecognizedMetadata`), guaranteeing P1/P2/P4 parity by construction.
 * Mutates `entry` in place.
 */
export function applyPreContributorFields(
  entry: IndexDocument,
  file: string,
  ctx: Pick<ReturnType<typeof buildFileContext>, "content">,
  pkgMeta: ReturnType<typeof extractPackageMetadata> | undefined,
): void {
  const ext = path.extname(file).toLowerCase();

  // Priority 1: Package.json metadata
  if (pkgMeta) {
    if (pkgMeta.description && !entry.description) {
      entry.description = pkgMeta.description;
      entry.source = "package";
      entry.confidence = 0.8;
    }
    if (pkgMeta.keywords && pkgMeta.keywords.length > 0) entry.tags = normalizeTerms(pkgMeta.keywords);
  }

  // Priority 2: Frontmatter (for .md files -- overrides package.json description)
  // Secrets are excluded even when the file happens to be `.md`: the whole file
  // is the secret value and must never be read for frontmatter or any metadata.
  if (ext === ".md" && entry.type !== "secret") {
    const content = ctx.content();
    const parsed = parseFrontmatter(content);
    applyCuratedFrontmatter(entry, parsed.data);
    // Extract parameters from frontmatter params: key
    const fmParams = extractFrontmatterParameters(parsed.data);
    if (fmParams) entry.parameters = fmParams;
    // Pass wiki-pattern frontmatter through onto the entry
    applyWikiFrontmatter(entry, parsed.data);
    // #730: reread the namespaced `provenance:` block promoteProposal stamps.
    applyProvenanceFrontmatter(entry, parsed.data);
    // Native Markdown has one bounded low-weight body projection. Sensitive
    // types and raw session/checkpoint material never cross this boundary.
    const safeForFragments =
      entry.type !== "env" && entry.type !== "session" && !hasSessionMemoryMarker(parsed.data, parsed.content);
    setMarkdownFragmentContent(entry, safeForFragments ? projectMarkdownFragmentContent(content) : undefined);
    if (safeForFragments) {
      const truncationInfo = { truncated: false };
      const contentProjection = projectMarkdownContent(parsed.content, truncationInfo);
      if (contentProjection) {
        entry.content = contentProjection;
        if (truncationInfo.truncated) {
          entry.contentTruncated = true;
          // Unconditional, not warnVerbose: this bound sits far past any
          // real document, so tripping it means
          // something unusual is in the bundle and the operator should see
          // it without having to pass --verbose.
          warn(`${file}: indexed content truncated to ${MARKDOWN_CONTENT_MAX_CHARS} chars`);
        }
      }
    }
    // Extract parameters from template placeholders ($1, $ARGUMENTS, {{named}})
    if (entry.type === "command") {
      const cmdParams = extractCommandParameters(parsed.content);
      if (cmdParams) {
        entry.parameters = mergeParameters(entry.parameters, cmdParams);
      }
    }
  }

  // Extract @param from script files.
  // Env files (.env) and secret files (whole-file secrets) are deliberately
  // excluded — their contents are secrets and must never be parsed for @param
  // or any other metadata that could embed a value into the entry.
  if (ext !== ".md" && entry.type !== "env" && entry.type !== "secret") {
    const content = ctx.content();
    const scriptParams = extractScriptParameters(content);
    if (scriptParams) entry.parameters = scriptParams;
    applyCommentMetadata(entry, extractCommentMetadata(content));
  }
}

/**
 * Priority 4 of the metadata pipeline — filename-heuristic fallbacks (P4) that
 * run AFTER the renderer-contributor step (P3): a filename description when none
 * was set, path/dir-derived tags, tag normalization, and alias generation.
 * Shared with {@link applyPreContributorFields} by both pipeline paths.
 * Mutates `entry`.
 */
export function applyPostContributorFields(
  entry: IndexDocument,
  file: string,
  canonicalName: string,
  dirPath: string,
): void {
  const ext = path.extname(file).toLowerCase();
  const baseName = path.basename(file, ext);

  // Priority 4: Filename heuristics (fallback)
  if (!entry.description) {
    entry.description = fileNameToDescription(baseName);
    entry.source = "filename";
    entry.confidence = Math.min(entry.confidence ?? 0.55, 0.55);
  }
  if (!entry.tags || entry.tags.length === 0) {
    entry.tags = extractTagsFromPath(file, dirPath);
  }

  // Stash-organization conventions: directory (scope/domain) tokens
  // always reach the tags column, even when the author set explicit tags, so
  // nested assets keep the exact-tag ranking boost for their scope token.
  // Derived from canonicalName (the ref subpath) rather than the filesystem
  // path so the stash-walk and flat-walk indexing paths agree (the flat walk
  // passes `path.dirname(file)` as dirPath, which strips directory segments
  // from the fallback above). Filename tokens are deliberately NOT merged when
  // explicit tags exist — they already live in the FTS name column and in
  // aliases, and merging them would inflate exact-tag matches for every
  // filename word. `normalizeTerms` below dedupes author-restated tokens.
  entry.tags = [...(entry.tags ?? []), ...extractDirTagsFromName(canonicalName)];

  entry.tags = normalizeTerms(entry.tags ?? []);
  entry.aliases = mergeAliases(entry.aliases, buildAliases(canonicalName, entry.tags));

  // Search hints are only generated when LLM is configured (via enhanceEntriesWithLlm)
  // Heuristic search hints are too noisy to be useful for search quality

  entry.filename = path.basename(file);
}

export function buildMetadataSkipWarning(filePath: string, assetType: string, error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  // Workflow errors are already multi-line `path:line — message` blocks; print
  // them as-is so the author sees a flat list without a redundant prefix.
  const warning =
    assetType === "workflow"
      ? `Skipped workflow ${filePath}:\n${detail}`
      : `Skipped malformed ${assetType} asset at ${filePath}: ${detail}`;
  // Workflow validation warnings are noisy on cold-start search against fresh
  // registry-cloned content (see issue #273). At default verbosity we suppress
  // the per-spec stderr line and rely on a one-line summary emitted by the
  // indexer driver after the run completes. The full per-file detail is still
  // returned in the warnings[] array (and IndexResponse.warnings) for
  // programmatic consumers, and verbose mode restores the immediate stderr
  // print so workflow authors keep the rich feedback they expect.
  if (assetType === "workflow" && !isVerbose()) {
    return warning;
  }
  warn(warning);
  return warning;
}

/**
 * Returns true when a metadata-skip warning was produced by the workflow
 * validator. Used by the indexer driver to count workflow skips for the
 * default-verbosity summary line. Matches the prefix produced by
 * `buildMetadataSkipWarning` for `assetType === "workflow"`.
 */
export function isWorkflowSkipWarning(warning: string): boolean {
  return warning.startsWith("Skipped workflow ");
}

function buildAliases(name: string, tags: string[]): string[] {
  const aliases = new Set<string>();
  const spaced = name.replace(/[-_]+/g, " ").trim().toLowerCase();
  if (spaced && spaced !== name.toLowerCase()) aliases.add(spaced);
  if (tags.length > 1) aliases.add(tags.join(" "));
  return Array.from(aliases);
}

export function extractDescriptionFromComments(content: string): string | null {
  const lines = content.split(/\r?\n/).slice(0, 50);

  // Try JSDoc-style block comment: /** ... */
  const blockStart = lines.findIndex((l) => /^\s*\/\*\*/.test(l));
  if (blockStart >= 0) {
    const desc: string[] = [];
    for (let i = blockStart; i < lines.length; i++) {
      const line = lines[i]!;
      if (i > blockStart && /\*\//.test(line)) break;
      const cleaned = line
        .replace(/^\s*\/?\*\*?\s?/, "")
        .replace(/\*\/\s*$/, "")
        .trim();
      if (cleaned) desc.push(cleaned);
    }
    if (desc.length > 0) return desc.join(" ");
  }

  // Try hash comments at start of file (skip shebang)
  let start = 0;
  if (lines[0]?.startsWith("#!")) start = 1;
  const hashLines: string[] = [];
  for (let i = start; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (line.startsWith("#") && !line.startsWith("#!")) {
      hashLines.push(line.replace(/^#+\s*/, "").trim());
    } else if (line !== "") {
      break;
    }
  }
  if (hashLines.length > 0) return hashLines.join(" ");

  return null;
}

export function fileNameToDescription(fileName: string): string {
  return fileName
    .replace(/[-_]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .trim();
}

export function extractTagsFromPath(filePath: string, rootDir: string): string[] {
  const rel = path.relative(rootDir, filePath);
  const parts = rel.split(path.sep);
  const tags = new Set<string>();

  for (const part of parts) {
    const name = part.replace(path.extname(part), "");
    for (const token of name.split(/[-_./\\]+/)) {
      const clean = token.toLowerCase().trim();
      if (clean && clean.length > 1) tags.add(clean);
    }
  }

  return Array.from(tags);
}

/**
 * Extract scope/domain tags from the DIRECTORY segments of a canonical asset
 * name (the ref subpath — e.g. `"projectA/auth-tip"` → `["projecta"]`).
 *
 * Unlike {@link extractTagsFromPath} this never tokenizes the filename
 * segment: it exists so a nested asset's directory (scope/domain) tokens can
 * be merged into explicit author tags without dragging every filename word
 * into exact-tag matching.
 * Tokenization mirrors `extractTagsFromPath`: each segment splits on `-`/`_`/
 * `.`, lowercased, single-character tokens dropped. A name with no directory
 * segments yields no tags.
 */
export function extractDirTagsFromName(name: string): string[] {
  const tags = new Set<string>();
  for (const segment of name.split("/").slice(0, -1)) {
    for (const token of segment.split(/[-_.]+/)) {
      const clean = token.toLowerCase().trim();
      if (clean && clean.length > 1) tags.add(clean);
    }
  }
  return Array.from(tags);
}
