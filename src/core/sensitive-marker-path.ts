// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Path to the sibling marker file that suppresses listing for a sensitive
 * env/secret asset. Deliberately its own leaf module (no imports) rather than
 * living on `core/env-secret-ref.ts` (#950 originally put it there): that
 * module transitively imports the source providers via
 * `indexer/search/search-source`, and `commands/env/env.ts` is imported back
 * from `core/adapter/adapters/akm-metadata.ts` (for `scanEnvKeyNames`) — so an
 * `env.ts` import of the heavier module closes a real cycle through the
 * adapter registry (`core/adapter/adapters/index.ts`'s `BUILTIN_ADAPTERS`
 * construction sees `akmAdapter` still TDZ). Keeping this helper leaf-only
 * lets `commands/env/env.ts` and `core/env-secret-ref.ts` both depend on it
 * without either pulling the other's heavier graph.
 */
export function sensitiveMarkerPath(assetPath: string, type: "env" | "secret"): string {
  return type === "env" ? assetPath.replace(/\.env$/, ".sensitive") : `${assetPath}.sensitive`;
}
