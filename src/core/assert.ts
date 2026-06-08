// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * assert.ts — exhaustiveness keystone.
 *
 * `assertNever` is the single helper the exhaustive-switch refactors consume.
 * Placing it in the `never` arm of a `switch`/`if` chain turns any unhandled
 * union variant into a *compile-time* error (the argument no longer narrows to
 * `never`), and — if the impossible case is somehow reached at runtime — throws
 * with the offending value serialized for diagnostics instead of silently
 * falling through.
 */

/**
 * Assert that a code path is unreachable.
 *
 * Call this in the default/else arm of an exhaustive dispatch over a union. If
 * a new variant is added to the union without a handling arm, the call site
 * stops type-checking, surfacing the drift at compile time.
 *
 * @param x the value the type system has narrowed to `never`
 * @param context optional label included in the thrown message for diagnostics
 * @throws always — this function never returns
 */
export function assertNever(x: never, context?: string): never {
  let serialized: string;
  try {
    serialized = JSON.stringify(x);
  } catch {
    // Circular structures / non-serializable values fall back to String().
    serialized = String(x);
  }
  if (serialized === undefined) {
    // JSON.stringify(undefined) returns undefined, not a string.
    serialized = String(x);
  }
  const where = context ? ` (${context})` : "";
  throw new Error(`Unexpected value reached assertNever${where}: ${serialized}`);
}
