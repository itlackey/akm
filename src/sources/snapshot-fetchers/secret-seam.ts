// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { resolveSecretPath } from "../../core/env-secret-ref";
import { readValue } from "../../core/secret-value";
import type { SecretResolver } from "../provider";

/**
 * Reads a secret out of akm's secret store for the fetcher `resolveSecret`
 * seam (see `FetcherContext.resolveSecret`).
 *
 * This module — NOT the fetchers themselves — is what imports
 * `core/env-secret-ref`. That module transitively imports the source
 * providers, which import the fetcher registry, so a fetcher importing it
 * directly would close an import cycle. Keeping the dependency here lets the
 * fetchers stay leaves while still reaching the store.
 *
 * Returns null for any failure — missing store, unresolvable ref, unreadable
 * file. The underlying error is deliberately not surfaced: it can embed
 * filesystem paths, and every failure means the same thing to a caller ("no
 * secret"). The value itself is never logged.
 */
export function resolveSecretFromStore(ref: string): string | null {
  try {
    const { absPath } = resolveSecretPath(ref);
    return readValue(absPath) || null;
  } catch {
    return null;
  }
}

/**
 * The single store-backed {@link SecretResolver}, constructed here because this
 * is the only module in the sources tree sanctioned to import
 * `core/env-secret-ref`. Composition roots above the import cycle
 * (`indexer/indexer.ts` for the `sync()`/bundle-update path, and the
 * `akm import` / `akm bundle add` command handlers) inject this so in-cycle
 * consumers depend only on the `SecretResolver` interface, never on the reader.
 */
export const storeSecretResolver: SecretResolver = {
  resolveSecret: resolveSecretFromStore,
};
