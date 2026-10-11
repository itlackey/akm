// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, it } from "bun:test";
import { isConsolidationEligibleMemoryName } from "../../../src/commands/improve/consolidate";

describe("isConsolidationEligibleMemoryName", () => {
  it("excludes .derived memories", () => {
    expect(isConsolidationEligibleMemoryName("foo.derived")).toBe(false);
  });
  it("includes normal memories", () => {
    expect(isConsolidationEligibleMemoryName("foo")).toBe(true);
  });
});
