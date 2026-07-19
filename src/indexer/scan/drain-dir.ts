// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Per-directory document drain — akm 0.9.0 Chunk 5, milestone F4a M-core-2 (the
 * engine swap). Replaces the live indexer's per-dir `generateMetadataFlat`
 * `StashEntry` stream with the `akm` adapter's `recognize` `IndexDocument`
 * stream, reconstructing the durable `StashEntry` via {@link
 * indexDocumentToStashEntry} (proven lossless by the shadow-parity gate).
 *
 * Two behaviors the adapter fold does NOT carry, restored here at the drain
 * layer (spec §14.2 "drain the full document stream"):
 *
 *  - **Broken-workflow drop (item 3).** The live path dropped a broken workflow
 *    via the renderer contributor's throw → metadata-pass skip-with-warning; the
 *    `akm` adapter's synchronous `foldRecognizedMetadata` SWALLOWS the parse
 *    error, so a broken workflow would otherwise silently index. We re-run
 *    `parseWorkflow` / `parseWorkflowProgram` on drained workflow docs and DROP
 *    the entry with the same `Skipped workflow …` warning
 *    ({@link buildMetadataSkipWarning}), so the workflow-skip summary counts it.
 *  - **Workflow-document side-table (workflow-md only).** The valid parsed
 *    `WorkflowDocument` is handed to the persist layer through the same
 *    `document-cache` side channel the live renderer contributor used, keyed by
 *    the reconstructed entry — so `takeWorkflowDocument(entry)` in the persist
 *    loop writes the `workflow_documents` row exactly as before. YAML programs
 *    are re-parsed from disk by the runtime loader, so they carry no cache row
 *    (mirrors the live path).
 *
 * `doc.hash` (= sha256 of the file content) is surfaced per recognized file so
 * the persist layer can populate the `content_hash` column (item 2). It is keyed
 * by the file's absolute path (stable across the `.stash.json` legacy merge,
 * which rebuilds entry objects) rather than by the entry object.
 *
 * Pure of DB/global state beyond the workflow-document side channel; a new leaf
 * (nothing imports it back), so it joins no import cycle.
 */

import type { BundleAdapter } from "../../core/adapter/bundle-adapter";
import type { BundleComponent, IndexDocument } from "../../core/adapter/types";
import { parseWorkflow } from "../../workflows/parser";
import { parseWorkflowProgram } from "../../workflows/program/parser";
import { WORKFLOW_PROGRAM_RENDERER_NAME } from "../../workflows/program/project";
import { cacheWorkflowDocument } from "../../workflows/runtime/document-cache";
import { buildMetadataSkipWarning, type StashEntry } from "../passes/metadata";
import type { FileContext } from "../walk/file-context";
import { indexDocumentToStashEntry } from "./doc-to-entry";

/** The markdown-workflow renderer name the `akm` adapter carries on `documentJson.renderer`. */
const WORKFLOW_MD_RENDERER = "workflow-md";

export interface DrainedDir {
  /** The reconstructed durable entries, broken workflows already dropped. */
  entries: StashEntry[];
  /** Per-file skip warnings (broken workflows), same shape the metadata pass emitted. */
  warnings: string[];
  /** `doc.hash` keyed by the recognized file's absolute path (content_hash source, item 2). */
  hashByFile: Map<string, string>;
}

/**
 * Drain one directory's recognized documents into durable entries.
 *
 * `fileContexts` are the dir's indexable files (already `shouldIndexStashFile`-
 * filtered by the caller). `adapter.recognize` returns `null` for a file no
 * matcher claims (or an OKF reserved file) — silently skipped, the same
 * contract `generateMetadataFlat`'s "no matcher claims the file" case had.
 */
export function drainDirDocuments(
  adapter: BundleAdapter,
  component: BundleComponent,
  fileContexts: readonly FileContext[],
): DrainedDir {
  const entries: StashEntry[] = [];
  const warnings: string[] = [];
  const hashByFile = new Map<string, string>();

  for (const file of fileContexts) {
    const doc = adapter.recognize(component, file);
    if (doc === null) continue;

    const entry = indexDocumentToStashEntry(doc);
    // Workflow docs: drop-with-warning if broken; otherwise cache the parsed
    // markdown document for the persist-time `workflow_documents` write.
    const dropWarning = handleWorkflowDoc(doc, entry, file);
    if (dropWarning !== null) {
      warnings.push(dropWarning);
      continue;
    }

    if (doc.hash !== undefined) hashByFile.set(file.absPath, doc.hash);
    entries.push(entry);
  }

  return { entries, warnings, hashByFile };
}

/**
 * If `doc` is a workflow, re-parse it: return a `Skipped workflow …` drop
 * warning when it is broken, or cache the parsed markdown `WorkflowDocument`
 * (workflow-md only) and return `null` when valid. Non-workflow docs return
 * `null` immediately.
 */
function handleWorkflowDoc(doc: IndexDocument, entry: StashEntry, file: FileContext): string | null {
  const renderer = docRenderer(doc);

  if (renderer === WORKFLOW_MD_RENDERER) {
    const result = parseWorkflow(file.content(), { path: file.relPath });
    if (!result.ok) return workflowDropWarning(file, result.errors);
    cacheWorkflowDocument(entry, result.document);
    return null;
  }

  if (renderer === WORKFLOW_PROGRAM_RENDERER_NAME) {
    const result = parseWorkflowProgram(file.content(), { path: file.relPath });
    if (!result.ok) return workflowDropWarning(file, result.errors);
    return null;
  }

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
function workflowDropWarning(file: FileContext, errors: ReadonlyArray<{ line: number; message: string }>): string {
  const summary = errors.map((e) => `${file.relPath}:${e.line} — ${e.message}`).join("\n");
  return buildMetadataSkipWarning(file.absPath, "workflow", `Workflow has errors:\n${summary}`);
}
