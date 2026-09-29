// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `proposalContent` on a `delete`-primary change (alpha.9 consolidate retire
 * proposals): every generic proposal scan (dedup-by-body-hash, the triage
 * drain's diff-size filter, the quality validators) calls this on ANY
 * pending proposal, retire included, so it must never throw for a
 * well-formed delete.
 */

import { describe, expect, test } from "bun:test";
import type { FileChange } from "../../src/core/file-change";
import { proposalContent } from "../../src/core/file-change";

describe("proposalContent", () => {
  test("a create/update primary change reads its `after`", () => {
    const changes: FileChange[] = [{ path: "memories/a.md", op: "update", after: "body" }];
    expect(proposalContent({ changes })).toBe("body");
  });

  test("a delete primary change reads as empty, not a throw", () => {
    const changes: FileChange[] = [{ path: "memories/a.md", op: "delete" }];
    expect(proposalContent({ changes })).toBe("");
  });

  test("a malformed create/update with no `after` still throws (genuine corruption)", () => {
    const changes: FileChange[] = [{ path: "memories/a.md", op: "update" }];
    expect(() => proposalContent({ changes })).toThrow();
  });

  test("no changes at all still throws", () => {
    expect(() => proposalContent({ changes: [] })).toThrow();
  });
});
