// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** `akm metrics` attaches the raw window rows for `--detail full`, and only then. */

import { describe, expect, test } from "bun:test";
import { metricsIncludeRows } from "../src/commands/metrics/metrics";

describe("metricsIncludeRows", () => {
  test.each([
    ["full", true],
    ["normal", false],
    ["brief", false],
  ] as const)("%s detail -> %p", (detail, expected) => {
    expect(metricsIncludeRows({ detail })).toBe(expected);
  });
});
