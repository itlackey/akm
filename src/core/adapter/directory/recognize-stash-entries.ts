// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { StashFile } from "../../../indexer/passes/metadata";
import { drainDirDocuments } from "../../../indexer/scan/drain-dir";
import { akmAdapter } from "../adapters/akm-adapter";
import type { Bundle } from "../types";
import { buildFileContext } from "./file-context";

/**
 * `(stashRoot, files) → StashFile` builds a FileContext per file and drains them through the
 * `akm` adapter's `recognize`. Callers that only need the
 * recognized entries (`manifest`'s no-index fallback, the `registry`
 * static-index builder, and the metadata unit tests) use it. It also applies the D-R6 reserved-file exclusion and the AKM sensitive/infra
 * abstention the adapter now enforces itself. Provenance is not persisted by these
 * callers, so the synthetic bundle id is immaterial.
 */
export function recognizeStashEntries(stashRoot: string, files: string[]): StashFile {
  const bundle: Bundle = { id: stashRoot, root: stashRoot };
  // No pre-filter: the `akm` adapter's `recognize` claims/abstains per file
  // (filtering is adapter-owned).
  const contexts = files.map((file) => buildFileContext(stashRoot, file));
  const drained = drainDirDocuments(akmAdapter, bundle, contexts);
  return drained.warnings.length > 0
    ? { entries: drained.entries, warnings: drained.warnings }
    : { entries: drained.entries };
}
