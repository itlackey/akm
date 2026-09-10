// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Per-directory document drain — akm 0.9.0 Chunk 5, milestone F4a M-core-2 (the
 * engine swap). Replaces the live indexer's per-dir flat-walk matcher-pass
 * `IndexDocument` stream with the `akm` adapter's `recognize` `IndexDocument`
 * stream, reconstructing the durable `IndexDocument` via {@link parseFileDocument}
 * (proven lossless by the shadow-parity gate).
 *
 * One directory-scoped behavior the per-file parse does NOT carry, restored
 * here at the drain layer (spec §14.2 "drain the full document stream"):
 *
 *  - **Peer-workflow-format ownership arbitration.** A full directory drain
 *    may contain both peer workflow formats for one canonical ref; resolving
 *    which one owns the ref requires seeing every file in the directory at
 *    once, so it stays here rather than in the single-file
 *    {@link parseFileDocument} (index-redesign B1 also calls that function to
 *    parse one already-known-changed file, with no peer files in view).
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
import { resolveWorkflowSourceDomains, workflowNameForSourcePath } from "../../workflows/source-files";
import type { StashFile } from "../passes/metadata";
import { buildFileContext, type FileContext } from "../walk/file-context";
import { parseFileDocument } from "./parse-file";

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

    // The recognize → conceptId check → workflow-validity fold is the SAME
    // per-file parse the reconcile engine uses for a single changed file
    // (index-redesign B1) — extracted to `parse-file.ts` so the two never
    // drift apart.
    const outcome = parseFileDocument(adapter, component, file);
    if (outcome.parsed === null) {
      if (outcome.warning !== null) {
        warnings.push(outcome.warning);
        if (outcome.isWorkflowDrop && workflowName !== undefined) {
          invalidWorkflowOwnerNames.add(canonicalizeWorkflowName(workflowName));
        }
      }
      continue;
    }

    const { entry, hash, conceptId } = outcome.parsed;
    if (hash !== undefined) hashByFile.set(file.absPath, hash);
    conceptIdByFile.set(file.absPath, conceptId);
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
