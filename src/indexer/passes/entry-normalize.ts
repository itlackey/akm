// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { AssetParameter, IndexDocument, ScopeKey, StashEntryScope } from "../../core/adapter/types";
import type { TocHeading } from "../../core/asset/markdown";
import { warn } from "../../core/warn";

export const SCOPE_KEYS: readonly ScopeKey[] = ["user", "agent", "run", "channel"] as const;

/**
 * Coerce a raw `{ user, agent, run, channel }` object into a clean
 * `StashEntryScope`, dropping non-string and empty values. Returns
 * `undefined` when no recognized keys carry a value.
 */
export function normalizeScopeObject(raw: Record<string, unknown>): StashEntryScope | undefined {
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

// ── Quality semantics ───────────────────────────────────────────────────────

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
      `Warning: unknown quality value "${raw}" — entry remains searchable, but consider using "generated", "curated", or "proposed".`,
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
 * entries are excluded from default search.
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
  if (isWikiRole(e.wikiRole)) result.wikiRole = e.wikiRole;
  if (typeof e.pageKind === "string" && e.pageKind.trim().length > 0) {
    result.pageKind = e.pageKind.trim();
  }
  const xrefs = normalizeNonEmptyStringList(e.xrefs);
  if (xrefs) result.xrefs = xrefs;
  const sources = normalizeNonEmptyStringList(e.sources);
  if (sources) result.sources = sources;
  // `category` must survive the projection. Non-string values are
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
  if (typeof e.evidence === "string" && e.evidence.trim().length > 0) result.evidence = e.evidence;
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

export function normalizeNonEmptyStringList(value: unknown): string[] | undefined {
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

export function isWikiRole(value: unknown): value is NonNullable<IndexDocument["wikiRole"]> {
  return value === "schema" || value === "index" || value === "log" || value === "raw" || value === "page";
}

export function normalizeTerms(values: string[]): string[] {
  const normalized = new Set<string>();
  for (const value of values) {
    const cleaned = value.toLowerCase().replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
    if (!cleaned) continue;
    normalized.add(cleaned);
    // No de-pluralization here: the FTS5 porter stemmer (configured with
    // `tokenize='porter unicode61'`) handles stemming correctly, including
    // edge cases like "kubernetes" and "status" that a naive s-strip mangles.
  }
  return Array.from(normalized);
}
