// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * #955: `hashEmbeddableText` is the ONE hash function embedding-salvage
 * writes (at a discard) and reuse lookups (at the next embedding pass) must
 * agree on — a stable, deterministic sha256 keyed on the exact search_text
 * bytes, so a single-byte content change never falsely reuses a stale
 * vector. Pure/in-memory, no database — belongs under tests/, not
 * tests/integration/.
 */

import { describe, expect, test } from "bun:test";
import { hashEmbeddableText } from "../src/storage/repositories/embedding-salvage-repository";

describe("hashEmbeddableText (#955)", () => {
  test("is deterministic: the same text always hashes the same way", () => {
    const a = hashEmbeddableText("alpha bravo charlie");
    const b = hashEmbeddableText("alpha bravo charlie");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  test("a single-byte difference produces a different hash", () => {
    expect(hashEmbeddableText("alpha bravo charlie")).not.toBe(hashEmbeddableText("alpha bravo charliE"));
  });

  test("is stable across calls in a process (no hidden salt/randomness)", () => {
    const hashes = new Set(Array.from({ length: 5 }, () => hashEmbeddableText("stable input")));
    expect(hashes.size).toBe(1);
  });

  test("distinguishes empty string from other short inputs", () => {
    expect(hashEmbeddableText("")).not.toBe(hashEmbeddableText(" "));
  });
});
