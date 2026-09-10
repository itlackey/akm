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

import { warnOnce } from "../core/warn";
import type { DetailLevel, ShapeMode } from "./context";
import { curateShapes } from "./shapes/curate";
import { envListShapes } from "./shapes/env-list";
import { eventsShapes } from "./shapes/events";
import { migrateShapes } from "./shapes/migrate";
import { modelsListShapes } from "./shapes/models-list";
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
  ...eventsShapes,
  ...proposalListShapes,
  ...proposalShowShapes,
  ...proposalAcceptShapes,
  ...proposalRejectShapes,
  ...proposalDiffShapes,
  ...proposalProducerShapes,
  ...envListShapes,
  ...secretListShapes,
  ...migrateShapes,
  ...modelsListShapes,
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

/**
 * Commands whose shape handler implements the `summary` projection. For every
 * other command, `--shape summary` is a usage error (v1 §5 — honest rejection
 * for a soon-frozen contract, not a silent fallback to `human`).
 */
const SHAPE_SUMMARY_COMMANDS = new Set(["show"]);

// ── `results` collection alias ──────────────────────────────────────────────
//
// Every list-returning command names its collection differently (`hits`,
// `items`, `proposals`, `sources`, ...) — a caller cannot write one accessor
// across commands without a per-command lookup table, and the wrong guess
// (`d.get("hits")` against a `curate` response) reads as "no results" rather
// than "wrong key", with nothing in the envelope to correct it.
//
// This maps each list-returning command to the field already holding its
// collection, and `withResultsAlias` below adds a `results` key pointing at
// that SAME array (not a copy) to the shaped output — in every `--shape` /
// `--detail` combination, `human` included, so `--shape agent` needs no
// separate handling to "guarantee" it. A new list-returning command MUST add
// an entry here; there is no way to detect a missed one automatically, so the
// survey deliberately lives in this one place rather than scattered per
// handler.
const LIST_RESULT_COLLECTION_KEYS: Readonly<Record<string, string>> = {
  search: "hits",
  curate: "items",
  "registry-search": "hits",
  "proposal-list": "proposals",
  list: "sources", // `akm bundle list`
  "env-list": "envs",
  "secret-list": "secrets",
  "registry-list": "registries",
  "workflow-list": "runs",
  "task-history": "rows",
  "log-list": "events", // `akm log list`
  "config-diff": "rows", // `akm config diff`
  "models-list": "rows", // `akm models list`
};

function withResultsAlias(command: OutputCommandName, shaped: unknown): unknown {
  const key = LIST_RESULT_COLLECTION_KEYS[command];
  if (!key) return shaped;
  if (shaped === null || typeof shaped !== "object" || Array.isArray(shaped)) return shaped;
  const obj = shaped as Record<string, unknown>;
  if ("results" in obj) return shaped;
  const collection = obj[key];
  if (!Array.isArray(collection)) return shaped;
  // Same array reference as `obj[key]`, never a copy, so `results` cannot
  // silently drift out of sync with the semantic key it aliases.
  return { ...obj, results: collection };
}

export function shapeForCommand(
  command: OutputCommandName,
  result: unknown,
  detail: DetailLevel,
  shape: ShapeMode = "human",
): unknown {
  let effectiveShape = shape;
  if (shape === "summary" && !SHAPE_SUMMARY_COMMANDS.has(command)) {
    warnOnce(
      `shape-summary-unsupported:${command}`,
      `[output] '--shape summary' is not supported for 'akm ${command}' (only 'akm show' has a summary projection); falling back to 'agent'.`,
    );
    effectiveShape = "agent";
  }
  const handler = getOutputShapeHandler(command);
  if (handler) {
    return withResultsAlias(command, handler(result, detail, effectiveShape));
  }
  // v1 spec §9 (output-shape registry exhaustive): no silent JSON.stringify
  // fallback. A missing case here is a registration bug — fail loudly so
  // the caller (or its tests) sees the missing command name.
  throw new Error(`output shape not registered for command: ${command}`);
}
