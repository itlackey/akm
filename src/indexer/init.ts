// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Explicit composition root for the indexer's built-in registrations.
 *
 * Registering the built-in renderer set on first use would be implicit,
 * order-dependent wiring, so `initIndexer()` is a single deterministic,
 * idempotent entry point. It registers, exactly once:
 *
 *  1. Built-in renderers — `registerBuiltinRenderers()` (`output/renderers.ts`),
 *     which value-imports the workflow renderers from `workflows/renderer.ts`.
 *
 * Recognition is not registry-driven: the akm adapter's synchronous
 * `recognizeMatch()` (`core/adapter/adapters/akm-adapter.ts`) does it, so no
 * matcher registration happens here. Index-time metadata is likewise not
 * registry-driven: the `akm` adapter's synchronous `foldRecognizedMetadata`
 * (`core/adapter/adapters/akm-metadata.ts`) computes it inline during recognize.
 *
 * This is a *lazy* gate, awaited from the accessor call sites, so no startup
 * work is forced eagerly. The shared promise makes concurrent and repeat calls safe —
 * the registrations run at most once per process.
 */

let initPromise: Promise<void> | undefined;

/**
 * Idempotently register every built-in indexer renderer.
 *
 * Safe to call repeatedly and concurrently: the registration work runs at most
 * once; subsequent calls await the same resolved promise.
 */
export function initIndexer(): Promise<void> {
  if (!initPromise) {
    initPromise = (async () => {
      // Importing renderers exposes registerBuiltinRenderers(); it value-imports
      // the workflow renderers, so no separate workflows/renderer import is needed.
      const { registerBuiltinRenderers } = await import("../output/renderers.js");
      registerBuiltinRenderers();
    })();
  }
  return initPromise;
}
