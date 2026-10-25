// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { defaultConnection } from "../../core/config/config";
import type { AkmConfig, EmbeddingConnectionConfig } from "../../core/config/config-types";
import { warnOnce } from "../../core/warn";
import { openAiBaseUrl } from "../client";

/**
 * The embedding block as the embedder uses it. `embedding.model` without an
 * `embedding.endpoint` means the model is served by the default connection: its
 * endpoint, and its key (its `$VAR`, else `credentials.json` under its name).
 * With no default connection there is nothing to serve it, so the built-in local
 * embedder runs, with one warning. Computed where the embedder is used and never
 * stored, so a config write cannot persist it.
 */
export function effectiveEmbedding(config: AkmConfig): EmbeddingConnectionConfig | undefined {
  const embedding = config.embedding;
  if (!embedding || embedding.endpoint !== undefined || !embedding.model) return embedding;
  const found = defaultConnection(config);
  if (!found) {
    warnOnce(
      "embedding:no-default-connection",
      "embedding.model is set, but there is no embedding.endpoint and no default connection to serve it; using the built-in local embedder. Add a connection with `akm setup`.",
    );
    return embedding;
  }
  return {
    ...embedding,
    endpoint: openAiBaseUrl(found.connection.endpoint),
    ...(found.connection.apiKey !== undefined ? { apiKey: found.connection.apiKey } : {}),
    credentialName: found.name,
  };
}
