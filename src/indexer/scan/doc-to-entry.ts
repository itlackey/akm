// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `indexDocumentToStashEntry` — the inverse of the `akm` adapter's
 * `indexDocumentFromEntry` (`adapters/akm-adapter.ts`). akm 0.9.0 Chunk 5,
 * milestone F4a (M2 groundwork).
 *
 * The engine swap drains an `IndexDocument` stream (`scanComponent` × the akm
 * adapter's `recognize`) in place of the per-dir `generateMetadataFlat`
 * `StashEntry` stream, then persists it. But the durable `entries.entry_json`
 * column stays a faithful `StashEntry` — every reader (`rowToIndexedEntry` →
 * `DbIndexedEntry.entry`) consumes it as one, and the byte-for-byte goldens pin
 * it. So the persist path must reconstruct the exact `StashEntry` the old
 * pipeline stored FROM the `IndexDocument` the new pipeline produces.
 *
 * That reconstruction is lossless by construction: the akm adapter's `recognize`
 * assembles a full `StashEntry` (P1/P2 → fold → P4) and then maps it onto the
 * `IndexDocument` via `indexDocumentFromEntry` — first-class search/signal fields
 * onto named members, every other search-surface/provenance field onto
 * `documentJson` (the `DOCUMENT_JSON_CARRIED_FIELDS` set). This function reverses
 * that mapping exactly, so `indexDocumentToStashEntry(recognize(file))` deep-
 * equals `generateMetadataFlat`'s entry for the same file (proven by
 * `tests/integration/shadow-scan-parity.test.ts`'s round-trip arm).
 *
 * Two deliberate non-round-trip fields:
 *   - `filename` — dropped by `indexDocumentFromEntry` (no IndexDocument home),
 *     recovered here as `basename(doc.path)`. The old pipeline set it to
 *     `basename(file)` in `applyPostContributorFields`, and `doc.path` IS that
 *     file, so the value is identical.
 *   - `fileSize` — never set by `recognize` NOR by `generateMetadataFlat`; both
 *     pipelines attach it at PERSIST time (`attachFileSize`). It is therefore
 *     intentionally absent here and added by the persist layer, exactly as
 *     before.
 *
 * Pure, type-only imports (no cycle participation).
 */

import path from "node:path";
import type { IndexDocument } from "../../core/adapter/types";
import type { StashEntry, StashEntryScope, StashIntent } from "../passes/metadata";

/**
 * Reconstruct the `StashEntry` an `IndexDocument` was mapped from. First-class
 * IndexDocument members and the `documentJson`-carried extras are both restored;
 * every field is set only when present, matching the old pipeline's
 * "assign-only-when-defined" assembly so the reconstruction deep-equals it.
 */
export function indexDocumentToStashEntry(doc: IndexDocument): StashEntry {
  const dj = (doc.documentJson ?? {}) as Record<string, unknown>;

  const entry: StashEntry = {
    name: doc.name,
    type: doc.type ?? "",
    // Dropped by indexDocumentFromEntry — recovered from the read path (= the
    // basename the old pipeline stored). Always present on a recognized doc.
    filename: path.basename(doc.path),
  };

  // ── First-class IndexDocument members (spec §3) ──
  if (doc.description !== undefined) entry.description = doc.description;
  if (doc.tags !== undefined) entry.tags = doc.tags;
  if (doc.aliases !== undefined) entry.aliases = doc.aliases;
  if (doc.searchHints !== undefined) entry.searchHints = doc.searchHints;
  if (doc.quality !== undefined) entry.quality = doc.quality;
  if (doc.confidence !== undefined) entry.confidence = doc.confidence;
  if (doc.beliefState !== undefined) entry.beliefState = doc.beliefState;
  if (doc.currentBeliefRefs !== undefined) entry.currentBeliefRefs = doc.currentBeliefRefs;
  if (doc.scope !== undefined) entry.scope = doc.scope as StashEntryScope;
  if (doc.captureMode !== undefined) entry.captureMode = doc.captureMode as StashEntry["captureMode"];
  if (doc.lessonStrength !== undefined) entry.lessonStrength = doc.lessonStrength;
  if (doc.derivedFrom !== undefined) entry.derivedFrom = doc.derivedFrom;

  // ── documentJson-carried extras (DOCUMENT_JSON_CARRIED_FIELDS) ──
  // The `renderer` key on documentJson is adapter-internal (WI-C presentation),
  // NOT a StashEntry field — deliberately not restored.
  assignStringList(entry, "examples", dj.examples);
  assignStringList(entry, "usage", dj.usage);
  if (isIntent(dj.intent)) entry.intent = dj.intent;
  assignStringList(entry, "xrefs", dj.xrefs);
  assignString(entry, "pageKind", dj.pageKind);
  assignString(entry, "whenToUse", dj.whenToUse);
  if (dj.toc !== undefined) entry.toc = dj.toc as StashEntry["toc"];
  if (dj.parameters !== undefined) entry.parameters = dj.parameters as StashEntry["parameters"];
  assignString(entry, "bodyOpening", dj.bodyOpening);
  if (dj.source !== undefined) entry.source = dj.source as StashEntry["source"];
  assignString(entry, "category", dj.category);
  assignStringList(entry, "supersededBy", dj.supersededBy);
  assignStringList(entry, "contradictedBy", dj.contradictedBy);
  assignString(entry, "run", dj.run);
  assignString(entry, "setup", dj.setup);
  assignString(entry, "cwd", dj.cwd);
  if (dj.wikiRole !== undefined) entry.wikiRole = dj.wikiRole as StashEntry["wikiRole"];
  assignStringList(entry, "sources", dj.sources);
  if (typeof dj.generation === "number") entry.generation = dj.generation;
  assignStringList(entry, "sourceRefs", dj.sourceRefs);
  assignStringList(entry, "evidenceSources", dj.evidenceSources);

  return entry;
}

type StringListKey =
  | "examples"
  | "usage"
  | "xrefs"
  | "supersededBy"
  | "contradictedBy"
  | "sources"
  | "sourceRefs"
  | "evidenceSources";

type StringKey = "pageKind" | "whenToUse" | "bodyOpening" | "category" | "run" | "setup" | "cwd";

function assignStringList(entry: StashEntry, key: StringListKey, value: unknown): void {
  if (Array.isArray(value)) entry[key] = value as string[];
}

function assignString(entry: StashEntry, key: StringKey, value: unknown): void {
  if (typeof value === "string") entry[key] = value;
}

function isIntent(value: unknown): value is StashIntent {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
