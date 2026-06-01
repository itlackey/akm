// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fs from "node:fs";
import path from "node:path";
import {
  deriveCanonicalAssetName,
  deriveCanonicalAssetNameFromStashRoot,
  isRelevantAssetFile,
} from "../core/asset-spec";
import { asNonEmptyString, isAssetType, writeFileAtomic } from "../core/common";
import { parseFrontmatter } from "../core/frontmatter";
import type { TocHeading } from "../core/markdown";
import { isVerbose, warn } from "../core/warn";
import { buildFileContext, buildRenderContext, getRenderer, runMatchers } from "./file-context";
import { applyMetadataContributors } from "./metadata-contributors";

// ── Schema ──────────────────────────────────────────────────────────────────

export interface StashIntent {
  when?: string;
  input?: string;
  output?: string;
}

export interface AssetParameter {
  name: string;
  type?: string;
  description?: string;
  required?: boolean;
  default?: string;
}

/**
 * Multi-tenant / multi-agent scope keys. All four fields are optional;
 * persisted as the canonical top-level frontmatter keys
 * `scope_user`, `scope_agent`, `scope_run`, `scope_channel`.
 *
 * This shape is the wire-level scope contract — the CLI's `--user`,
 * `--agent`, `--run`, `--channel` flags map into these fields, and
 * `akm search --filter user=…` queries against them.
 *
 * Memories written before scope flags shipped have no scope keys at all;
 * unfiltered queries continue to surface them.
 */
export interface StashEntryScope {
  user?: string;
  agent?: string;
  run?: string;
  channel?: string;
}

/** Allowed keys in `--filter k=v` and `--scope k=v` flags. */
export type ScopeKey = keyof StashEntryScope;

export const SCOPE_KEYS: readonly ScopeKey[] = ["user", "agent", "run", "channel"] as const;

export interface StashEntry {
  name: string;
  type: string;
  description?: string;
  tags?: string[];
  examples?: string[];
  searchHints?: string[];
  intent?: StashIntent;
  filename?: string;
  /**
   * Asset quality marker (v1 spec §4.2). Four values are well-known:
   * `"generated"` and `"curated"` are included in default search;
   * `"enriched"` marks entries that have been LLM-enhanced (also included in
   * default search, excluded from re-enrichment unless `--re-enrich` is set);
   * `"proposed"` is excluded from default search and surfaced only with
   * `--include-proposed`. Unknown string values parse with a one-time
   * `console.warn` and remain searchable (treated as included-by-default).
   */
  quality?: "generated" | "curated" | "enriched" | "proposed" | (string & {});
  confidence?: number;
  source?: "package" | "frontmatter" | "comments" | "filename" | "manual" | "llm";
  aliases?: string[];
  toc?: TocHeading[];
  usage?: string[];
  /** How to run this asset (e.g. "bash deploy.sh", "bun run.ts") */
  run?: string;
  /** Setup command to run before execution (e.g. "bun install") */
  setup?: string;
  /** Working directory for execution */
  cwd?: string;
  /** File size in bytes for output sizing hints */
  fileSize?: number;
  /** Structured parameter definitions extracted from the asset content */
  parameters?: AssetParameter[];
  /**
   * Multi-tenant / multi-agent scope. Populated from the canonical
   * `scope_user`, `scope_agent`, `scope_run`, `scope_channel`
   * frontmatter keys. Used by `akm search --filter` and
   * `akm show --scope`.
   */
  scope?: StashEntryScope;
  /**
   * Wiki role for knowledge pages following the LLM Wiki pattern.
   * `schema` / `index` / `log` are the special files at the top of the wiki;
   * `raw` marks immutable ingested sources; `page` (default) is an LLM-authored page.
   */
  wikiRole?: "schema" | "index" | "log" | "raw" | "page";
  /**
   * Page archetype for wiki pages. Any non-empty string is accepted so users
   * can introduce categories freely (e.g. `entity`, `concept`, `question`,
   * `note`, `decision-record`). Wiki conventions live in `schema.md`.
   */
  pageKind?: string;
  /** Cross-references to other knowledge entries by ref (e.g. "knowledge:auth-design"). */
  xrefs?: string[];
  /** Source identifiers this page was distilled from (typically `raw/<slug>` files). */
  sources?: string[];
  beliefState?: "active" | "asserted" | "deprecated" | "superseded" | "contradicted" | "archived" | (string & {});
  supersededBy?: string[];
  contradictedBy?: string[];
  currentBeliefRefs?: string[];
  /**
   * How the memory was captured. `hot` indicates a user-driven write
   * (the `akm remember` CLI path); `background` indicates an
   * agent/derived write (e.g. memory-inference). Absent on legacy memories.
   * Surfaced from the `captureMode:` frontmatter key.
   */
  captureMode?: "hot" | "background";
  /**
   * Free-form guidance describing when this asset should be applied.
   * Surfaced from the `when_to_use:` frontmatter key. Indexed into the
   * `hints` FTS column so retrieval can match query intent.
   */
  whenToUse?: string;
  /**
   * Strength signal for lessons: count of refs that have credited this
   * lesson via `akm feedback --applied-to`. Extracted from frontmatter:
   * an array stores its length here, a number stores directly.
   */
  lessonStrength?: number;
  /**
   * Source refs that this asset is derived from. Surfaced from the
   * `evidenceSources:` frontmatter key.
   */
  evidenceSources?: string[];
  /**
   * For derived memories (Phase 5A / Advantage D5), the parent ref that this
   * entry was distilled from. Surfaced from the `source:` frontmatter key
   * (form: `"memory:<parent-name>"`) when the entry is recognized as a
   * derived child (either by frontmatter `inferred: true` or by name suffix
   * `.derived`). Absent on non-derived entries.
   *
   * The indexer mirrors this value into the dedicated `entries.derived_from`
   * column so `getDerivedForParent()` can resolve the child by parent ref
   * without a full table scan.
   */
  derivedFrom?: string;
}

export interface StashFile {
  entries: StashEntry[];
  warnings?: string[];
}

export interface LegacyStashLoadOptions {
  requireFilename?: boolean;
}

// ── Load / Write ────────────────────────────────────────────────────────────

const STASH_FILENAME = ".stash.json";

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

export function stashFilePath(dirPath: string): string {
  return path.join(dirPath, STASH_FILENAME);
}

export function loadStashFile(dirPath: string, options?: LegacyStashLoadOptions): StashFile | null {
  const filePath = stashFilePath(dirPath);
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!raw || !Array.isArray(raw.entries)) return null;
    const entries: StashEntry[] = [];
    for (const e of raw.entries) {
      const validated = validateStashEntry(e);
      if (validated) {
        if (options?.requireFilename && !validated.filename) continue;
        entries.push(validated);
      } else {
        const name =
          typeof e === "object" && e !== null && typeof (e as Record<string, unknown>).name === "string"
            ? (e as Record<string, unknown>).name
            : "(unknown)";
        warn(`Warning: Skipping invalid entry "${name}" in ${filePath}`);
      }
    }
    return entries.length > 0 ? { entries } : null;
  } catch {
    return null;
  }
}

export function writeStashFile(dirPath: string, stash: StashFile): void {
  const filePath = stashFilePath(dirPath);
  writeFileAtomic(filePath, `${JSON.stringify(stash, null, 2)}\n`);
}

/**
 * Validate and normalize a raw object into a `StashEntry`.
 *
 * **Ordering dependency:** Uses `isAssetType()` to check `entry.type`, which
 * only recognizes custom types registered via `registerAssetType()`. If this
 * function is called before custom types are registered, those entries will be
 * rejected as invalid.
 */
export function validateStashEntry(entry: unknown): StashEntry | null {
  if (typeof entry !== "object" || entry === null) return null;
  const e = entry as Record<string, unknown>;
  if (typeof e.name !== "string" || !e.name) return null;
  if (typeof e.type !== "string" || !isAssetType(e.type)) return null;

  const result: StashEntry = {
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
    result.source = e.source as StashEntry["source"];
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
  if (typeof e.beliefState === "string" && e.beliefState.trim().length > 0) {
    result.beliefState = e.beliefState.trim() as StashEntry["beliefState"];
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
  if (typeof e.derivedFrom === "string" && e.derivedFrom.trim().length > 0) {
    result.derivedFrom = e.derivedFrom.trim();
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
export function applyScopeFrontmatter(entry: StashEntry, fmData: Record<string, unknown>): void {
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

export function applyCuratedFrontmatter(entry: StashEntry, fmData: Record<string, unknown>): void {
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

  const beliefState = asNonEmptyString(fmData.beliefState);
  if (beliefState) entry.beliefState = beliefState as StashEntry["beliefState"];

  const supersededBy = normalizeStringListOrUndefined(fmData.supersededBy);
  if (supersededBy) entry.supersededBy = supersededBy;

  const contradictedBy = normalizeStringListOrUndefined(fmData.contradictedBy);
  if (contradictedBy) entry.contradictedBy = contradictedBy;

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
  // Memory-inference writes `source: "memory:<parent>"` and `inferred: true`
  // (and a derived child name suffix `.derived`). We mirror that source ref
  // into `entry.derivedFrom` so the indexer can populate the dedicated
  // `derived_from` column. Non-derived entries leave this field unset.
  if (entry.type === "memory") {
    const isDerivedByName = entry.name.toLowerCase().endsWith(".derived");
    const isDerivedByFm = fmData.inferred === true;
    if (isDerivedByName || isDerivedByFm) {
      const sourceStr = asNonEmptyString(fmData.source);
      if (sourceStr?.includes(":")) {
        entry.derivedFrom = sourceStr;
      } else {
        // Fallback: some legacy renderings store only `derivedFrom: <name>`
        // (a bare parent name). Promote it to a `memory:` ref so the lookup
        // column stays consistent.
        const derivedFromName = asNonEmptyString(fmData.derivedFrom);
        if (derivedFromName) {
          entry.derivedFrom = derivedFromName.includes(":") ? derivedFromName : `memory:${derivedFromName}`;
        }
      }
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
    const name = match[1];
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
export function applyWikiFrontmatter(entry: StashEntry, fmData: Record<string, unknown>): void {
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

const WIKI_INFRA_FILES = new Set(["schema.md", "index.md", "log.md"]);

/**
 * Apply wiki-specific index exclusions while leaving all other stash files
 * untouched.
 *
 * - In a normal stash, excludes wiki-root `schema.md`, `index.md`, `log.md`.
 * - In a wiki-root stash source (`wikiName`), excludes those same root-level
 *   infrastructure files.
 */
export function shouldIndexStashFile(
  stashRoot: string,
  file: string,
  options?: { treatStashRootAsWikiRoot?: boolean },
): boolean {
  const relPath = path.relative(stashRoot, file);
  if (!relPath || relPath.startsWith("..") || path.isAbsolute(relPath)) return true;

  const segments = relPath.split(/[\\/]+/).filter(Boolean);
  if (segments.length === 0) return true;

  // Skip vault .env files that have a sibling .sensitive marker file.
  if (segments[0] === "vaults" && (file.endsWith(".env") || path.basename(file) === ".env")) {
    const markerPath = file.replace(/\.env$/, ".sensitive");
    if (fs.existsSync(markerPath)) return false;
  }

  // Skip secret files that are themselves a `.sensitive` marker, or that have a
  // sibling `<name>.sensitive` marker. Secrets are otherwise indexed by name
  // only (their bytes are never read — see buildEntryFromFile guards).
  if (segments[0] === "secrets") {
    if (file.endsWith(".sensitive") || file.endsWith(".lock")) return false;
    if (fs.existsSync(`${file}.sensitive`)) return false;
  }

  if (options?.treatStashRootAsWikiRoot) {
    return !(segments.length === 1 && WIKI_INFRA_FILES.has(segments[0]));
  }

  const wikisIdx = segments.indexOf("wikis");
  if (wikisIdx < 0 || wikisIdx + 1 >= segments.length) return true;

  const wikiRelativeSegments = segments.slice(wikisIdx + 2);
  if (wikiRelativeSegments.length === 0) return true;
  return !(wikiRelativeSegments.length === 1 && WIKI_INFRA_FILES.has(wikiRelativeSegments[0]));
}

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
      const param: AssetParameter = { name: match[2] };
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
  const value = intentMatch[2].trim();
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
      metadata.description = descMatch[1].trim();
      continue;
    }

    const tagsMatch = cleaned.match(/^@tags?\s+(.+)$/);
    if (tagsMatch) {
      metadata.tags = splitCommentList(tagsMatch[1]);
      continue;
    }

    const aliasesMatch = cleaned.match(/^@aliases?\s+(.+)$/);
    if (aliasesMatch) {
      metadata.aliases = splitCommentList(aliasesMatch[1]);
      continue;
    }

    const hintsMatch = cleaned.match(/^@searchHints?\s+(.+)$/);
    if (hintsMatch) {
      metadata.searchHints = splitCommentList(hintsMatch[1]);
      continue;
    }

    const usageMatch = cleaned.match(/^@usage\s+(.+)$/);
    if (usageMatch) {
      metadata.usage = [...(metadata.usage ?? []), usageMatch[1].trim()];
      continue;
    }

    const examplesMatch = cleaned.match(/^@examples?\s+(.+)$/);
    if (examplesMatch) {
      metadata.examples = [...(metadata.examples ?? []), examplesMatch[1].trim()];
      continue;
    }

    const runMatch = cleaned.match(/^@run\s+(.+)$/);
    if (runMatch) {
      metadata.run = runMatch[1].trim();
      continue;
    }

    const setupMatch = cleaned.match(/^@setup\s+(.+)$/);
    if (setupMatch) {
      metadata.setup = setupMatch[1].trim();
      continue;
    }

    const cwdMatch = cleaned.match(/^@cwd\s+(.+)$/);
    if (cwdMatch) {
      metadata.cwd = cwdMatch[1].trim();
      continue;
    }

    const scopeMatch = cleaned.match(/^@scope\s+(.+)$/);
    if (scopeMatch) {
      const scope = parseCommentScope(scopeMatch[1]);
      if (scope) metadata.scope = scope;
    }
  }

  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

export function applyCommentMetadata(entry: StashEntry, metadata: CommentMetadata | undefined): void {
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
 * Pass `reEnrich = true` in the caller to bypass this check.
 */
export function isEnrichmentComplete(entry: StashEntry): boolean {
  const hasDescription = typeof entry.description === "string" && entry.description.trim().length > 0;
  const hasTags = Array.isArray(entry.tags) && entry.tags.length > 0;
  const hasSearchHints = Array.isArray(entry.searchHints) && entry.searchHints.length > 0;
  return hasDescription && hasTags && hasSearchHints;
}

// ── Metadata Generation ─────────────────────────────────────────────────────

/**
 * Shared pipeline (steps 2-6) for building a single StashEntry from a file.
 *
 * Both `generateMetadata` and `generateMetadataFlat` perform identical work
 * once the initial `entry` object has been seeded with type and canonical name.
 * This helper encapsulates that shared pipeline so the two callers only differ
 * in how they determine the asset type and canonical name (step 1):
 *
 *  - `generateMetadata`     — explicit `assetType` arg + `deriveCanonicalAssetName`
 *  - `generateMetadataFlat` — type from `runMatchers()` + `deriveCanonicalAssetNameFromStashRoot`
 *
 * @param file        Absolute path to the file being processed.
 * @param assetType   Resolved asset type string (already validated by caller).
 * @param canonicalName Resolved canonical name (already computed by caller).
 * @param dirPath     Directory containing the file (used for tag fallback).
 * @param pkgMeta     Pre-loaded package.json metadata for this directory (may be null/undefined).
 * @param stashRoot   Stash root used for renderer search hints context.
 * @param ctx         FileContext for the file (may be pre-built by the caller).
 * @param match       Pre-resolved MatchResult when available (from `generateMetadataFlat`).
 * @returns The populated entry, or `{ skip: true, warning: string }` when the
 *          renderer throws and the file should be dropped.
 */
async function buildEntryFromFile(
  file: string,
  assetType: string,
  canonicalName: string,
  dirPath: string,
  pkgMeta: ReturnType<typeof extractPackageMetadata> | undefined,
  stashRoot: string,
  ctx: ReturnType<typeof buildFileContext>,
  match: import("./file-context").MatchResult | null,
): Promise<StashEntry | { skip: true; warning: string }> {
  const ext = path.extname(file).toLowerCase();
  const baseName = path.basename(file, ext);

  const entry: StashEntry = {
    name: canonicalName,
    type: assetType,
    quality: "generated",
    confidence: 0.55,
    source: "filename",
  };

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
  if (ext === ".md" && assetType !== "secret") {
    const content = ctx.content();
    const parsed = parseFrontmatter(content);
    applyCuratedFrontmatter(entry, parsed.data);
    // Extract parameters from frontmatter params: key
    const fmParams = extractFrontmatterParameters(parsed.data);
    if (fmParams) entry.parameters = fmParams;
    // Pass wiki-pattern frontmatter through onto the entry
    applyWikiFrontmatter(entry, parsed.data);
    // Extract parameters from template placeholders ($1, $ARGUMENTS, {{named}})
    if (entry.type === "command") {
      const cmdParams = extractCommandParameters(parsed.content);
      if (cmdParams) {
        entry.parameters = mergeParameters(entry.parameters, cmdParams);
      }
    }
  }

  // Extract @param from script files.
  // Vault files (.env) and secret files (whole-file secrets) are deliberately
  // excluded — their contents are secrets and must never be parsed for @param
  // or any other metadata that could embed a value into the entry.
  if (ext !== ".md" && assetType !== "vault" && assetType !== "secret") {
    const content = ctx.content();
    const scriptParams = extractScriptParameters(file, content);
    if (scriptParams) entry.parameters = scriptParams;
    applyCommentMetadata(entry, extractCommentMetadata(file, content));
  }

  // Priority 3: Renderer metadata extraction
  // When no pre-resolved match is available (generateMetadata path), run
  // matchers now so the renderer can extract type-specific metadata.
  const resolvedMatch = match ?? (await runMatchers(ctx));
  if (resolvedMatch) {
    const renderer = await getRenderer(resolvedMatch.renderer);
    if (renderer) {
      const renderCtx = buildRenderContext(ctx, resolvedMatch, [stashRoot]);
      try {
        await applyMetadataContributors(entry, {
          rendererName: renderer.name,
          renderContext: renderCtx,
        });
      } catch (error) {
        return {
          skip: true,
          warning: buildMetadataSkipWarning(file, assetType, error),
        };
      }
    }
  }

  // Priority 4: Filename heuristics (fallback)
  if (!entry.description) {
    entry.description = fileNameToDescription(baseName);
    entry.source = "filename";
    entry.confidence = Math.min(entry.confidence ?? 0.55, 0.55);
  }
  if (!entry.tags || entry.tags.length === 0) {
    entry.tags = extractTagsFromPath(file, dirPath);
  }

  entry.tags = normalizeTerms(entry.tags ?? []);
  entry.aliases = mergeAliases(entry.aliases, buildAliases(canonicalName, entry.tags));

  // Search hints are only generated when LLM is configured (via enhanceStashWithLlm)
  // Heuristic search hints are too noisy to be useful for search quality

  entry.filename = path.basename(file);
  return entry;
}

export async function generateMetadata(
  dirPath: string,
  assetType: string,
  files: string[],
  typeRoot = dirPath,
): Promise<StashFile> {
  const entries: StashEntry[] = [];
  const warnings: string[] = [];
  const pkgMeta = extractPackageMetadata(dirPath);

  for (const file of files) {
    const ext = path.extname(file).toLowerCase();
    const baseName = path.basename(file, ext);
    const fileName = path.basename(file);

    // Skip non-relevant files
    if (!isRelevantAssetFile(assetType, fileName)) continue;

    const canonicalName = deriveCanonicalAssetName(assetType, typeRoot, file) ?? baseName;

    // Build file context with typeRoot as the stash root so renderer context
    // and search hints are scoped to the type directory.
    const fileCtx = buildFileContext(typeRoot, file);

    // Step 1: type is explicit; delegate steps 2-6 to the shared pipeline.
    const result = await buildEntryFromFile(file, assetType, canonicalName, dirPath, pkgMeta, typeRoot, fileCtx, null);
    if ("skip" in result) {
      warnings.push(result.warning);
      continue;
    }
    entries.push(result);
  }

  return warnings.length > 0 ? { entries, warnings } : { entries };
}

/**
 * Generate metadata for files using the matcher system instead of a fixed asset type.
 *
 * This is the flat-walk counterpart of `generateMetadata`. It classifies each
 * file via `runMatchers()` and uses the matched type for canonical naming.
 * Files that no matcher claims are silently skipped.
 */
export async function generateMetadataFlat(stashRoot: string, files: string[]): Promise<StashFile> {
  const entries: StashEntry[] = [];
  const warnings: string[] = [];
  const pkgMetaCache = new Map<string, ReturnType<typeof extractPackageMetadata>>();

  for (const file of files) {
    if (!shouldIndexStashFile(stashRoot, file)) continue;

    // Step 1: determine type and canonical name via the matcher system.
    const ctx = buildFileContext(stashRoot, file);
    const match = await runMatchers(ctx);
    if (!match) continue;

    const assetType = match.type;
    if (!isAssetType(assetType)) continue;

    // If the file lives under a known type directory, use that as the root
    // for canonical naming so names don't include the type prefix.
    // e.g. scripts/deploy.sh → "deploy.sh" not "scripts/deploy.sh"
    const ext = path.extname(file).toLowerCase();
    const baseName = path.basename(file, ext);
    const canonicalName = deriveCanonicalAssetNameFromStashRoot(assetType, stashRoot, file) ?? baseName;

    // Resolve package.json metadata with a per-directory cache.
    const dirPath = path.dirname(file);
    if (!pkgMetaCache.has(dirPath)) {
      pkgMetaCache.set(dirPath, extractPackageMetadata(dirPath));
    }
    const pkgMeta = pkgMetaCache.get(dirPath);

    // Steps 2-6: delegate to the shared pipeline; pass the pre-resolved match
    // so we don't run matchers a second time.
    const result = await buildEntryFromFile(file, assetType, canonicalName, dirPath, pkgMeta, stashRoot, ctx, match);
    if ("skip" in result) {
      warnings.push(result.warning);
      continue;
    }
    entries.push(result);
  }

  return warnings.length > 0 ? { entries, warnings } : { entries };
}

function buildMetadataSkipWarning(filePath: string, assetType: string, error: unknown): string {
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
      const line = lines[i];
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
    const line = lines[i].trim();
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
