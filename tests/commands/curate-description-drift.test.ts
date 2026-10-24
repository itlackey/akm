// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * #951 (item E, docs/architecture/specs/0.9.0-docs-code-drift-register.md
 * Q-10): `akm curate` never implemented reranking — `curate_rerank` was
 * removed in 0.8.0 and no `--rerank` flag or reranking behavior exists in
 * `curate.ts`. The command's own description string used to claim
 * otherwise ("reranks by intent"); pin that it no longer does, so the claim
 * cannot silently drift back in without a matching implementation.
 */

import { describe, expect, test } from "bun:test";
import { curateCommand } from "../../src/commands/read/search-cli";

describe("curate command description", () => {
  test("does not claim reranking, which akm curate does not implement", () => {
    const meta = curateCommand.meta as { description?: string } | undefined;
    const description = String(meta?.description ?? "");
    expect(description.toLowerCase()).not.toContain("rerank");
  });
});
