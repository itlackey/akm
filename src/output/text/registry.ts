// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Plain-text formatter registry.
 *
 * Separated from `text.ts` so per-command formatter modules can import
 * `registerTextFormatter` without creating a circular dependency back into
 * the main text module.
 */

import type { DetailLevel } from "../context";

/**
 * Handler signature for a registered plain-text formatter.
 *
 * Return a string to render as plain text, or `null` to fall through to YAML.
 */
export type TextFormatterHandler = (result: Record<string, unknown>, detail: DetailLevel) => string | null;

const TEXT_FORMATTER_REGISTRY = new Map<string, TextFormatterHandler>();

/**
 * Register a plain-text formatter for a command name.
 *
 * Call this at module load time from a `src/output/text/<command>.ts` file.
 * Multiple command names may share the same handler — call once per name.
 *
 * ```ts
 * registerTextFormatter("my-command", (r) => `done: ${r.ref}`);
 * ```
 */
export function registerTextFormatter(command: string, handler: TextFormatterHandler): void {
  TEXT_FORMATTER_REGISTRY.set(command, handler);
}

/**
 * Remove a previously-registered text formatter. Test-only utility.
 */
export function deregisterTextFormatter(command: string): void {
  TEXT_FORMATTER_REGISTRY.delete(command);
}

/**
 * Look up a registered text formatter by command name.
 * Returns `undefined` if not registered.
 */
export function getTextFormatterHandler(command: string): TextFormatterHandler | undefined {
  return TEXT_FORMATTER_REGISTRY.get(command);
}
