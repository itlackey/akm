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

import { createCommandRegistry } from "../command-registry";
import type { DetailLevel } from "../context";

/**
 * Handler signature for a registered plain-text formatter.
 *
 * Return a string to render as plain text, or `null` to fall through to YAML.
 */
export type TextFormatterHandler = (result: Record<string, unknown>, detail: DetailLevel) => string | null;

/**
 * A single text-formatter registration: a command name plus its handler.
 *
 * Per-command modules EXPORT arrays of these entries (pure data, no top-level
 * side effect). The central `text.ts` barrel imports those exports and feeds
 * them to {@link registerTextFormatters} in one deterministic, order-independent
 * pass. Because the assembly array references each module's named export, a
 * dropped registration is a COMPILE error, not a silent runtime gap.
 */
export interface TextFormatterEntry {
  command: string;
  handler: TextFormatterHandler;
}

const TEXT_FORMATTER_REGISTRY = createCommandRegistry<TextFormatterHandler>();

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
  TEXT_FORMATTER_REGISTRY.register(command, handler);
}

/**
 * Register a batch of {@link TextFormatterEntry} definitions in iteration order.
 *
 * This is the explicit-assembly entry point used by `text.ts`: the built-in
 * formatter set is registered by iterating a single explicit list exactly once,
 * with no reliance on module import order.
 */
export function registerTextFormatters(entries: Iterable<TextFormatterEntry>): void {
  TEXT_FORMATTER_REGISTRY.registerAll(entries);
}

/**
 * Remove a previously-registered text formatter. Test-only utility.
 */
export function deregisterTextFormatter(command: string): void {
  TEXT_FORMATTER_REGISTRY.deregister(command);
}

/**
 * Look up a registered text formatter by command name.
 * Returns `undefined` if not registered.
 */
export function getTextFormatterHandler(command: string): TextFormatterHandler | undefined {
  return TEXT_FORMATTER_REGISTRY.get(command);
}
