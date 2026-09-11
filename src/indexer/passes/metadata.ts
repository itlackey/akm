// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fs from "node:fs";
import path from "node:path";
// akm 0.9.0 Chunk 5 (type-merge): the durable indexed-entry shape is the merged
// `IndexDocument` (spec §3 = the pre-merge entry shape + provenance). Its body
// — and the sub-shapes it references — live in `core/adapter/types.ts` so
// `IndexDocument` can reference them without a `metadata.ts ↔ types.ts` cycle;
// they are imported (and re-exported below) here. `SCOPE_KEYS` (a value) stays.
import type { AssetParameter, IndexDocument, ScopeKey, StashEntryScope, StashIntent } from "../../core/adapter/types";
import { parseBundleRef } from "../../core/asset/asset-ref";
import { parseFrontmatter } from "../../core/asset/frontmatter";
import type { TocHeading } from "../../core/asset/markdown";
import { asNonEmptyString } from "../../core/common";
import { isVerbose, warn } from "../../core/warn";
import type { buildFileContext } from "../walk/file-context";

// ── Schema ──────────────────────────────────────────────────────────────────

export type {
  AssetParameter,
  IndexDocument,
  ScopeKey,
  StashEntryScope,
  StashIntent,
} from "../../core/adapter/types";

export const SCOPE_KEYS: readonly ScopeKey[] = ["user", "agent", "run", "channel"] as const;

export interface StashFile {
  entries: IndexDocument[];
  warnings?: string[];
}

// ── Quality semantics (v1 spec §4.2) ────────────────────────────────────────

/**
 * Well-known quality values. `generated`, `curated`, and `enriched` are included in
 * default search; `proposed` is excluded by default and opt-in via
 * `--include-proposed`. Unknown values warn once and remain searchable.
 */
export const KNOWN_QUALITY_VALUES = new Set(["generated", "curated", "enriched", "proposed"]);

/** Tracks unknown quality values we've already warned about (one warn per value per process). */
const warnedUnknownQualityValues = new Set<string>();

/**
 * Normalize a `quality` string off a stash entry. Known values pass through
 * untouched. Unknown values are accepted as-is (preserved verbatim on the
 * entry) but trigger a one-time warning per unique value via the shared
 * `warn()` helper (honours --quiet / `setQuiet()`).
 */
export function normalizeQuality(raw: string): string {
  if (KNOWN_QUALITY_VALUES.has(raw)) return raw;
  if (!warnedUnknownQualityValues.has(raw)) {
    warnedUnknownQualityValues.add(raw);
    warn(
      `Warning: unknown quality value "${raw}" — entry remains searchable, but consider using "generated", "curated", or "proposed" (v1 spec §4.2).`,
    );
  }
  return raw;
}

/**
 * Test-only: clear the per-process unknown-quality warning memo so a test
 * can re-trigger the warning. Not part of the public API.
 */
export function _resetUnknownQualityWarnings(): void {
  warnedUnknownQualityValues.clear();
}

/**
 * Returns true if an entry's quality marks it as "proposed". Proposed
 * entries are excluded from default search per v1 spec §4.2.
 */
export function isProposedQuality(quality: string | undefined): boolean {
  return quality === "proposed";
}

/**
 * Validate and normalize a raw object into a `IndexDocument`.
 *
 * Open type token: `entry.type` accepts any non-empty string. Type ownership
 * and capability decisions belong to the adapter; this format-neutral
 * projection must not reject a value merely because AKM does not own it.
 */
export function validateStashEntry(entry: unknown): IndexDocument | null {
  if (typeof entry !== "object" || entry === null) return null;
  const e = entry as Record<string, unknown>;
  if (typeof e.name !== "string" || !e.name) return null;
  if (typeof e.type !== "string" || !e.type) return null;

  const result: IndexDocument = {
    name: e.name,
    type: e.type as string,
  };
  if (typeof e.description === "string" && e.description) result.description = e.description;
  if (Array.isArray(e.tags)) result.tags = e.tags.filter((t): t is string => typeof t === "string");
  if (Array.isArray(e.examples)) result.examples = e.examples.filter((x): x is string => typeof x === "string");
  if (Array.isArray(e.searchHints)) {
    const filtered = e.searchHints.filter((s): s is string => typeof s === "string" && s.trim().length > 0);
    if (filtered.length > 0) result.searchHints = filtered;
  }
  if (typeof e.intent === "object" && e.intent !== null) {
    const intent = e.intent as Record<string, unknown>;
    result.intent = {};
    if (typeof intent.when === "string") result.intent.when = intent.when;
    if (typeof intent.input === "string") result.intent.input = intent.input;
    if (typeof intent.output === "string") result.intent.output = intent.output;
  }
  if (typeof e.filename === "string" && e.filename) result.filename = e.filename;
  if (typeof e.quality === "string" && e.quality.length > 0) {
    result.quality = normalizeQuality(e.quality);
  }
  if (typeof e.confidence === "number" && Number.isFinite(e.confidence))
    result.confidence = Math.max(0, Math.min(1, e.confidence));
  if (
    typeof e.source === "string" &&
    ["package", "frontmatter", "comments", "filename", "manual", "llm"].includes(e.source)
  ) {
    result.source = e.source as IndexDocument["source"];
  }
  if (Array.isArray(e.aliases)) {
    const filtered = e.aliases.filter((a): a is string => typeof a === "string" && a.trim().length > 0);
    if (filtered.length > 0) result.aliases = normalizeTerms(filtered);
  }
  if (Array.isArray(e.toc)) {
    const validated = e.toc.filter((h: unknown): h is TocHeading => {
      if (typeof h !== "object" || h === null) return false;
      const rec = h as Record<string, unknown>;
      return typeof rec.level === "number" && typeof rec.text === "string" && typeof rec.line === "number";
    });
    if (validated.length > 0) result.toc = validated;
  }
  const usage = normalizeNonEmptyStringList(e.usage);
  if (usage) result.usage = usage;
  // SECURITY NOTE: run, setup, and cwd are advisory metadata fields for AI agent consumers.
  // They are NOT executed by akm directly. Consumers should validate and sanitize before execution.
  if (typeof e.run === "string" && e.run.trim()) result.run = e.run.trim();
  if (typeof e.setup === "string" && e.setup.trim()) result.setup = e.setup.trim();
  if (typeof e.cwd === "string" && e.cwd.trim()) result.cwd = e.cwd.trim();
  if (typeof e.fileSize === "number" && Number.isFinite(e.fileSize) && e.fileSize >= 0) result.fileSize = e.fileSize;
  if (
    e.wikiRole === "schema" ||
    e.wikiRole === "index" ||
    e.wikiRole === "log" ||
    e.wikiRole === "raw" ||
    e.wikiRole === "page"
  ) {
    result.wikiRole = e.wikiRole;
  }
  if (typeof e.pageKind === "string" && e.pageKind.trim().length > 0) {
    result.pageKind = e.pageKind.trim();
  }
  const xrefs = normalizeNonEmptyStringList(e.xrefs);
  if (xrefs) result.xrefs = xrefs;
  const sources = normalizeNonEmptyStringList(e.sources);
  if (sources) result.sources = sources;
  // SPEC-6: `category` must survive the projection. Non-string values are
  // dropped, not coerced.
  if (typeof e.category === "string" && e.category.trim().length > 0) {
    result.category = e.category.trim();
  }
  if (typeof e.beliefState === "string" && e.beliefState.trim().length > 0) {
    result.beliefState = e.beliefState.trim() as IndexDocument["beliefState"];
  }
  const supersededBy = normalizeNonEmptyStringList(e.supersededBy);
  if (supersededBy) result.supersededBy = supersededBy;
  const contradictedBy = normalizeNonEmptyStringList(e.contradictedBy);
  if (contradictedBy) result.contradictedBy = contradictedBy;

  // R5 — consolidation provenance fields must survive the whitelist too, or
  // stash.json-overridden merge products lose merge-following + generation
  // counting in the collapse detector.
  if (typeof e.generation === "number" && Number.isFinite(e.generation) && e.generation > 0) {
    result.generation = Math.floor(e.generation);
  }
  const currentBeliefRefs = normalizeNonEmptyStringList(e.currentBeliefRefs);
  if (currentBeliefRefs) result.currentBeliefRefs = currentBeliefRefs;
  if (e.captureMode === "hot" || e.captureMode === "background") {
    result.captureMode = e.captureMode;
  }
  if (typeof e.whenToUse === "string" && e.whenToUse.trim().length > 0) {
    result.whenToUse = e.whenToUse.trim();
  }
  if (typeof e.lessonStrength === "number" && Number.isFinite(e.lessonStrength) && e.lessonStrength >= 0) {
    result.lessonStrength = Math.floor(e.lessonStrength);
  }
  const evidenceSources = normalizeNonEmptyStringList(e.evidenceSources);
  if (evidenceSources) result.evidenceSources = evidenceSources;
  if (typeof e.derivedFrom === "string" && e.derivedFrom.trim().length > 0) {
    result.derivedFrom = e.derivedFrom.trim();
  }
  if (typeof e.content === "string" && e.content.trim().length > 0) {
    result.content = e.content;
  }
  if (typeof e.scope === "object" && e.scope !== null && !Array.isArray(e.scope)) {
    const scope = normalizeScopeObject(e.scope as Record<string, unknown>);
    if (scope) result.scope = scope;
  }
  if (Array.isArray(e.parameters)) {
    const validated = e.parameters
      .filter((p: unknown): p is AssetParameter => {
        if (typeof p !== "object" || p === null) return false;
        const rec = p as Record<string, unknown>;
        return typeof rec.name === "string" && rec.name.trim().length > 0;
      })
      .map((p: unknown) => {
        const rec = p as Record<string, unknown>;
        const param: AssetParameter = { name: (rec.name as string).trim() };
        if (typeof rec.type === "string" && rec.type.trim()) param.type = rec.type.trim();
        if (typeof rec.description === "string" && rec.description.trim()) param.description = rec.description.trim();
        if (typeof rec.required === "boolean") param.required = rec.required;
        if (typeof rec.default === "string" && rec.default.trim().length > 0) param.default = rec.default;
        return param;
      });
    if (validated.length > 0) result.parameters = validated;
  }

  return result;
}

/**
 * Coerce a raw `{ user, agent, run, channel }` object into a clean
 * `StashEntryScope`, dropping non-string and empty values. Returns
 * `undefined` when no recognized keys carry a value.
 */
function normalizeScopeObject(raw: Record<string, unknown>): StashEntryScope | undefined {
  const out: StashEntryScope = {};
  for (const key of SCOPE_KEYS) {
    const value = raw[key];
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed) out[key] = trimmed;
    } else if (typeof value === "number" && Number.isFinite(value)) {
      out[key] = String(value);
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
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

function normalizeStringListOrUndefined(value: unknown): string[] | undefined {
  return normalizeNonEmptyStringList(value);
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

  const tags = normalizeStringListOrUndefined(fmData.tags);
  if (tags) entry.tags = normalizeTerms(tags);

  const aliases = normalizeStringListOrUndefined(fmData.aliases);
  if (aliases) entry.aliases = normalizeTerms(aliases);

  const searchHints = normalizeStringListOrUndefined(fmData.searchHints);
  if (searchHints) entry.searchHints = searchHints;

  const usage = normalizeStringListOrUndefined(fmData.usage);
  if (usage) entry.usage = usage;

  const examples = normalizeStringListOrUndefined(fmData.examples);
  if (examples) entry.examples = examples;

  const run = asNonEmptyString(fmData.run);
  if (run) entry.run = run;
  const setup = asNonEmptyString(fmData.setup);
  if (setup) entry.setup = setup;
  const cwd = asNonEmptyString(fmData.cwd);
  if (cwd) entry.cwd = cwd;

  const quality = asNonEmptyString(fmData.quality);
  if (quality) entry.quality = normalizeQuality(quality);

  // SPEC-6 capture step: the `category:` frontmatter key (e.g. `convention`,
  // `meta` on facts) must land on the indexed entry so category-keyed
  // policies can see it. Trimmed; blank/non-string values are ignored.
  const category = asNonEmptyString(fmData.category);
  if (category) entry.category = category;

  const beliefState = asNonEmptyString(fmData.beliefState);
  if (beliefState) entry.beliefState = beliefState as IndexDocument["beliefState"];

  const supersededBy = normalizeStringListOrUndefined(fmData.supersededBy);
  if (supersededBy) entry.supersededBy = supersededBy;

  const contradictedBy = normalizeStringListOrUndefined(fmData.contradictedBy);
  if (contradictedBy) entry.contradictedBy = contradictedBy;

  // R5 — consolidation generation depth is captured so the collapse detector
  // can count over-generation assets without filesystem reads.
  const generation = fmData.generation;
  if (typeof generation === "number" && Number.isFinite(generation) && generation > 0) {
    entry.generation = Math.floor(generation);
  }
  const currentBeliefRefs = normalizeStringListOrUndefined(fmData.currentBeliefRefs);
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

  const evidenceSources = normalizeStringListOrUndefined(fmData.evidenceSources);
  if (evidenceSources) entry.evidenceSources = evidenceSources;

  // Phase 5A / Advantage D5: capture parent ref for derived memories.
  // Memory-inference writes `source: "memories/<parent>"` and `inferred: true`
  // (and a derived child name suffix `.derived`). We mirror that source ref into
  // `entry.derivedFrom` so the indexer can populate the dedicated `derived_from`
  // column. Group-C item 2: the column is stored in the 0.9.0 `memories/<name>`
  // conceptId grammar — moving in lockstep with the `getDerivedForParent` lookup
  // key (search-hit-enrichers) so producer + consumer speak one grammar.
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
}

function normalizeNonEmptyStringList(value: unknown): string[] | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : undefined;
  }
  if (!Array.isArray(value)) return undefined;
  const filtered = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return filtered.length > 0 ? filtered : undefined;
}

// ── Parameter Extraction ─────────────────────────────────────────────────────

/**
 * Extract structured parameters from a command template containing
 * `$ARGUMENTS`, `$1`-`$9`, or `{{named}}` placeholders.
 */
export function extractCommandParameters(template: string): AssetParameter[] | undefined {
  const params: AssetParameter[] = [];

  if (/\$ARGUMENTS\b/.test(template)) {
    params.push({ name: "ARGUMENTS" });
  }

  for (const match of template.matchAll(/\$([1-9])(?!\d)/g)) {
    const name = `$${match[1]}`;
    if (!params.some((p) => p.name === name)) {
      params.push({ name });
    }
  }

  for (const match of template.matchAll(/\{\{([a-zA-Z_][a-zA-Z0-9_]*)\}\}/g)) {
    const name = match[1]!;
    if (!params.some((p) => p.name === name)) {
      params.push({ name });
    }
  }

  return params.length > 0 ? params : undefined;
}

/**
 * Extract wiki frontmatter fields (wikiRole, pageKind, xrefs, sources) from a parsed
 * frontmatter block and apply them to the entry. Tolerates missing or malformed values.
 */
export function applyWikiFrontmatter(entry: IndexDocument, fmData: Record<string, unknown>): void {
  const role = fmData.wikiRole;
  if (role === "schema" || role === "index" || role === "log" || role === "raw" || role === "page") {
    entry.wikiRole = role;
  }
  const pageKind = fmData.pageKind;
  if (typeof pageKind === "string" && pageKind.trim().length > 0) {
    entry.pageKind = pageKind.trim();
  }
  const xrefs = fmData.xrefs;
  if (Array.isArray(xrefs)) {
    const filtered = xrefs
      .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
      .map((x) => x.trim());
    if (filtered.length > 0) entry.xrefs = filtered;
  }
  const sources = fmData.sources;
  if (Array.isArray(sources)) {
    const filtered = sources
      .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
      .map((s) => s.trim());
    if (filtered.length > 0) entry.sources = filtered;
  }
}

/**
 * Parse one `verified:` family value into the `IndexDocument.provenance` shape.
 * Accepts OKF v0.2's list form and its documented single-mapping shorthand
 * ("consumers MUST treat a bare mapping as a one-element list", SPEC §5.2).
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
 * accepted AKM-native proposals (D2, #730), and apply them to the entry.
 *
 * The on-disk shape is deliberately **hybrid** (owner decision, #730 review):
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
 * are still read as a fallback so assets stamped by an earlier build of this
 * branch keep resolving. Tolerant throughout: any malformed sub-field is
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

// AKM-stash indexing policy (env/vaults/secrets sensitive-marker + wiki-infra
// exclusions) moved to the `akm` adapter's `recognize` as path/stat-based
// abstention (owner ruling 2026-07-21 — adapter-owned filtering). See
// `akmStashAbstains` in `src/core/adapter/adapters/akm-adapter.ts`.

/**
 * Extract `@param` JSDoc tags from a script file's leading comment block.
 *
 * Supports both JSDoc-style (`/** ... * /`) and hash-style (`# @param ...`)
 * comments. Optionally captures `{type}` annotations.
 */
export function extractScriptParameters(filePath: string, content?: string): AssetParameter[] | undefined {
  if (content === undefined) {
    try {
      content = fs.readFileSync(filePath, "utf8");
    } catch {
      return undefined;
    }
  }

  const lines = content.split(/\r?\n/).slice(0, 50);
  const params: AssetParameter[] = [];

  // Match @param lines in any comment style:
  // JSDoc:  * @param {string} name - description
  // JSDoc:  * @param name - description
  // Hash:   # @param name - description
  const paramRegex = /^[\s/*#;-]*@param\s+(?:\{([^}]+)\}\s+)?(\w+)(?:\s+-\s+(.+))?/;

  for (const line of lines) {
    const match = line.match(paramRegex);
    if (match) {
      const param: AssetParameter = { name: match[2]! };
      if (match[1]) param.type = match[1].trim();
      if (match[3]) param.description = match[3].trim();
      params.push(param);
    }
  }

  return params.length > 0 ? params : undefined;
}

/**
 * Extract parameters from frontmatter `params:` key.
 *
 * The frontmatter parser produces a nested object for `params:` like:
 * ```
 * { region: "AWS region to deploy to", instance_type: "EC2 instance type" }
 * ```
 */
export function extractFrontmatterParameters(fmData: Record<string, unknown>): AssetParameter[] | undefined {
  const paramsRaw = fmData.params;
  if (typeof paramsRaw !== "object" || paramsRaw === null || Array.isArray(paramsRaw)) return undefined;

  const paramsObj = paramsRaw as Record<string, unknown>;
  const params: AssetParameter[] = [];

  for (const [key, value] of Object.entries(paramsObj)) {
    const param: AssetParameter = { name: key };
    if (typeof value === "string" && value.trim()) {
      param.description = value.trim();
    }
    params.push(param);
  }

  return params.length > 0 ? params : undefined;
}

/**
 * Merge two parameter lists, deduplicating by name.
 * Parameters from `additional` are appended only if their name is not already present.
 */
function mergeParameters(
  existing: AssetParameter[] | undefined,
  additional: AssetParameter[] | undefined,
): AssetParameter[] | undefined {
  if (!additional || additional.length === 0) return existing;
  if (!existing || existing.length === 0) return additional;

  const names = new Set(existing.map((p) => p.name));
  const merged = [...existing];
  for (const param of additional) {
    if (!names.has(param.name)) {
      merged.push(param);
      names.add(param.name);
    }
  }
  return merged;
}

export interface CommentMetadata {
  description?: string;
  tags?: string[];
  aliases?: string[];
  searchHints?: string[];
  usage?: string[];
  examples?: string[];
  intent?: StashIntent;
  run?: string;
  setup?: string;
  cwd?: string;
  scope?: StashEntryScope;
}

function splitCommentList(raw: string): string[] {
  return raw
    .split(/[;,]/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function parseCommentScope(raw: string): StashEntryScope | undefined {
  const pairs = raw
    .split(/[;,]/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  if (pairs.length === 0) return undefined;
  const scopeRaw: Record<string, unknown> = {};
  for (const pair of pairs) {
    const [keyPart, ...valueParts] = pair.split("=");
    const key = keyPart?.trim();
    const value = valueParts.join("=").trim();
    if (!key || !value) continue;
    if ((SCOPE_KEYS as readonly string[]).includes(key)) {
      scopeRaw[key] = value;
    }
  }
  return normalizeScopeObject(scopeRaw);
}

function parseIntentCommentLine(cleaned: string, metadata: CommentMetadata): boolean {
  const intentMatch = cleaned.match(/^@intent(?:\.(when|input|output))?\s+(.+)$/);
  if (!intentMatch) return false;
  metadata.intent ??= {};
  const value = intentMatch[2]!.trim();
  const key = intentMatch[1];
  if (key === "when") metadata.intent.when = value;
  else if (key === "input") metadata.intent.input = value;
  else if (key === "output") metadata.intent.output = value;
  else metadata.intent.when ??= value;
  return true;
}

export function extractCommentMetadata(filePath: string, content?: string): CommentMetadata | undefined {
  if (content === undefined) {
    try {
      content = fs.readFileSync(filePath, "utf8");
    } catch {
      return undefined;
    }
  }

  const lines = content.split(/\r?\n/).slice(0, 50);
  const metadata: CommentMetadata = {};

  for (const line of lines) {
    const trimmed = line.trim();
    if (!/^(?:\/\/|#|\/?\*|;|--)/.test(trimmed) && !trimmed.startsWith("'")) continue;

    const cleaned = trimmed
      .replace(/^(?:\/\/|##?|\/?\*\*?\/?|;|--|'?)\s*/, "")
      .replace(/\*\/\s*$/, "")
      .trim();
    if (!cleaned) continue;

    if (parseIntentCommentLine(cleaned, metadata)) continue;

    const descMatch = cleaned.match(/^@description\s+(.+)$/);
    if (descMatch) {
      metadata.description = descMatch[1]!.trim();
      continue;
    }

    const tagsMatch = cleaned.match(/^@tags?\s+(.+)$/);
    if (tagsMatch) {
      metadata.tags = splitCommentList(tagsMatch[1]!);
      continue;
    }

    const aliasesMatch = cleaned.match(/^@aliases?\s+(.+)$/);
    if (aliasesMatch) {
      metadata.aliases = splitCommentList(aliasesMatch[1]!);
      continue;
    }

    const hintsMatch = cleaned.match(/^@searchHints?\s+(.+)$/);
    if (hintsMatch) {
      metadata.searchHints = splitCommentList(hintsMatch[1]!);
      continue;
    }

    const usageMatch = cleaned.match(/^@usage\s+(.+)$/);
    if (usageMatch) {
      metadata.usage = [...(metadata.usage ?? []), usageMatch[1]!.trim()];
      continue;
    }

    const examplesMatch = cleaned.match(/^@examples?\s+(.+)$/);
    if (examplesMatch) {
      metadata.examples = [...(metadata.examples ?? []), examplesMatch[1]!.trim()];
      continue;
    }

    const runMatch = cleaned.match(/^@run\s+(.+)$/);
    if (runMatch) {
      metadata.run = runMatch[1]!.trim();
      continue;
    }

    const setupMatch = cleaned.match(/^@setup\s+(.+)$/);
    if (setupMatch) {
      metadata.setup = setupMatch[1]!.trim();
      continue;
    }

    const cwdMatch = cleaned.match(/^@cwd\s+(.+)$/);
    if (cwdMatch) {
      metadata.cwd = cwdMatch[1]!.trim();
      continue;
    }

    const scopeMatch = cleaned.match(/^@scope\s+(.+)$/);
    if (scopeMatch) {
      const scope = parseCommentScope(scopeMatch[1]!);
      if (scope) metadata.scope = scope;
    }
  }

  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

export function applyCommentMetadata(entry: IndexDocument, metadata: CommentMetadata | undefined): void {
  if (!metadata) return;
  let usedCommentMetadata = false;

  if (metadata.description && !entry.description) {
    entry.description = metadata.description;
    usedCommentMetadata = true;
  }
  if (metadata.tags?.length && (!entry.tags || entry.tags.length === 0)) {
    entry.tags = normalizeTerms(metadata.tags);
    usedCommentMetadata = true;
  }
  if (metadata.aliases?.length) {
    entry.aliases = normalizeTerms(metadata.aliases);
    usedCommentMetadata = true;
  }
  if (metadata.searchHints?.length) {
    entry.searchHints = metadata.searchHints;
    usedCommentMetadata = true;
  }
  if (metadata.usage?.length) {
    entry.usage = metadata.usage;
    usedCommentMetadata = true;
  }
  if (metadata.examples?.length) {
    entry.examples = metadata.examples;
    usedCommentMetadata = true;
  }
  if (metadata.intent && Object.keys(metadata.intent).length > 0) {
    entry.intent = metadata.intent;
    usedCommentMetadata = true;
  }
  if (metadata.run) {
    entry.run = metadata.run;
    usedCommentMetadata = true;
  }
  if (metadata.setup) {
    entry.setup = metadata.setup;
    usedCommentMetadata = true;
  }
  if (metadata.cwd) {
    entry.cwd = metadata.cwd;
    usedCommentMetadata = true;
  }
  if (metadata.scope) {
    entry.scope = metadata.scope;
    usedCommentMetadata = true;
  }

  if (usedCommentMetadata && entry.source !== "frontmatter" && entry.source !== "manual") {
    entry.source = "comments";
    entry.confidence = Math.max(entry.confidence ?? 0, 0.7);
  }
}

function mergeAliases(existing: string[] | undefined, generated: string[]): string[] | undefined {
  const merged = normalizeTerms([...(existing ?? []), ...generated]);
  return merged.length > 0 ? merged : undefined;
}

// ── Enrichment Completeness ─────────────────────────────────────────────────

/**
 * Returns `true` when a stash entry already has enough LLM-quality metadata
 * that calling the LLM would produce no meaningful improvement.
 *
 * An entry is considered complete when ALL of the following hold:
 * - `description` is a non-empty string
 * - `tags` is a non-empty array
 * - `searchHints` is a non-empty array
 *
 * This predicate is used by `enhanceDirsWithLlm` to skip the LLM call for
 * entries that were previously enriched and already carry all three fields.
 */
export function isEnrichmentComplete(entry: IndexDocument): boolean {
  const hasDescription = typeof entry.description === "string" && entry.description.trim().length > 0;
  const hasTags = Array.isArray(entry.tags) && entry.tags.length > 0;
  const hasSearchHints = Array.isArray(entry.searchHints) && entry.searchHints.length > 0;
  return hasDescription && hasTags && hasSearchHints;
}

// ── Native Markdown search projection ──────────────────────────────────────

/**
 * Maximum native Markdown prose carried by the low-weight `content` field.
 *
 * Raised far past any real authored document:
 * this used to sit at 16_384 chars, tight enough that ordinary long-form
 * skills/knowledge docs lost their tail from both FTS and the embedding
 * input with no visible signal (the cut was reported via `warnVerbose`,
 * silent unless `AKM_VERBOSE` was set). The remaining bound exists only to
 * stop a truly pathological single file (a committed data dump, a decompressed
 * log) from ballooning index size — not to shave real content — so a caller
 * that hits it is always told, unconditionally.
 */
export const MARKDOWN_CONTENT_MAX_CHARS = 1_000_000;

/**
 * Locate a leading nested frontmatter block in a body: up to three blank
 * lines, then a `---` line, closed by a later `---` line. Mirrors the
 * base-linter's `parseInnerFrontmatterBlock` recognition — when `akm
 * remember` wraps a session-capture hook's file in its own frontmatter, the
 * hook's `---\nakm_memory_kind: …\n---` block survives at the top of the
 * body. Returns the open/close line indexes, or `null` when no block opens.
 * Location only — callers apply their own interior checks (marker scan in
 * {@link hasSessionMemoryMarker}, shape test in {@link isFrontmatterShaped}).
 */
function findInnerFrontmatterBlock(lines: string[]): { open: number; close: number } | null {
  let i = 0;
  while (i < lines.length && i < 3 && lines[i]!.trim() === "") i += 1;
  if (lines[i] !== "---") return null;
  for (let j = i + 1; j < lines.length; j += 1) {
    if (lines[j] === "---") return { open: i, close: j };
  }
  return null;
}

/**
 * True when the document carries the session-capture `akm_memory_kind`
 * marker — in the outer frontmatter data OR in a nested inner block at the
 * top of the body (both producer layouts exist; see base-linter's
 * `extractFrontmatterRefs`). Session bodies are raw transcripts, never a
 * searchable content projection.
 */
function hasSessionMemoryMarker(fmData: Record<string, unknown>, body: string): boolean {
  if (typeof fmData.akm_memory_kind === "string") return true;
  const lines = body.split(/\r?\n/);
  const block = findInnerFrontmatterBlock(lines);
  if (!block) return false;
  for (let i = block.open + 1; i < block.close; i += 1) {
    if (/^akm_memory_kind:\s*\S/.test(lines[i]!)) return true;
  }
  return false;
}

/**
 * True when the interior of a candidate inner block (located by
 * {@link findInnerFrontmatterBlock}) actually reads as YAML frontmatter:
 * every line is blank, indented (a continuation or nested value), or shaped
 * like a top-level `key:` mapping entry. Ordinary prose bracketed by two
 * thematic-break `---` lines fails this test, so a decorative opening
 * callout is treated as the paragraph it is instead of being discarded
 * (review finding on SPEC-8 — the block finder alone accepts ANY content up
 * to an arbitrarily distant closing `---`).
 */
function isFrontmatterShaped(lines: string[], block: { open: number; close: number }): boolean {
  for (let i = block.open + 1; i < block.close; i += 1) {
    const line = lines[i]!;
    if (line.trim() === "") continue;
    if (/^\s/.test(line)) continue; // indented continuation / nested value
    if (/^[A-Za-z0-9_.-]+:(\s|$)/.test(line)) continue; // top-level key
    return false;
  }
  return true;
}

function truncateUnicodeSafe(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  let cut = text.slice(0, maxChars);
  const lastCode = cut.charCodeAt(cut.length - 1);
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) cut = cut.slice(0, -1);
  const boundary = cut.lastIndexOf(" ");
  if (boundary >= Math.floor(maxChars * 0.9)) cut = cut.slice(0, boundary);
  return cut.trimEnd();
}

type MarkdownFence = { marker: "`" | "~"; length: number };

function parseMarkdownFenceOpening(line: string): MarkdownFence | undefined {
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  const run = match?.[1];
  if (!run) return undefined;
  const marker = run[0] as "`" | "~";
  // CommonMark forbids backticks in the info string of a backtick fence.
  if (marker === "`" && match?.[2]?.includes("`")) return undefined;
  return { marker, length: run.length };
}

function isMarkdownFenceClosing(line: string, fence: MarkdownFence): boolean {
  let cursor = 0;
  while (cursor < line.length && cursor < 3 && line[cursor] === " ") cursor += 1;
  const runStart = cursor;
  while (cursor < line.length && line[cursor] === fence.marker) cursor += 1;
  if (cursor - runStart < fence.length) return false;
  return /^[\t ]*$/.test(line.slice(cursor));
}

function stripMarkdownHtmlComments(line: string, state: { inComment: boolean }): string {
  let cursor = 0;
  let visible = "";
  while (cursor < line.length) {
    if (state.inComment) {
      const close = line.indexOf("-->", cursor);
      if (close < 0) return visible;
      state.inComment = false;
      cursor = close + 3;
      continue;
    }
    const open = line.indexOf("<!--", cursor);
    if (open < 0) return `${visible}${line.slice(cursor)}`;
    visible += line.slice(cursor, open);
    state.inComment = true;
    cursor = open + 4;
  }
  return visible;
}

function findBalancedMarkdownClose(text: string, openAt: number, open: string, close: string): number | undefined {
  let depth = 1;
  for (let cursor = openAt + 1; cursor < text.length; cursor += 1) {
    const char = text[cursor];
    if (char === "\\") {
      cursor += 1;
      continue;
    }
    if (char === open) depth += 1;
    if (char !== close) continue;
    depth -= 1;
    if (depth === 0) return cursor;
  }
  return undefined;
}

/**
 * Find the closing parenthesis of an inline link destination. Parentheses in
 * angle-delimited destinations and quoted titles are data, while unquoted
 * parentheses remain balanced. Backslash escapes suppress delimiter meaning.
 */
function findMarkdownDestinationClose(text: string, openAt: number): number | undefined {
  let depth = 1;
  let phase: "before-destination" | "angle-destination" | "bare-destination" | "after-destination" | "title" =
    "before-destination";
  let quote: '"' | "'" | undefined;
  let parenthesizedTitle = false;
  let titleSeparator = false;
  for (let cursor = openAt + 1; cursor < text.length; cursor += 1) {
    const char = text[cursor];
    if (char === "\\") {
      cursor += 1;
      continue;
    }

    if (phase === "before-destination") {
      if (/\s/u.test(char ?? "")) continue;
      if (char === "<") {
        phase = "angle-destination";
        continue;
      }
      if (char === ")") return cursor;
      phase = "bare-destination";
    }

    if (phase === "angle-destination") {
      if (char === ">") phase = "after-destination";
      continue;
    }

    if (phase === "title") {
      if (quote) {
        if (char === quote) {
          quote = undefined;
          phase = "after-destination";
          titleSeparator = false;
        }
        continue;
      }
      if (parenthesizedTitle) {
        if (char === "(") depth += 1;
        if (char !== ")") continue;
        depth -= 1;
        if (depth === 1) {
          parenthesizedTitle = false;
          phase = "after-destination";
          titleSeparator = false;
        }
      }
      continue;
    }

    if (phase === "after-destination") {
      if (/\s/u.test(char ?? "")) {
        titleSeparator = true;
        continue;
      }
      if (char === ")") return cursor;
      if (titleSeparator && (char === '"' || char === "'")) {
        quote = char;
        phase = "title";
        continue;
      }
      if (titleSeparator && char === "(") {
        depth += 1;
        parenthesizedTitle = true;
        phase = "title";
        continue;
      }
      // Invalid trailing bytes are still consumed conservatively until the
      // balanced outer close. Quotes here are ordinary bytes, never titles.
      phase = "bare-destination";
    }

    if (phase !== "bare-destination") continue;
    if (char === "(") {
      depth += 1;
      continue;
    }
    if (char === ")") {
      depth -= 1;
      if (depth === 0) return cursor;
      continue;
    }
    if (/\s/u.test(char ?? "") && depth === 1) {
      phase = "after-destination";
      titleSeparator = true;
    }
  }
  return undefined;
}

const MAX_MARKDOWN_LINK_NESTING = 32;

/** Retain recursively projected link labels while dropping complete destinations. */
function stripMarkdownLinkDestinations(text: string, nesting = 0): string {
  let visible = "";
  let cursor = 0;
  while (cursor < text.length) {
    const isImage = text[cursor] === "!" && text[cursor + 1] === "[";
    const labelOpen = isImage ? cursor + 1 : cursor;
    if (text[labelOpen] !== "[") {
      visible += text[cursor];
      cursor += 1;
      continue;
    }
    const labelClose = findBalancedMarkdownClose(text, labelOpen, "[", "]");
    const destinationOpen = labelClose === undefined ? undefined : labelClose + 1;
    if (destinationOpen === undefined || text[destinationOpen] !== "(") {
      visible += text[cursor];
      cursor += 1;
      continue;
    }
    const destinationClose = findMarkdownDestinationClose(text, destinationOpen);
    if (destinationClose === undefined) {
      visible += text[cursor];
      cursor += 1;
      continue;
    }
    // Labels may themselves contain images/links. Recursively project them so
    // an inner destination cannot become visible when its outer link is
    // removed. At an adversarial nesting depth, omit the label rather than
    // leaking its unparsed bytes into the search projection.
    if (nesting < MAX_MARKDOWN_LINK_NESTING) {
      visible += stripMarkdownLinkDestinations(text.slice(labelOpen + 1, labelClose), nesting + 1);
    }
    cursor = destinationClose + 1;
  }
  return visible;
}

/**
 * Derive the one low-weight search projection for an AKM-native Markdown body.
 * Frontmatter is removed by the caller. This projection drops comments,
 * fenced code, raw link targets, and structural punctuation while retaining
 * prose, headings, link labels, and inline identifiers. It never receives
 * secret/env/session bytes; that policy is enforced at the adapter metadata
 * boundary below.
 */
export function projectMarkdownContent(body: string, truncationInfo?: { truncated: boolean }): string | undefined {
  const lines = body.split(/\r?\n/);
  const innerBlock = findInnerFrontmatterBlock(lines);
  const start = innerBlock && isFrontmatterShaped(lines, innerBlock) ? innerBlock.close + 1 : 0;
  const projected: string[] = [];
  let fence: MarkdownFence | undefined;
  const htmlComment = { inComment: false };
  for (let i = start; i < lines.length; i += 1) {
    const rawLine = lines[i]!;
    if (fence) {
      if (isMarkdownFenceClosing(rawLine, fence)) fence = undefined;
      continue;
    }

    // A leading fence owns the whole line, including any info string that
    // resembles HTML. Comment state therefore cannot begin inside a fence.
    if (!htmlComment.inComment) {
      const openingFence = parseMarkdownFenceOpening(rawLine);
      if (openingFence) {
        fence = openingFence;
        continue;
      }
    }

    let trimmed = stripMarkdownHtmlComments(rawLine, htmlComment).trim();
    const openingFence = parseMarkdownFenceOpening(trimmed);
    if (openingFence) {
      fence = openingFence;
      continue;
    }
    if (!trimmed || /^(-{3,}|\*{3,}|_{3,}|=+)$/.test(trimmed)) continue;
    if (/^\s*\[[^\]]+\]:\s*\S+/.test(trimmed)) continue;
    if (/^<[^>]+>$/.test(trimmed)) continue;

    // Preserve human-facing labels and inline identifiers, never destinations.
    trimmed = stripMarkdownLinkDestinations(trimmed);
    trimmed = trimmed.replace(/`{1,2}([^`]+)`{1,2}/g, "$1");
    trimmed = trimmed.replace(/^#{1,6}\s+/, "");
    trimmed = trimmed.replace(/^(?:>|[-+*]|\d+[.)])\s+/, "");
    trimmed = trimmed.replace(/<[^>]+>/g, " ");
    trimmed = trimmed.replace(/[|]+/g, " ");
    trimmed = trimmed.replace(/\s+/g, " ").trim();
    if (trimmed) projected.push(trimmed);
  }

  const text = projected.join(" ").replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  if (truncationInfo) truncationInfo.truncated = text.length > MARKDOWN_CONTENT_MAX_CHARS;
  return truncateUnicodeSafe(text, MARKDOWN_CONTENT_MAX_CHARS);
}

// Fragment text is intentionally not an IndexDocument field. IndexDocument is
// an adapter/search payload boundary; this is an internal, derived index input
// that is persisted separately by the entries repository for deterministic FTS
// rebuilds. The WeakMap follows the already-read document through recognition
// without making safe body bytes observable through public payloads.
const markdownFragmentContentByEntry = new WeakMap<IndexDocument, string>();
const markdownFragmentProjectionEntries = new WeakSet<IndexDocument>();

export function setMarkdownFragmentContent(entry: IndexDocument, content: string | undefined): void {
  markdownFragmentProjectionEntries.add(entry);
  if (content) markdownFragmentContentByEntry.set(entry, content);
}

export function getMarkdownFragmentContent(entry: IndexDocument): string | undefined {
  return markdownFragmentContentByEntry.get(entry);
}

export function hasMarkdownFragmentContent(entry: IndexDocument): boolean {
  return markdownFragmentProjectionEntries.has(entry);
}

/**
 * Produce a safe, structure-preserving projection for fragment indexing.
 * Excluded source lines are retained as blank lines so fragment locations map
 * exactly to authored line numbers. This must be called from both indexing and
 * `show`; it deliberately never performs a storage-layer file reread.
 */
export function projectMarkdownFragmentContent(raw: string): string | undefined {
  const lines = raw.split(/\r?\n/);
  const parsed = parseFrontmatter(raw);
  const start = parsed.frontmatter ? parsed.bodyStartLine - 1 : 0;
  const projected = lines.map(() => "");
  let fence: MarkdownFence | undefined;
  const htmlComment = { inComment: false };
  for (let index = start; index < lines.length; index++) {
    const rawLine = lines[index]!;
    if (fence) {
      if (isMarkdownFenceClosing(rawLine, fence)) fence = undefined;
      continue;
    }
    if (!htmlComment.inComment) {
      const opening = parseMarkdownFenceOpening(rawLine);
      if (opening) {
        fence = opening;
        continue;
      }
    }
    let safe = stripMarkdownHtmlComments(rawLine, htmlComment);
    const opening = parseMarkdownFenceOpening(safe.trim());
    if (opening) {
      fence = opening;
      continue;
    }
    // Reference link destinations and standalone HTML are not retrieval
    // evidence and can contain credential-bearing URLs.
    if (/^\s*\[[^\]]+\]:\s*\S+/.test(safe) || /^\s*<[^>]+>\s*$/.test(safe)) continue;
    safe = stripMarkdownLinkDestinations(safe).replace(/<[^>]+>/g, " ");
    projected[index] = safe.replace(/[ \t]+$/g, "");
  }
  const text = projected.join("\n");
  return text.trim() ? text : undefined;
}

// ── Metadata Generation ─────────────────────────────────────────────────────

/**
 * Priorities 1-2 of the metadata pipeline — package.json (P1), `.md`
 * frontmatter (P2), and script `@param`/comment metadata (P2b) — everything
 * that runs BEFORE the renderer-contributor step (P3). Extracted (Chunk 5 M-b)
 * so the `akm` adapter's synchronous `recognize` shares this exact assembly
 * with the live index-drain path; the two differ ONLY in how they obtain the
 * P3 renderer metadata (the adapter uses the synchronous
 * `foldRecognizedMetadata`), guaranteeing P1/P2/P4 parity by construction.
 * Behavior-preserving: this is a verbatim lift of the former inline P1/P2/P2b
 * block. Mutates `entry` in place.
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
    // D2 (#730): reread the namespaced `provenance:` block promoteProposal stamps.
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
          // Unconditional, not warnVerbose: this bound now sits far past any
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
    const scriptParams = extractScriptParameters(file, content);
    if (scriptParams) entry.parameters = scriptParams;
    applyCommentMetadata(entry, extractCommentMetadata(file, content));
  }
}

/**
 * Priority 4 of the metadata pipeline — filename-heuristic fallbacks (P4) that
 * run AFTER the renderer-contributor step (P3): a filename description when none
 * was set, path/dir-derived tags, tag normalization, and alias generation.
 * Extracted (Chunk 5 M-b) alongside {@link applyPreContributorFields} so both
 * pipeline paths share it. Behavior-preserving verbatim lift. Mutates `entry`.
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

  // Stash-organization conventions (SPEC-2): directory (scope/domain) tokens
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
  // fix-ranking-derived-outranks-primary: `.derived` is a structural marker
  // on a memory's OWN filename (memory-inference.ts's `derivedChildPath`/
  // `isDerivedByName` convention: `<parent>.derived.md`), not a topical
  // word — `extractTagsFromPath` above tokenizes on `.` alongside `-`/`_`,
  // so every derived twin's filename contributes a "derived" tag purely as
  // an artifact of that convention (kept in `entry.tags` itself; only the
  // ALIAS input below is filtered, so anything else keyed on the raw tag
  // set is unaffected). Left in, `buildAliases`' tags.join(" ") mints a
  // SYNTHETIC "<base> derived" alias purely because tags.length > 1, which
  // then wins `alias-ranking` credit any time the base name is a query
  // token — see `exactNameRankingContributor`, which already strips this
  // exact suffix before treating a derived twin's name as content, for the
  // identical reason. Scoped to memory so a coincidentally
  // ".derived"-suffixed asset of another type is untouched.
  const aliasTagInput =
    entry.type === "memory" && canonicalName.toLowerCase().endsWith(".derived")
      ? entry.tags.filter((tag) => tag !== "derived")
      : entry.tags;
  entry.aliases = mergeAliases(entry.aliases, buildAliases(canonicalName, aliasTagInput));

  // Search hints are only generated when LLM is configured (via enhanceStashWithLlm)
  // Heuristic search hints are too noisy to be useful for search quality

  entry.filename = path.basename(file);
}

// The pre-0.9.0 flat-walk matcher-pass metadata source was DELETED in Chunk 5
// F4a M-core-3. Its role (recognize a stash root's files into durable entries)
// is now the `akm` adapter's `recognize`, drained by `indexer/scan/drain-dir.ts`
// (`drainDirDocuments` for the live indexer, `recognizeStashEntries` for the
// `manifest` fallback / `registry` index builder / metadata unit tests). The
// flip is the F4 engine swap; the shadow-parity gate proved recognize produced
// the identical entries before the old pass was removed.

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

function normalizeTerms(values: string[]): string[] {
  const normalized = new Set<string>();
  for (const value of values) {
    const cleaned = value.toLowerCase().replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
    if (!cleaned) continue;
    normalized.add(cleaned);
    // De-pluralization heuristic removed: the FTS5 porter stemmer (configured
    // with `tokenize='porter unicode61'`) handles stemming correctly, including
    // edge cases like "kubernetes" and "status" that the naive s-strip mangled.
  }
  return Array.from(normalized);
}

function buildAliases(name: string, tags: string[]): string[] {
  const aliases = new Set<string>();
  const spaced = name.replace(/[-_]+/g, " ").trim().toLowerCase();
  if (spaced && spaced !== name.toLowerCase()) aliases.add(spaced);
  if (tags.length > 1) aliases.add(tags.join(" "));
  return Array.from(aliases);
}

export function extractDescriptionFromComments(filePath: string): string | null {
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }

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
    } else if (line === "") {
    } else {
      break;
    }
  }
  if (hashLines.length > 0) return hashLines.join(" ");

  return null;
}

export function extractPackageMetadata(
  dirPath: string,
): { name?: string; description?: string; keywords?: string[] } | null {
  const pkgPath = path.join(dirPath, "package.json");
  if (!fs.existsSync(pkgPath)) return null;
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    const result: { name?: string; description?: string; keywords?: string[] } = {};
    if (typeof pkg.name === "string") result.name = pkg.name;
    if (typeof pkg.description === "string") result.description = pkg.description;
    if (Array.isArray(pkg.keywords)) {
      result.keywords = pkg.keywords.filter((k: unknown): k is string => typeof k === "string");
    }
    return Object.keys(result).length > 0 ? result : null;
  } catch {
    return null;
  }
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
 * into exact-tag matching (SPEC-2, docs/architecture/specs/stash-conventions-code-spec.md).
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
