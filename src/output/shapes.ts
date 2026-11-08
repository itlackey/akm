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
 * and throws for unknown commands (exhaustive registry, no silent
 * fallback).
 */

import type { DetailLevel, ShapeMode } from "./context";
import { curateShapes } from "./shapes/curate";
import { envListShapes } from "./shapes/env-list";
import { eventsShapes } from "./shapes/events";
import { migrateShapes } from "./shapes/migrate";
import { passthroughShapes } from "./shapes/passthrough";
import { proposalAcceptShapes } from "./shapes/proposal/accept";
import { proposalDiffShapes } from "./shapes/proposal/diff";
import { proposalListShapes } from "./shapes/proposal/list";
import { proposalProducerShapes } from "./shapes/proposal/producer";
import { proposalRejectShapes } from "./shapes/proposal/reject";
import { proposalReopenShapes } from "./shapes/proposal/reopen";
import { proposalShowShapes } from "./shapes/proposal/show";
import { getOutputShapeHandler, type OutputShapeEntry, registerOutputShapes } from "./shapes/registry";
import { searchShapes } from "./shapes/search";
import { secretListShapes } from "./shapes/secret-list";
import { showShapes } from "./shapes/show";

// ── Explicit built-in shape assembly ──────────────────────────────────────────
// Each entry below is a pure exported `OutputShapeEntry[]` from a per-command
// module. The set is registered ONCE, deterministically, with no reliance on
// import order. Removing a module from this list removes its registration —
// and because each name is referenced statically, a deleted export fails to
// compile instead of silently disappearing at runtime.
const BUILT_IN_OUTPUT_SHAPES: OutputShapeEntry[] = [
  ...searchShapes,
  ...curateShapes,
  ...showShapes,
  ...eventsShapes,
  ...proposalListShapes,
  ...proposalShowShapes,
  ...proposalAcceptShapes,
  ...proposalRejectShapes,
  ...proposalReopenShapes,
  ...proposalDiffShapes,
  ...proposalProducerShapes,
  ...envListShapes,
  ...secretListShapes,
  ...migrateShapes,
  // Passthrough commands are registered last so an explicit dedicated handler
  // above always wins over the identity-stamp fallback for the same name.
  ...passthroughShapes,
];

registerOutputShapes(BUILT_IN_OUTPUT_SHAPES);

// ── Dispatcher ────────────────────────────────────────────────────────────────

/**
 * Named alias for the command key threaded through the output shaping and
 * text-formatting consumers.
 *
 * Output-shape handlers are registered DYNAMICALLY (`registerOutputShapes` /
 * `registerOutputShape` take a runtime `string` command, and the backing
 * registry is a `Map<string, OutputShapeHandler>`), so there is no literal
 * keyed object from which a real string-literal union could be safely derived.
 * This is therefore a pure nominal alias of `string` today — it changes no
 * runtime behaviour — but it gives the shaping/formatting consumers a single,
 * named tightening point should the registry later be reshaped into a literal
 * map. The `output()` producer and call sites are intentionally NOT retyped
 * here (deferred to design review).
 */
export type OutputCommandName = string;

export function shapeForCommand(
  command: OutputCommandName,
  result: unknown,
  detail: DetailLevel,
  shape: ShapeMode = "human",
): unknown {
  const handler = getOutputShapeHandler(command);
  if (handler) {
    return handler(result, detail, shape);
  }
  // Output-shape registry is exhaustive: no silent JSON.stringify
  // fallback. A missing case here is a registration bug — fail loudly so
  // the caller (or its tests) sees the missing command name.
  throw new Error(`output shape not registered for command: ${command}`);
}
