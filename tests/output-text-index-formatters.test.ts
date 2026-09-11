// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Regression coverage for W5/W6 (index-redesign write-path fixes): `akm
// index`'s `IndexResponse` renamed `directoriesScanned` -> `sourcesScanned`
// (reconcile is a flat per-file stat walk, not a directory walk — see
// src/indexer/indexer.ts) and dropped the always-0 `directoriesSkipped`
// along with the misleadingly-named `generatedMetadata` (renamed to
// `entriesUpserted`, which formatIndexPlain does not render). This pins the
// text renderer to the CURRENT field names and wording, not the deleted
// "directories" ones.

import { describe, expect, it } from "bun:test";
import { formatIndexPlain } from "../src/output/text/command-format";

describe("formatIndexPlain", () => {
  it("renders sourcesScanned as 'source(s)', not the deleted 'directories' wording", () => {
    const text = formatIndexPlain({
      totalEntries: 5,
      sourcesScanned: 1,
      mode: "full",
    });
    expect(text).toBe("Indexed 5 entries from 1 source (mode: full)");
    expect(text).not.toContain("director");
  });

  it("pluralizes 'sources' when more than one source was scanned", () => {
    const text = formatIndexPlain({
      totalEntries: 12,
      sourcesScanned: 3,
      mode: "incremental",
    });
    expect(text).toBe("Indexed 12 entries from 3 sources (mode: incremental)");
  });

  it("falls back to 0 sources when the field is absent, same as before the rename", () => {
    const text = formatIndexPlain({ totalEntries: 0, mode: "incremental" });
    expect(text).toBe("Indexed 0 entries from 0 sources (mode: incremental)");
  });
});
