// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Embedding units, derived from what the index already computed for an
 * entry: its search fields (`buildSearchFields`) and its Markdown fragments
 * (`splitMarkdownFragments`). Module A1 of
 * docs/plans/index-units-contract.md — the design is
 * docs/plans/index-fragment-vectors.md.
 *
 * An entry always has exactly one structured-fields unit (ordinal 0); an
 * entry with Markdown content additionally has one unit per fragment, in
 * fragment order. A unit whose text would exceed the caller's `maxChars` is
 * split into ordinal sub-units that all share its `fragmentId`. Nothing is
 * ever truncated.
 */
import type { AssetParameter } from "../../core/adapter/types";
import { parseMarkdownToc } from "../../core/asset/markdown";
import { type MarkdownFragment, splitMarkdownFragments } from "../../core/asset/markdown-fragments";
import { hashEmbeddableText } from "../../core/hash";
import { getMarkdownFragmentContent, hasMarkdownFragmentContent, type IndexDocument } from "../passes/metadata";
import { buildSearchFields } from "../search/search-fields";

/**
 * Separator between the entry name and a fragment's section title in a unit
 * header — the exact format the contract specifies, kept as one named
 * constant so every header is built the same way.
 */
const UNIT_HEADER_SECTION_SEPARATOR = " › ";

export interface EmbeddingUnit {
  entryId: number;
  /** 0 is the structured-fields unit every entry has; fragment units follow in fragment order. */
  ordinal: number;
  /** MarkdownFragment.fragmentId for a fragment unit (sub-units share it); null for ordinal 0. */
  fragmentId: string | null;
  /** hashEmbeddableText(text) — sha256 hex of exactly the text sent to the provider. */
  hash: string;
  /** Header line, "\n", body. Header = entry name, then " › " + section title for a fragment. */
  text: string;
}

export interface UnitSource {
  entryId: number;
  name: string;
  description: string;
  tags: string;
  hints: string;
  /**
   * Parameter name/description lines, one per parameter, in declaration
   * order — `name` alone, or `name: description` when the parameter has
   * one — or `""` when the entry declares none. Kept as its own field
   * (rather than folded into `hints`) so `structuredFieldsText` can place it
   * last, after hints (index-redesign B5g) — restoring, for the card unit,
   * the parameter coverage the old per-entry `entries_fts.content` column
   * used to give search before the redesign. TOC headings are deliberately
   * NOT carried here; they reach fragment units as their header line
   * whenever a fragment starts on one.
   */
  parameters: string;
  /** entry_fragments.safe_markdown, or null for an entry without markdown content. */
  safeMarkdown: string | null;
}

/** Unit 0's body: description, tags, hints, parameters — the non-empty ones, one per line, in that order. */
function structuredFieldsText(source: UnitSource): string {
  const body = [source.description, source.tags, source.hints, source.parameters]
    .filter((field) => field.length > 0)
    .join("\n");
  return `${source.name}\n${body}`;
}

/**
 * One line per parameter — `name`, or `name: description` when the
 * parameter has a description — lowercased to match `buildSearchFields`'s
 * other structured fields (`units_fts` is case-insensitive either way; this
 * keeps the card unit's casing uniform). `""` when `parameters` is absent or
 * empty, so `structuredFieldsText`'s filter drops it cleanly.
 */
function parametersText(parameters: readonly AssetParameter[] | undefined): string {
  if (!parameters || parameters.length === 0) return "";
  return parameters
    .map((param) => (param.description ? `${param.name}: ${param.description}` : param.name))
    .join("\n")
    .toLowerCase();
}

function fragmentHeaderText(name: string, sectionTitle: string | null): string {
  return sectionTitle ? `${name}${UNIT_HEADER_SECTION_SEPARATOR}${sectionTitle}` : name;
}

/**
 * The section title standing over each fragment, in fragment order: a
 * fragment's own first heading line when it starts with one, else the
 * nearest heading at or before it (tracked while scanning fragments in
 * document order), else `null`. Reuses `parseMarkdownToc`, the same heading
 * list `splitMarkdownFragments` derives its section boundaries from, so a
 * "#" inside a fenced code block is never mistaken for a real heading.
 */
function fragmentSectionTitles(safeMarkdown: string, fragments: readonly MarkdownFragment[]): (string | null)[] {
  const headings = parseMarkdownToc(safeMarkdown).headings;
  let headingIndex = 0;
  let current: string | null = null;
  return fragments.map((fragment) => {
    while (headingIndex < headings.length && headings[headingIndex]!.line <= fragment.startLine) {
      current = headings[headingIndex]!.text;
      headingIndex++;
    }
    return current;
  });
}

/**
 * Split `text` into pieces no longer than `maxChars`: cut at the last "\n"
 * before the bound, else the last space, else hard-split a single unbroken
 * run (e.g. a URL) so every piece still respects the bound and the loop
 * always terminates. The cut character itself is dropped, not carried by
 * either side.
 */
function splitOverflowingText(text: string, maxChars: number): string[] {
  const pieces: string[] = [];
  let rest = text;
  while (rest.length > maxChars) {
    const window = rest.slice(0, maxChars);
    const newlineCut = window.lastIndexOf("\n");
    if (newlineCut > 0) {
      pieces.push(rest.slice(0, newlineCut));
      rest = rest.slice(newlineCut + 1);
      continue;
    }
    const spaceCut = window.lastIndexOf(" ");
    if (spaceCut > 0) {
      pieces.push(rest.slice(0, spaceCut));
      rest = rest.slice(spaceCut + 1);
      continue;
    }
    pieces.push(rest.slice(0, maxChars));
    rest = rest.slice(maxChars);
  }
  if (rest.length > 0) pieces.push(rest);
  return pieces;
}

/**
 * maxChars bounds every unit's text; a unit over it is split at the last
 * "\n" (else the last space) before the bound into sub-units that keep the
 * source fragmentId and take the next ordinals.
 */
export function deriveUnits(source: UnitSource, maxChars: number): EmbeddingUnit[] {
  if (!Number.isFinite(maxChars) || maxChars <= 0) {
    throw new RangeError("deriveUnits: maxChars must be a positive finite number");
  }

  const units: EmbeddingUnit[] = [];
  let ordinal = 0;
  const pushUnit = (fragmentId: string | null, text: string): void => {
    units.push({ entryId: source.entryId, ordinal: ordinal++, fragmentId, hash: hashEmbeddableText(text), text });
  };

  for (const text of splitOverflowingText(structuredFieldsText(source), maxChars)) pushUnit(null, text);

  if (source.safeMarkdown != null) {
    const fragments = splitMarkdownFragments(source.safeMarkdown);
    const sectionTitles = fragmentSectionTitles(source.safeMarkdown, fragments);
    fragments.forEach((fragment, index) => {
      const header = fragmentHeaderText(source.name, sectionTitles[index] ?? null);
      const text = `${header}\n${fragment.text}`;
      for (const piece of splitOverflowingText(text, maxChars)) pushUnit(fragment.fragmentId, piece);
    });
  }

  return units;
}

/**
 * `UnitSource` from an already-parsed `IndexDocument` — `buildSearchFields`
 * for the structured fields, the entry's own carried markdown for fragments.
 * Shared by `reconcile.ts` (a freshly-parsed entry) and `enrich.ts` (the same
 * entry merged with LLM-enriched description/tags/searchHints, index-redesign
 * B5e) — a leaf in `units/`, not either caller, so importing it never creates
 * a reconcile.ts ↔ enrich.ts cycle.
 *
 * `hasMarkdownFragmentContent`/`getMarkdownFragmentContent` is the `akm`
 * adapter's own line-structure-preserving fragment projection
 * (`applyPreContributorFields`, gated `.md`-only and excluding sensitive
 * types), set during `recognize` and present ONLY for that adapter (or a
 * caller that re-tags a derived copy via `setMarkdownFragmentContent`, as
 * `enrich.ts` does). Every other adapter (`okf`, ...) never calls it, so
 * `hasMarkdownFragmentContent` is always false for their entries — falling
 * straight to `null` here would leave their body content in `entries_fts`'s
 * single per-entry `content` column (`buildSearchFields`, unconditional) but
 * in NO unit at all, an asymmetry that would silently blank a whole
 * adapter's fragment search once unit coverage is complete
 * (index-redesign-contract.md B3). `entry.content` — the same field already
 * surfaced through search hits and `show`, so already that adapter's own
 * public-safe projection — is the fallback fragment source for exactly this
 * case.
 */
export function toUnitSource(entryId: number, entry: IndexDocument): UnitSource {
  const fields = buildSearchFields(entry);
  const safeMarkdown = hasMarkdownFragmentContent(entry)
    ? (getMarkdownFragmentContent(entry) ?? null)
    : typeof entry.content === "string" && entry.content.trim()
      ? entry.content
      : null;
  return {
    entryId,
    name: fields.name,
    description: fields.description,
    tags: fields.tags,
    hints: fields.hints,
    parameters: parametersText(entry.parameters),
    safeMarkdown,
  };
}
