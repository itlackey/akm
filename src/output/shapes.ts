// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Pure shaping functions that select and trim fields from command result
 * objects according to the active detail level / agent mode.
 *
 * Every function in this module is side-effect free and operates on plain
 * `Record<string, unknown>` shapes, which makes them trivial to unit test.
 *
 * Output shapes are registered via `registerOutputShape` — see the per-command
 * modules in `src/output/shapes/` for individual registrations. The central
 * `shapeForCommand` dispatcher looks up the registry and throws for unknown
 * commands (v1 spec §9 — exhaustive registry, no silent fallback).
 */

import { UsageError } from "../core/errors";
import type { DetailLevel, ShapeMode } from "./context";
import { getOutputShapeHandler } from "./shapes/registry";

// Re-export helpers so existing imports from `shapes.ts` keep working.
export {
  capDescription,
  NORMAL_DESCRIPTION_LIMIT,
  pickFields,
  shapeAssetHit,
  shapeDistillOutput,
  shapeEventEntry,
  shapeEventsOutput,
  shapeHistoryEntry,
  shapeHistoryOutput,
  shapeProposalAcceptOutput,
  shapeProposalDiffOutput,
  shapeProposalEntry,
  shapeProposalListOutput,
  shapeProposalProducerOutput,
  shapeProposalRejectOutput,
  shapeProposalShowOutput,
  shapeRegistrySearchOutput,
  shapeSearchHit,
  shapeSearchHitForAgent,
  shapeSearchOutput,
  shapeShowOutput,
  truncateDescription,
} from "./shapes/helpers";
export type { OutputShapeHandler } from "./shapes/registry";
// Re-export registry API so callers can use this module as the single entry
// point (backward compat).
export { deregisterOutputShape, registerOutputShape } from "./shapes/registry";

// ── Per-command shape modules (self-register at import time) ──────────────────
// Importing these modules triggers their `registerOutputShape(...)` calls.
// These imports must come AFTER the registry module has been loaded (guaranteed
// by the import order above).
import "./shapes/search";
import "./shapes/curate";
import "./shapes/registry-search";
import "./shapes/show";
import "./shapes/history";
import "./shapes/events";
import "./shapes/proposal-list";
import "./shapes/proposal-show";
import "./shapes/proposal-accept";
import "./shapes/proposal-reject";
import "./shapes/proposal-diff";
import "./shapes/proposal-producer";
import "./shapes/distill";
import "./shapes/env-list";
import "./shapes/secret-list";
import "./shapes/passthrough";

// ── Dispatcher ────────────────────────────────────────────────────────────────

/**
 * Commands whose shape handler implements the `summary` projection. For every
 * other command, `--shape summary` is a usage error (v1 §5 — honest rejection
 * for a soon-frozen contract, not a silent fallback to `human`).
 */
const SHAPE_SUMMARY_COMMANDS = new Set(["show"]);

export function shapeForCommand(
  command: string,
  result: unknown,
  detail: DetailLevel,
  shape: ShapeMode = "human",
): unknown {
  if (shape === "summary" && !SHAPE_SUMMARY_COMMANDS.has(command)) {
    throw new UsageError(
      `'--shape summary' is not supported for 'akm ${command}'. It is only available on 'akm show'.`,
      "INVALID_SHAPE_VALUE",
    );
  }
  const handler = getOutputShapeHandler(command);
  if (handler) {
    return handler(result, detail, shape);
  }
  // v1 spec §9 (output-shape registry exhaustive): no silent JSON.stringify
  // fallback. A missing case here is a registration bug — fail loudly so
  // the caller (or its tests) sees the missing command name.
  throw new Error(`output shape not registered for command: ${command}`);
}
