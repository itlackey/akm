// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * #951: `akm curate` has no reranking step, and the command's own description
 * string must not claim one. Pin that, so the claim cannot silently drift back
 * in without a matching implementation.
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
