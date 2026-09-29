// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Per-directory document drain — akm 0.9.0 Chunk 5, milestone F4a M-core-2 (the
 * engine swap). Replaces the live indexer's per-dir flat-walk matcher-pass
 * `IndexDocument` stream with the `akm` adapter's `recognize` `IndexDocument`
 * stream, reconstructing the durable `IndexDocument` via {@link
 * indexDocumentToStashEntry} (proven lossless by the shadow-parity gate).
 *
 * Two behaviors the adapter fold does NOT carry, restored here at the drain
 * layer (spec §14.2 "drain the full document stream"):
 *
 *  - **Broken-workflow drop (item 3).** The live path dropped a broken workflow
 *    via the renderer contributor's throw → metadata-pass skip-with-warning; the
 *    `akm` adapter's synchronous `foldRecognizedMetadata` SWALLOWS the parse
 *    error, so a broken workflow would otherwise silently index. We run the
 *    shared source-IR compiler on drained workflow docs and DROP
 *    the entry with the same `Skipped workflow …` warning
 *    ({@link buildMetadataSkipWarning}), so the workflow-skip summary counts it.
 *
 * `doc.hash` (= sha256 of the file content) is surfaced per recognized file so
 * the persist layer can populate the `content_hash` column (item 2). It is keyed
 * by the file's absolute path rather than by the entry object.
 *
 * Pure of DB/global state; a new leaf (nothing imports it back), so it joins no
 * import cycle.
 */

import path from "node:path";
import { akmAdapter } from "../../core/adapter/adapters/akm-adapter";
import type { BundleAdapter } from "../../core/adapter/bundle-adapter";
import type { BundleComponent, IndexDocument } from "../../core/adapter/types";
import { compareCodePoints } from "../../core/common";
import { canonicalizeWorkflowName } from "../../core/recognition-util";
import { compileWorkflowSource } from "../../workflows/compile";
import { resolveWorkflowSourceDomains, workflowNameForSourcePath } from "../../workflows/source-files";
import { buildMetadataSkipWarning, type StashFile } from "../passes/metadata";
import { buildFileContext, type FileContext } from "../walk/file-context";
import { indexDocumentToStashEntry } from "./doc-to-entry";

/** The markdown-workflow renderer name the `akm` adapter carries on `documentJson.renderer`. */
const WORKFLOW_MD_RENDERER = "workflow-md";

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
  /** Authored paths rejected by workflow source-ownership preflight. */
  rejectedPaths: Set<string>;
  /** Adapter-owned canonical concept ids rejected before workflow parsing. */
  rejectedConceptIds: Set<string>;
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
  component: BundleComponent,
  fileContexts: readonly FileContext[],
): DrainedDir {
  const entries: IndexDocument[] = [];
  const warnings: string[] = [];
  const hashByFile = new Map<string, string>();
  const conceptIdByFile = new Map<string, string>();
  const rejectedPaths = new Set<string>();
  const rejectedConceptIds = new Set<string>();
  // A full directory drain may contain both peer workflow formats for one
  // canonical ref.  Ownership arbitration must happen *before* recognition:
  // otherwise both documents reach the persistence fold and SQLite's final
  // row is determined by the walk/readdir order.  Resolve exactly the paths
  // this drain owns, so a full scan retains only the deterministic `.md`
  // winner while a targeted one-file reindex deliberately keeps its written
  // source and therefore marks an existing peer row stale for read fallback.
  const workflowOwnerPathByCanonicalName = new Map(
    resolveWorkflowSourceDomains(
      component.root,
      adapter.id,
      fileContexts.map((file) => file.absPath),
    )
      .filter((resolution) => resolution.source !== undefined)
      .map((resolution) => [resolution.canonicalName, path.resolve(resolution.source!.path)]),
  );
  const invalidWorkflowOwnerNames = new Set<string>();
  const orderedFileContexts = [...fileContexts].sort((left, right) => {
    const leftName = workflowNameForSourcePath(component.root, adapter.id, left.absPath);
    const rightName = workflowNameForSourcePath(component.root, adapter.id, right.absPath);
    const leftOwner =
      leftName !== undefined &&
      workflowOwnerPathByCanonicalName.get(canonicalizeWorkflowName(leftName)) === path.resolve(left.absPath);
    const rightOwner =
      rightName !== undefined &&
      workflowOwnerPathByCanonicalName.get(canonicalizeWorkflowName(rightName)) === path.resolve(right.absPath);
    if (leftOwner !== rightOwner) return leftOwner ? -1 : 1;
    return compareCodePoints(left.absPath, right.absPath);
  });

  for (const file of orderedFileContexts) {
    if (rejectedPaths.has(file.absPath)) continue;

    const workflowName = workflowNameForSourcePath(component.root, adapter.id, file.absPath);
    if (workflowName !== undefined) {
      const canonicalName = canonicalizeWorkflowName(workflowName);
      const ownerPath = workflowOwnerPathByCanonicalName.get(canonicalName);
      if (
        ownerPath !== undefined &&
        ownerPath !== path.resolve(file.absPath) &&
        !invalidWorkflowOwnerNames.has(canonicalName)
      ) {
        continue;
      }
    }

    const doc = adapter.recognize(component, file);
    if (doc === null) continue;
    if (!doc.conceptId) {
      warnings.push(`Skipped ${file.absPath}: adapter "${adapter.id}" returned no conceptId.`);
      continue;
    }

    const entry = indexDocumentToStashEntry(doc);
    // Workflow docs: drop-with-warning if broken; otherwise cache a lossless
    // runtime projection when the current executor can represent the source.
    const dropWarning = handleWorkflowDoc(doc, file, component.root);
    if (dropWarning !== null) {
      warnings.push(dropWarning);
      if (workflowName !== undefined) invalidWorkflowOwnerNames.add(canonicalizeWorkflowName(workflowName));
      continue;
    }

    if (doc.hash !== undefined) hashByFile.set(file.absPath, doc.hash);
    conceptIdByFile.set(file.absPath, doc.conceptId);
    entries.push(entry);
  }

  return { entries, warnings, hashByFile, conceptIdByFile, rejectedPaths, rejectedConceptIds };
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
 * callers, so the synthetic component id is immaterial.
 */
export function recognizeStashEntries(stashRoot: string, files: string[]): StashFile {
  const component: BundleComponent = { id: stashRoot, adapter: "akm", root: stashRoot, writable: false };
  // No pre-filter: the `akm` adapter's `recognize` claims/abstains per file
  // (owner ruling 2026-07-21 — adapter-owned filtering).
  const contexts = files.map((file) => buildFileContext(stashRoot, file));
  const drained = drainDirDocuments(akmAdapter, component, contexts);
  return drained.warnings.length > 0
    ? { entries: drained.entries, warnings: drained.warnings }
    : { entries: drained.entries };
}

/**
 * If `doc` is a workflow, compile it through source IR: return a
 * `Skipped workflow …` drop warning when it is broken, or return `null` when
 * it compiles. Non-workflow docs return `null` immediately.
 */
function handleWorkflowDoc(doc: IndexDocument, file: FileContext, workspaceRoot: string): string | null {
  if (
    doc.type !== "workflow" ||
    (doc.adapterId !== "akm" && doc.adapterId !== "akm-workflow") ||
    (docRenderer(doc) !== WORKFLOW_MD_RENDERER && doc.adapterId !== "akm-workflow")
  ) {
    return null;
  }

  const result = compileWorkflowSource(file.content(), { path: file.relPath, workspaceRoot });
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
function workflowDropWarning(file: FileContext, errors: ReadonlyArray<{ line: number; message: string }>): string {
  const summary = errors.map((e) => `${file.relPath}:${e.line} — ${e.message}`).join("\n");
  return buildMetadataSkipWarning(file.absPath, "workflow", `Workflow has errors:\n${summary}`);
}
