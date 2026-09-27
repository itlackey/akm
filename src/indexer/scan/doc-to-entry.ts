// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `indexDocumentToStashEntry` — the inverse of the `akm` adapter's
 * `indexDocumentFromEntry` (`adapters/akm-adapter.ts`). akm 0.9.0 Chunk 5,
 * milestone F4a (M2 groundwork).
 *
 * The indexer drains a single `IndexDocument` stream (`drainDirDocuments` × the
 * dispatched adapter's `recognize`) and persists its canonical projection in
 * `entries.document_json`. Every reader (`rowToIndexedEntry` →
 * `DbIndexedEntry.entry`) consumes that same projection, and parity tests pin
 * the boundary.
 *
 * That reconstruction is lossless by construction: the akm adapter's `recognize`
 * assembles a full `IndexDocument` (P1/P2 → fold → P4) and then maps it onto the
 * `IndexDocument` via `indexDocumentFromEntry` — first-class search/signal fields
 * onto named members, every other search-surface/provenance field onto
 * `documentJson` (the `DOCUMENT_JSON_CARRIED_FIELDS` set). This function reverses
 * that mapping exactly, so `indexDocumentToStashEntry(recognize(file))` deep-
 * equals the current persisted document for the same file (the
 * `tests/integration/shadow-scan-parity.test.ts` gate pins this boundary).
 *
 * Two deliberate non-round-trip fields:
 *   - `filename` — dropped by `indexDocumentFromEntry` (no IndexDocument home),
 *     recovered here as `basename(doc.path)`. The old pipeline set it to
 *     `basename(file)` in `applyPostContributorFields`, and `doc.path` IS that
 *     file, so the value is identical.
 *   - `fileSize` — never set by `recognize` NOR by the legacy flat-walk pass;
 *     both pipelines attach it at PERSIST time (`withFileSize`). It is therefore
 *     intentionally absent here and added by the persist layer, exactly as
 *     before.
 *
 * Pure, type-only imports (no cycle participation).
 */

import path from "node:path";
import type { IndexDocument } from "../../core/adapter/types";
import {
  getMarkdownFragmentContent,
  hasMarkdownFragmentContent,
  type StashIntent,
  setMarkdownFragmentContent,
} from "../passes/metadata";

/**
 * Reconstruct the `IndexDocument` an `IndexDocument` was mapped from. First-class
 * IndexDocument members and the `documentJson`-carried extras are both restored;
 * every field is set only when present, matching the old pipeline's
 * "assign-only-when-defined" assembly so the reconstruction deep-equals it.
 */
export function indexDocumentToStashEntry(doc: IndexDocument): IndexDocument {
  const dj = (doc.documentJson ?? {}) as Record<string, unknown>;

  const entry: IndexDocument = {
    name: doc.name,
    // `type` is a required member of the merged IndexDocument (M-core-1), so no
    // `?? ""` fallback is needed — `recognize` always sets it.
    type: doc.type,
    // Dropped by indexDocumentFromEntry — recovered from the read path (= the
    // basename the old pipeline stored). Always present on a recognized doc.
    filename: path.basename(doc.path ?? ""),
  };

  // ── First-class IndexDocument members (spec §3) ──
  if (doc.description !== undefined) entry.description = doc.description;
  if (doc.tags !== undefined) entry.tags = doc.tags;
  if (doc.content !== undefined) entry.content = doc.content;
  if (doc.contentTruncated !== undefined) entry.contentTruncated = doc.contentTruncated;
  if (hasMarkdownFragmentContent(doc)) setMarkdownFragmentContent(entry, getMarkdownFragmentContent(doc));
  if (doc.ownsPresentation !== undefined) entry.ownsPresentation = doc.ownsPresentation;
  if (doc.updated !== undefined) entry.updated = doc.updated;
  if (doc.links !== undefined) entry.links = doc.links;
  if (doc.adapterId === "okf") {
    if (doc.documentJson !== undefined) entry.documentJson = doc.documentJson;
    // OKF v0.2 trust/provenance/lifecycle family (okf-support.md v0.2 note).
    // These are first-class IndexDocument members the okf adapter sets
    // directly (never routed through documentJson), so — unlike the akm
    // adapter's DOCUMENT_JSON_CARRIED_FIELDS reconstruction below — they need
    // an explicit carry here too, or persistence silently drops them even
    // though `recognize()` itself returns them correctly.
    if (doc.provenance !== undefined) entry.provenance = doc.provenance;
    if (doc.lifecycleStatus !== undefined) entry.lifecycleStatus = doc.lifecycleStatus;
    if (doc.staleAfter !== undefined) entry.staleAfter = doc.staleAfter;
    if (doc.okfVersion !== undefined) entry.okfVersion = doc.okfVersion;
    return entry;
  }
  if (doc.aliases !== undefined) entry.aliases = doc.aliases;
  if (doc.searchHints !== undefined) entry.searchHints = doc.searchHints;
  if (doc.hints !== undefined) entry.hints = doc.hints;
  if (doc.quality !== undefined) entry.quality = doc.quality;
  if (doc.confidence !== undefined) entry.confidence = doc.confidence;
  if (doc.beliefState !== undefined) entry.beliefState = doc.beliefState;
  if (doc.currentBeliefRefs !== undefined) entry.currentBeliefRefs = doc.currentBeliefRefs;
  if (doc.scope !== undefined) entry.scope = doc.scope;
  if (doc.captureMode !== undefined) entry.captureMode = doc.captureMode;
  if (doc.lessonStrength !== undefined) entry.lessonStrength = doc.lessonStrength;
  if (doc.derivedFrom !== undefined) entry.derivedFrom = doc.derivedFrom;
  if (doc.pinned !== undefined) entry.pinned = doc.pinned;

  // ── documentJson-carried extras (DOCUMENT_JSON_CARRIED_FIELDS) ──
  // The `renderer` key on documentJson is adapter-internal (WI-C presentation),
  // NOT a IndexDocument field — deliberately not restored.
  assignStringList(entry, "examples", dj.examples);
  assignStringList(entry, "usage", dj.usage);
  if (isIntent(dj.intent)) entry.intent = dj.intent;
  assignStringList(entry, "xrefs", dj.xrefs);
  assignString(entry, "pageKind", dj.pageKind);
  assignString(entry, "whenToUse", dj.whenToUse);
  if (dj.toc !== undefined) entry.toc = dj.toc as IndexDocument["toc"];
  if (dj.parameters !== undefined) entry.parameters = dj.parameters as IndexDocument["parameters"];
  if (dj.source !== undefined) entry.source = dj.source as IndexDocument["source"];
  assignString(entry, "category", dj.category);
  assignStringList(entry, "supersededBy", dj.supersededBy);
  assignStringList(entry, "contradictedBy", dj.contradictedBy);
  assignString(entry, "run", dj.run);
  assignString(entry, "setup", dj.setup);
  assignString(entry, "cwd", dj.cwd);
  if (dj.wikiRole !== undefined) entry.wikiRole = dj.wikiRole as IndexDocument["wikiRole"];
  assignStringList(entry, "sources", dj.sources);
  assignStringList(entry, "evidenceSources", dj.evidenceSources);
  // D2 (#730): OKF v0.2 provenance promoteProposal stamps onto AKM-native
  // writes, carried via DOCUMENT_JSON_CARRIED_FIELDS (akm-adapter.ts) —
  // unpacked back to a first-class member here exactly like `sources`/
  // `generation`/`evidenceSources` above, so it round-trips to the top level
  // of the persisted entry rather than staying nested under `documentJson`.
  if (dj.provenance !== undefined) entry.provenance = dj.provenance as IndexDocument["provenance"];

  return entry;
}

type StringListKey = "examples" | "usage" | "xrefs" | "supersededBy" | "contradictedBy" | "sources" | "evidenceSources";

type StringKey = "pageKind" | "whenToUse" | "category" | "run" | "setup" | "cwd";

function assignStringList(entry: IndexDocument, key: StringListKey, value: unknown): void {
  if (Array.isArray(value)) entry[key] = value as string[];
}

function assignString(entry: IndexDocument, key: StringKey, value: unknown): void {
  if (typeof value === "string") entry[key] = value;
}

function isIntent(value: unknown): value is StashIntent {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
