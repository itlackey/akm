// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import { DistillProcessConfigSchema, ReflectProcessConfigSchema } from "../src/core/config/config-schema";

// WIKI (R12): reflect's process config accepts an optional excludeRefPrefixes
// conceptId-prefix filter (raw wiki-ingest snapshots are type `knowledge`, so
// the type-only allowedTypes filter can't exclude them). distill/consolidate
// are memory-only and never read this filter, so their narrow schemas reject it.
describe("processes.reflect.excludeRefPrefixes config", () => {
  test("reflect accepts excludeRefPrefixes", () => {
    const result = ReflectProcessConfigSchema.safeParse({
      excludeRefPrefixes: ["knowledge/wikis/articles/raw"],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.excludeRefPrefixes).toEqual(["knowledge/wikis/articles/raw"]);
    }
  });

  test("distill rejects excludeRefPrefixes", () => {
    const result = DistillProcessConfigSchema.safeParse({
      excludeRefPrefixes: ["knowledge/wikis/articles/raw"],
    });
    expect(result.success).toBe(false);
  });
});
