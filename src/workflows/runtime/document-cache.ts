// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Side-channel cache that lets the workflow renderer hand a validated
 * `WorkflowDocument` to the indexer without persisting it through the
 * `entry_json` column or widening `IndexDocument` with a workflow-shaped field.
 *
 * The renderer is called during metadata generation; the indexer writes the
 * document to `workflow_documents` after `upsertEntry` returns the row id.
 * A WeakMap keyed by the entry object preserves the parse work between the
 * two phases without leaking memory if the entry is dropped.
 */

import type { IndexDocument } from "../../indexer/passes/metadata";
import type { WorkflowDocument } from "../schema";

const cache = new WeakMap<IndexDocument, WorkflowDocument>();

export function cacheWorkflowDocument(entry: IndexDocument, doc: WorkflowDocument): void {
  cache.set(entry, doc);
}

export function takeWorkflowDocument(entry: IndexDocument): WorkflowDocument | undefined {
  const doc = cache.get(entry);
  if (doc !== undefined) cache.delete(entry);
  return doc;
}
