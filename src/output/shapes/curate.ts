// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `curate` output shape.
 *
 * Previously `curate` rode the identity-passthrough handler, which made
 * `--detail` inert. This dedicated handler projects each curated
 * item by detail the same way
 * `shapeSearchOutput` projects search results, so curate honors the global
 * output contract.
 */

import type { DetailLevel } from "../context";
import { BRIEF_DESCRIPTION_LIMIT, capDescription, NORMAL_DESCRIPTION_LIMIT, pickFields } from "./helpers";
import type { OutputShapeEntry } from "./registry";

// Curation is a small, high-signal top-N. Even at `brief` we keep a short
// description and `reason` (set only on historical items).
const BRIEF_FIELDS = ["source", "type", "name", "ref", "id", "description", "supportRefs", "beliefState", "reason"];
// Normal: the minimal field set an LLM needs to decide and act.
const NORMAL_FIELDS = [
  "source",
  "type",
  "name",
  "ref",
  "path",
  "editable",
  "editHint",
  "id",
  "description",
  "supportRefs",
  "beliefState",
  "reason",
  "score",
];

function shapeCurateItem(item: Record<string, unknown>, detail: DetailLevel): Record<string, unknown> {
  if (detail === "brief") {
    return capDescription(pickFields(item, BRIEF_FIELDS), BRIEF_DESCRIPTION_LIMIT);
  }
  if (detail === "normal") {
    const shaped = pickFields(item, NORMAL_FIELDS);
    if (shaped.editable !== false) delete shaped.editHint;
    return capDescription(shaped, NORMAL_DESCRIPTION_LIMIT);
  }
  // full: project everything the curator emits.
  return item;
}

export function shapeCurateOutput(result: Record<string, unknown>, detail: DetailLevel): Record<string, unknown> {
  const items = Array.isArray(result.items) ? (result.items as Record<string, unknown>[]) : [];
  const shapedItems = items.map((item) => shapeCurateItem(item, detail));

  const base: Record<string, unknown> = {
    // `shape`/`schemaVersion` discriminators preserve the prior passthrough
    // envelope contract (#484) so consumers can pin a schema version.
    schemaVersion: typeof result.schemaVersion === "number" ? result.schemaVersion : 1,
    shape: "curate",
    query: result.query,
    summary: result.summary,
    results: shapedItems,
    ...(result.project ? { project: result.project } : {}),
    ...(typeof result.searchMode === "string" ? { searchMode: result.searchMode } : {}),
    ...(Array.isArray(result.bundles) ? { bundles: result.bundles } : {}),
    ...(Array.isArray(result.warnings) && result.warnings.length > 0 ? { warnings: result.warnings } : {}),
    ...(result.tip ? { tip: result.tip } : {}),
  };
  return base;
}

export const curateShapes: OutputShapeEntry[] = [
  {
    command: "curate",
    handler: (result, detail) => shapeCurateOutput(result as Record<string, unknown>, detail),
  },
];
