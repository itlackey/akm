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

const OUTPUT_SHAPE_REGISTRY = new Map<string, OutputShapeHandler>();

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
  OUTPUT_SHAPE_REGISTRY.set(command, handler);
}

/**
 * Remove a previously-registered output shape. Test-only utility.
 */
export function deregisterOutputShape(command: string): void {
  OUTPUT_SHAPE_REGISTRY.delete(command);
}

/**
 * Look up a registered output shape handler by command name.
 * Returns `undefined` if not registered.
 */
export function getOutputShapeHandler(command: string): OutputShapeHandler | undefined {
  return OUTPUT_SHAPE_REGISTRY.get(command);
}
