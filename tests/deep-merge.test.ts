// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import { deepMergeConfig } from "../src/core/config/deep-merge";

describe("deepMergeConfig", () => {
  test("recursively merges plain objects while replacing arrays and preserving explicit values", () => {
    const merged = deepMergeConfig(
      { nested: { keep: 1, replace: true }, values: ["old"], nullable: 100 },
      { nested: { replace: false, added: 0 }, values: [], nullable: null },
    );

    expect(merged).toEqual({
      nested: { keep: 1, replace: false, added: 0 },
      values: [],
      nullable: null,
    });
  });

  test("rejects prototype-pollution keys at every depth", () => {
    expect(() => deepMergeConfig({}, JSON.parse('{"nested":{"__proto__":{"polluted":true}}}'))).toThrow(
      "Unsafe configuration key",
    );
  });
});
