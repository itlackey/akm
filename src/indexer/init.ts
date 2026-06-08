// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Explicit composition root for the indexer's built-in registrations.
 *
 * Historically two independent lazy gates (`ensureBuiltinsRegistered` in
 * `walk/file-context.ts` and `ensureBuiltinMetadataContributorsRegistered` in
 * `passes/metadata-contributors.ts`) each registered a different built-in set
 * on first use. That implicit, order-dependent wiring is the M1/M2 finding in
 * `docs/technical/code-health-brittleness-audit.md`.
 *
 * `initIndexer()` folds both into a single deterministic, idempotent entry
 * point. It registers, exactly once:
 *
 *  1. Built-in matchers   — `registerBuiltinMatchers()` (`walk/matchers.ts`).
 *  2. Built-in renderers  — `registerBuiltinRenderers()` (`output/renderers.ts`).
 *  3. Metadata contributors — top-level registration side-effects that run when
 *     `output/renderers.ts` and `workflows/renderer.ts` are imported.
 *
 * Importing `output/renderers.ts` satisfies both (2) and the renderer-owned
 * metadata contributors; `workflows/renderer.ts` is imported explicitly for the
 * workflow contributor (it is already transitively pulled in by renderers, but
 * the explicit import preserves the original gate's import set and keeps the
 * wiring self-documenting).
 *
 * Timing is preserved: this stays a *lazy* gate. It is awaited from the same
 * accessor call sites the old gates were awaited from, so no startup work is
 * forced eagerly. The shared promise makes concurrent and repeat calls safe —
 * the registrations run at most once per process.
 */

let initPromise: Promise<void> | undefined;

/**
 * Idempotently register every built-in indexer contributor (matchers,
 * renderers, and metadata contributors).
 *
 * Safe to call repeatedly and concurrently: the registration work runs at most
 * once; subsequent calls await the same resolved promise.
 */
export function initIndexer(): Promise<void> {
  if (!initPromise) {
    initPromise = (async () => {
      const { registerBuiltinMatchers } = await import("./walk/matchers.js");
      // Importing renderers registers the built-in metadata contributors as a
      // load-time side-effect and exposes registerBuiltinRenderers().
      const { registerBuiltinRenderers } = await import("../output/renderers.js");
      // Imported for the workflow metadata contributor's load-time side-effect.
      await import("../workflows/renderer.js");
      registerBuiltinMatchers();
      registerBuiltinRenderers();
    })();
  }
  return initPromise;
}
