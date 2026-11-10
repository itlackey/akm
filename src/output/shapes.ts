// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Pure shaping functions that select and trim fields from command result
 * objects according to the active detail level.
 *
 * Every function in this module is side-effect free and operates on plain
 * `Record<string, unknown>` shapes, which makes them trivial to unit test.
 *
 * Built-in shapes are registered once, in one explicit pass
 * (`BUILT_IN_OUTPUT_SHAPES`). `shapeForCommand` looks up the registry and
 * throws for unknown commands (exhaustive registry, no silent fallback).
 */

import type { DetailLevel } from "./context";
import { curateShapes } from "./shapes/curate";
import { envListShapes } from "./shapes/env-list";
import { eventsShapes } from "./shapes/events";
import {
  shapeProposalAcceptOutput,
  shapeProposalDiffOutput,
  shapeProposalListOutput,
  shapeProposalRejectOutput,
  shapeProposalShowOutput,
  shapeSearchOutput,
  shapeShowOutput,
} from "./shapes/helpers";
import { migrateShapes } from "./shapes/migrate";
import { passthroughShapes } from "./shapes/passthrough";
import { proposalProducerShapes } from "./shapes/proposal/producer";
import { getOutputShapeHandler, type OutputShapeEntry, registerOutputShapes } from "./shapes/registry";
import { secretListShapes } from "./shapes/secret-list";

const BUILT_IN_OUTPUT_SHAPES: OutputShapeEntry[] = [
  {
    command: "search",
    handler: (result, detail) => shapeSearchOutput(result as Record<string, unknown>, detail),
  },
  ...curateShapes,
  {
    command: "show",
    handler: (result, detail) => shapeShowOutput(result as Record<string, unknown>, detail),
  },
  ...eventsShapes,
  {
    command: "proposal-list",
    handler: (result, detail) => shapeProposalListOutput(result as Record<string, unknown>, detail),
  },
  {
    command: "proposal-show",
    handler: (result, detail) => shapeProposalShowOutput(result as Record<string, unknown>, detail),
  },
  {
    command: "proposal-accept",
    handler: (result, detail) => shapeProposalAcceptOutput(result as Record<string, unknown>, detail),
  },
  {
    command: "proposal-reject",
    handler: (result, detail) => shapeProposalRejectOutput(result as Record<string, unknown>, detail),
  },
  // One reopened proposal is the same envelope `reject` returns, so it shares that shaper; several are the
  // passthrough `proposal-reopen-batch`.
  {
    command: "proposal-reopen",
    handler: (result, detail) => shapeProposalRejectOutput(result as Record<string, unknown>, detail),
  },
  {
    command: "proposal-diff",
    handler: (result, detail) => shapeProposalDiffOutput(result as Record<string, unknown>, detail),
  },
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

export function shapeForCommand(command: OutputCommandName, result: unknown, detail: DetailLevel): unknown {
  const handler = getOutputShapeHandler(command);
  if (handler) {
    return handler(result, detail);
  }
  // Output-shape registry is exhaustive: no silent JSON.stringify
  // fallback. A missing case here is a registration bug — fail loudly so
  // the caller (or its tests) sees the missing command name.
  throw new Error(`output shape not registered for command: ${command}`);
}
