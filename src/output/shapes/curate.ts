// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `curate` output shape.
 *
 * Previously `curate` rode the identity-passthrough handler, which made
 * `--detail`/`--shape` inert. This dedicated handler projects each curated
 * item by detail (verbosity) and shape (projection) the same way
 * `shapeSearchOutput` projects search hits, so curate honors the global
 * output contract.
 */

import type { DetailLevel, ShapeMode } from "../context";
import { capDescription, NORMAL_DESCRIPTION_LIMIT, pickFields } from "./helpers";
import type { OutputShapeEntry } from "./registry";

// Curation is a small, high-signal top-N. Even at `brief` we keep `followUp`
// (the actionable `akm show <ref>` command) and `reason` (why this asset was
// selected) — these are the point of curate, unlike a bulk search listing.
const BRIEF_FIELDS = ["source", "type", "name", "ref", "id", "supportRefs", "followUp", "reason"];
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
  "preview",
  "keys",
  "parameters",
  "run",
  "supportRefs",
  "followUp",
  "reason",
  "score",
];
// Agent shape: the minimal field set an LLM needs to decide and act.
const AGENT_FIELDS = [
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
  "followUp",
  "reason",
  "score",
];

function shapeCurateItem(
  item: Record<string, unknown>,
  detail: DetailLevel,
  shape: ShapeMode,
): Record<string, unknown> {
  if (shape === "agent") {
    const shaped = pickFields(item, AGENT_FIELDS);
    if (shaped.editable !== false) delete shaped.editHint;
    return capDescription(shaped, NORMAL_DESCRIPTION_LIMIT);
  }
  if (detail === "brief") {
    return pickFields(item, BRIEF_FIELDS);
  }
  if (detail === "normal") {
    return capDescription(pickFields(item, NORMAL_FIELDS), NORMAL_DESCRIPTION_LIMIT);
  }
  // full: project everything the curator emits.
  return item;
}

export function shapeCurateOutput(
  result: Record<string, unknown>,
  detail: DetailLevel,
  shape: ShapeMode,
): Record<string, unknown> {
  const items = Array.isArray(result.items) ? (result.items as Record<string, unknown>[]) : [];
  const shapedItems = items.map((item) => shapeCurateItem(item, detail, shape));

  const base: Record<string, unknown> = {
    // `shape`/`schemaVersion` discriminators preserve the prior passthrough
    // envelope contract (#484) so consumers can pin a schema version.
    schemaVersion: typeof result.schemaVersion === "number" ? result.schemaVersion : 1,
    shape: "curate",
    query: result.query,
    summary: result.summary,
    items: shapedItems,
    ...(Array.isArray(result.warnings) && result.warnings.length > 0 ? { warnings: result.warnings } : {}),
    ...(result.tip ? { tip: result.tip } : {}),
  };
  return base;
}

export const curateShapes: OutputShapeEntry[] = [
  {
    command: "curate",
    handler: (result, detail, shape) => shapeCurateOutput(result as Record<string, unknown>, detail, shape),
  },
];
