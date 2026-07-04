// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Setup wizard step: enable/disable semantic search and decide whether to
 * prepare its assets now.
 */

import * as p from "../../cli/clack";
import type { AkmConfig, EmbeddingConnectionConfig } from "../../core/config/config";
import { prompt } from "../prompt";
import { describeSemanticSearchAssets, isRemoteEmbeddingConfig } from "../semantic-assets";

export interface SemanticSearchChoice {
  mode: "off" | "auto";
  prepareAssets: boolean;
}

export async function stepSemanticSearch(
  current: AkmConfig,
  embedding?: EmbeddingConnectionConfig,
): Promise<SemanticSearchChoice> {
  const enabled = await prompt(() =>
    p.confirm({
      message: "Enable semantic search?",
      initialValue: current.semanticSearchMode !== "off",
    }),
  );

  if (!enabled) {
    return { mode: "off", prepareAssets: false };
  }

  p.note(describeSemanticSearchAssets(embedding).join("\n"), "Semantic Search Assets");

  const prepareAssets = await prompt(() =>
    p.confirm({
      message: isRemoteEmbeddingConfig(embedding)
        ? "Check the embedding endpoint and verify semantic search now?"
        : "Download and verify semantic-search assets now?",
      initialValue: true,
    }),
  );

  return { mode: "auto", prepareAssets };
}
