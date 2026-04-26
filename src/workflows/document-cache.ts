/**
 * Side-channel cache that lets the workflow renderer hand a validated
 * `WorkflowDocument` to the indexer without persisting it through the
 * `entry_json` column or widening `StashEntry` with a workflow-shaped field.
 *
 * The renderer is called during metadata generation; the indexer writes the
 * document to `workflow_documents` after `upsertEntry` returns the row id.
 * A WeakMap keyed by the entry object preserves the parse work between the
 * two phases without leaking memory if the entry is dropped.
 */

import type { StashEntry } from "../indexer/metadata";
import type { WorkflowDocument } from "./schema";

const cache = new WeakMap<StashEntry, WorkflowDocument>();

export function cacheWorkflowDocument(entry: StashEntry, doc: WorkflowDocument): void {
  cache.set(entry, doc);
}

export function takeWorkflowDocument(entry: StashEntry): WorkflowDocument | undefined {
  const doc = cache.get(entry);
  if (doc !== undefined) cache.delete(entry);
  return doc;
}
