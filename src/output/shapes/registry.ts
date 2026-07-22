// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Output shape registry.
 *
 * Separated from `shapes.ts` so per-command shape modules can import
 * `registerOutputShape` without creating a circular dependency back into
 * the main shapes module.
 */

import { createCommandRegistry } from "../command-registry";
import type { DetailLevel, ShapeMode } from "../context";

/**
 * Handler signature for a registered output shape.
 *
 * @param result  Raw command result object.
 * @param detail  Active detail level (verbosity).
 * @param shape   Active output-projection mode (human|agent|summary).
 * @returns Shaped result (may be the same reference if no trimming needed).
 */
export type OutputShapeHandler = (result: unknown, detail: DetailLevel, shape: ShapeMode) => unknown;

/**
 * A single output-shape registration: a command name plus its handler.
 *
 * Per-command modules EXPORT arrays of these entries (pure data, no top-level
 * side effect). The central `shapes.ts` barrel imports those exports and feeds
 * them to {@link registerOutputShapes} in one deterministic, order-independent
 * pass. Because the assembly array references each module's named export, a
 * dropped registration is a COMPILE error, not a silent runtime gap.
 */
export interface OutputShapeEntry {
  command: string;
  handler: OutputShapeHandler;
}

const OUTPUT_SHAPE_REGISTRY = createCommandRegistry<OutputShapeHandler>();

/**
 * Register an output shape handler for a command name.
 *
 * Call this at module load time from a `src/output/shapes/<command>.ts` file.
 * Multiple command names may share the same handler — call once per name.
 *
 * ```ts
 * registerOutputShape("my-command", (result, detail) => result);
 * ```
 */
export function registerOutputShape(command: string, handler: OutputShapeHandler): void {
  OUTPUT_SHAPE_REGISTRY.register(command, handler);
}

/**
 * Register a batch of {@link OutputShapeEntry} definitions in iteration order.
 *
 * This is the explicit-assembly entry point used by `shapes.ts`: the built-in
 * shape set is registered by iterating a single explicit list exactly once,
 * with no reliance on module import order.
 */
export function registerOutputShapes(entries: Iterable<OutputShapeEntry>): void {
  OUTPUT_SHAPE_REGISTRY.registerAll(entries);
}

/**
 * Remove a previously-registered output shape. Test-only utility.
 */
export function deregisterOutputShape(command: string): void {
  OUTPUT_SHAPE_REGISTRY.deregister(command);
}

/**
 * Look up a registered output shape handler by command name.
 * Returns `undefined` if not registered.
 */
export function getOutputShapeHandler(command: string): OutputShapeHandler | undefined {
  return OUTPUT_SHAPE_REGISTRY.get(command);
}
