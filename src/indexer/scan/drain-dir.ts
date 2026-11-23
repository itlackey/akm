// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Per-directory document drain: turns the `akm` adapter's `recognize`
 * `IndexDocument` stream into durable entries, reconstructing the durable
 * `IndexDocument` via {@link indexDocumentToStashEntry}.
 *
 * Two behaviors the adapter fold does NOT carry, restored here at the drain
 * layer:
 *
 *  - **Broken-workflow drop.** The live path dropped a broken workflow
 *    via the renderer contributor's throw → metadata-pass skip-with-warning; the
 *    `akm` adapter's synchronous `foldRecognizedMetadata` SWALLOWS the parse
 *    error, so a broken workflow would otherwise silently index. We run the
 *    shared source-IR compiler on drained workflow docs and DROP
 *    the entry with the same `Skipped workflow …` warning
 *    ({@link buildMetadataSkipWarning}), so the workflow-skip summary counts it.
 *
 * `doc.hash` (= sha256 of the file content) is surfaced per recognized file so
 * the persist layer can populate the `content_hash` column. It is keyed
 * by the file's absolute path rather than by the entry object.
 *
 * Pure of DB/global state; a new leaf (nothing imports it back), so it joins no
 * import cycle.
 */

import { akmAdapter } from "../../core/adapter/adapters/akm-adapter";
import type { BundleAdapter } from "../../core/adapter/bundle-adapter";
import type { Bundle, IndexDocument } from "../../core/adapter/types";
import { compileWorkflowSource } from "../../workflows/compile";
import { isUsableWorkflowSource, workflowNameForSourcePath } from "../../workflows/source-files";
import { buildMetadataSkipWarning, type StashFile } from "../passes/metadata";
import { buildFileContext, type FileContext } from "../walk/file-context";
import { indexDocumentToStashEntry } from "./doc-to-entry";

/** The markdown-workflow renderer name the `akm` adapter carries on `documentJson.renderer`. */
const WORKFLOW_MD_RENDERER = "workflow-md";

/**
 * The durable entry of a recognized document, as the scan, a write-path refresh and the facade's refresh all record
 * it. An entry no file holds (a secret manager's) is keyed under the path the indexer gave it (`fileName` is its
 * name), and marked: no output prints a path for it.
 */
export function indexRowEntry(doc: IndexDocument, fileName: string): IndexDocument {
  const entry = indexDocumentToStashEntry(doc);
  if (doc.path === undefined) {
    entry.filename = fileName;
    entry.fileless = true;
  }
  return entry;
}

export interface DrainedDir {
  /** The reconstructed durable entries, broken workflows already dropped. */
  entries: IndexDocument[];
  /** Per-file skip warnings (broken workflows), same shape the metadata pass emitted. */
  warnings: string[];
  /** `doc.hash` keyed by the recognized file's absolute path (content_hash source, item 2). */
  hashByFile: Map<string, string>;
  /**
   * `doc.conceptId` keyed by the recognized file's absolute path. The persist
   * layer prefers this over re-deriving via akm's `stashDirFor` scheme so a
   * non-akm adapter's identity (`pages/foo`, snapshot paths, …) survives into
   * `item_ref` verbatim (D-R3: identity comes from the owning adapter).
   */
  conceptIdByFile: Map<string, string>;
}

/**
 * Drain one directory's recognized documents into durable entries.
 *
 * `fileContexts` are the dir's walked files (the drain no longer pre-filters —
 * adapter-owned filtering, owner ruling 2026-07-21). `adapter.recognize` returns
 * `null` for a file it abstains on (no matcher claims it, an OKF reserved file,
 * or an AKM sensitive/infra file) — silently skipped, the same contract the
 * legacy flat-walk pass's "no matcher claims the file" case had.
 */
export function drainDirDocuments(
  adapter: BundleAdapter,
  bundle: Bundle,
  fileContexts: readonly FileContext[],
): DrainedDir {
  const entries: IndexDocument[] = [];
  const warnings: string[] = [];
  const hashByFile = new Map<string, string>();
  const conceptIdByFile = new Map<string, string>();

  for (const file of fileContexts) {
    const doc = adapter.recognize(bundle, file);
    if (doc === null) continue;
    if (!doc.conceptId) {
      warnings.push(`Skipped ${file.absPath}: adapter "${adapter.id}" returned no conceptId.`);
      continue;
    }

    const entry = indexRowEntry(doc, file.fileName);
    // Workflow docs: drop-with-warning if broken; otherwise cache a lossless
    // runtime projection when the current executor can represent the source.
    const dropWarning = brokenWorkflowWarning(doc, file);
    if (dropWarning !== null) {
      warnings.push(dropWarning);
      continue;
    }
    // A symlinked workflow source of another extension is warned about once, as the scan always has.
    if (doc.type === "workflow" && workflowNameForSourcePath(bundle.root, adapter.id, file.absPath) !== undefined) {
      isUsableWorkflowSource(bundle.root, file.absPath);
    }

    if (doc.hash !== undefined) hashByFile.set(file.absPath, doc.hash);
    conceptIdByFile.set(file.absPath, doc.conceptId);
    entries.push(entry);
  }

  return { entries, warnings, hashByFile, conceptIdByFile };
}

/**
 * `(stashRoot, files) → StashFile` drop-in for the deleted flat-walk matcher
 * pass (F4a M-core-3): builds a FileContext per file and drains them through the
 * `akm` adapter's `recognize`. The recognize engine is the proven-equal
 * replacement for the old matcher-pass metadata assembly (shadow-parity gate), so
 * callers that only need the recognized entries (`manifest`'s no-index fallback,
 * the `registry` static-index builder, and the metadata unit tests) get identical
 * entries — plus the D-R6 reserved-file exclusion and the AKM sensitive/infra
 * abstention the adapter now enforces itself. Provenance is not persisted by these
 * callers, so the synthetic bundle id is immaterial.
 */
export function recognizeStashEntries(stashRoot: string, files: string[]): StashFile {
  const bundle: Bundle = { id: stashRoot, root: stashRoot };
  // No pre-filter: the `akm` adapter's `recognize` claims/abstains per file
  // (owner ruling 2026-07-21 — adapter-owned filtering).
  const contexts = files.map((file) => buildFileContext(stashRoot, file));
  const drained = drainDirDocuments(akmAdapter, bundle, contexts);
  return drained.warnings.length > 0
    ? { entries: drained.entries, warnings: drained.warnings }
    : { entries: drained.entries };
}

/**
 * If `doc` is a workflow, compile it through source IR: return a
 * `Skipped workflow …` drop warning when it is broken, or return `null` when
 * it compiles. Non-workflow docs return `null` immediately. A broken workflow is no row of the index, whoever
 * records the row: the scan, a write, or the first ask of an asset that has none.
 */
export function brokenWorkflowWarning(
  doc: IndexDocument,
  file: Pick<FileContext, "content" | "relPath" | "absPath">,
): string | null {
  if (
    doc.type !== "workflow" ||
    (doc.adapterId !== "akm" && doc.adapterId !== "akm-workflow") ||
    (docRenderer(doc) !== WORKFLOW_MD_RENDERER && doc.adapterId !== "akm-workflow")
  ) {
    return null;
  }

  const result = compileWorkflowSource(file.content(), { path: file.relPath });
  if (!result.ok) return workflowDropWarning(file, result.errors);
  return null;
}

/** The winning renderer name the `akm` adapter carries on `documentJson.renderer`, or `undefined`. */
function docRenderer(doc: IndexDocument): string | undefined {
  const dj = doc.documentJson;
  if (dj !== null && typeof dj === "object" && "renderer" in dj) {
    const renderer = (dj as { renderer?: unknown }).renderer;
    return typeof renderer === "string" ? renderer : undefined;
  }
  return undefined;
}

/**
 * Build the `Skipped workflow <path>:\n…` warning byte-for-byte the way the live
 * pipeline did: the workflow parser's `path:line — message` summary wrapped in
 * the `Workflow has errors:` prefix (the string `loadDocument`/`loadProgram`
 * threw), then {@link buildMetadataSkipWarning}'s workflow branch. `startsWith
 * "Skipped workflow "` so `isWorkflowSkipWarning` counts it for the summary.
 */
function workflowDropWarning(
  file: Pick<FileContext, "relPath" | "absPath">,
  errors: ReadonlyArray<{ line: number; message: string }>,
): string {
  const summary = errors.map((e) => `${file.relPath}:${e.line} — ${e.message}`).join("\n");
  return buildMetadataSkipWarning(file.absPath, "workflow", `Workflow has errors:\n${summary}`);
}
