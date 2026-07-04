// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Generic recursive object merge, extracted from the setup wizard (it is not
 * setup-specific). Plain objects merge key-by-key; arrays and scalars replace
 * wholesale. Used to apply a partial `--file` config over the existing config
 * without dropping sibling subkeys.
 */

/** True for non-null, non-array plain objects. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Recursively merge `incoming` into `base`: plain objects merge key-by-key,
 * while arrays and scalars replace wholesale. A partial input therefore only
 * updates the keys it carries and never drops sibling subkeys (e.g. a file
 * containing `{ output: { format: "text" } }` leaves `output.detail` intact).
 *
 * `base` is treated as immutable — a fresh object graph is returned.
 */
export function deepMergeConfig<T>(base: T, incoming: unknown): T {
  if (!isPlainObject(incoming)) return incoming as T;
  const baseObj = isPlainObject(base) ? (base as Record<string, unknown>) : {};
  const out: Record<string, unknown> = { ...baseObj };
  for (const [key, value] of Object.entries(incoming)) {
    if (value === undefined) continue;
    if (isPlainObject(value) && isPlainObject(baseObj[key])) {
      out[key] = deepMergeConfig(baseObj[key], value);
    } else {
      out[key] = value;
    }
  }
  return out as T;
}
