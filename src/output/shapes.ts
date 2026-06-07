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
 * Output shapes are assembled EXPLICITLY here: each per-command module under
 * `src/output/shapes/` EXPORTS a pure `OutputShapeEntry[]` (no top-level
 * side effect), and this barrel imports those exports and registers them in a
 * single deterministic, order-independent pass (`BUILT_IN_OUTPUT_SHAPES`).
 * Dropping a module from the assembly array is a COMPILE error, not a silent
 * runtime gap. The central `shapeForCommand` dispatcher looks up the registry
 * and throws for unknown commands (v1 spec §9 — exhaustive registry, no silent
 * fallback).
 */

import { UsageError } from "../core/errors";
import type { DetailLevel, ShapeMode } from "./context";
import { curateShapes } from "./shapes/curate";
import { distillShapes } from "./shapes/distill";
import { envListShapes } from "./shapes/env-list";
import { eventsShapes } from "./shapes/events";
import { historyShapes } from "./shapes/history";
import { passthroughShapes } from "./shapes/passthrough";
import { proposalAcceptShapes } from "./shapes/proposal/accept";
import { proposalDiffShapes } from "./shapes/proposal/diff";
import { proposalListShapes } from "./shapes/proposal/list";
import { proposalProducerShapes } from "./shapes/proposal/producer";
import { proposalRejectShapes } from "./shapes/proposal/reject";
import { proposalShowShapes } from "./shapes/proposal/show";
import { getOutputShapeHandler, type OutputShapeEntry, registerOutputShapes } from "./shapes/registry";
import { registrySearchShapes } from "./shapes/registry-search";
import { searchShapes } from "./shapes/search";
import { secretListShapes } from "./shapes/secret-list";
import { showShapes } from "./shapes/show";

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

// ── Explicit built-in shape assembly ──────────────────────────────────────────
// Each entry below is a pure exported `OutputShapeEntry[]` from a per-command
// module. The set is registered ONCE, deterministically, with no reliance on
// import order. Removing a module from this list removes its registration —
// and because each name is referenced statically, a deleted export fails to
// compile instead of silently disappearing at runtime.
const BUILT_IN_OUTPUT_SHAPES: OutputShapeEntry[] = [
  ...searchShapes,
  ...curateShapes,
  ...registrySearchShapes,
  ...showShapes,
  ...historyShapes,
  ...eventsShapes,
  ...proposalListShapes,
  ...proposalShowShapes,
  ...proposalAcceptShapes,
  ...proposalRejectShapes,
  ...proposalDiffShapes,
  ...proposalProducerShapes,
  ...distillShapes,
  ...envListShapes,
  ...secretListShapes,
  // Passthrough commands are registered last so an explicit dedicated handler
  // above always wins over the identity-stamp fallback for the same name.
  ...passthroughShapes,
];

registerOutputShapes(BUILT_IN_OUTPUT_SHAPES);

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
