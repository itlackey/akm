// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** `akm metrics` attaches the raw window rows for `--format html` and `--detail full`, and only then. */

import { describe, expect, test } from "bun:test";
import { metricsIncludeRows } from "../src/commands/metrics/metrics-cli";

describe("metricsIncludeRows", () => {
  test.each([
    ["html", "brief", true],
    ["html", "normal", true],
    ["json", "full", true],
    ["text", "full", true],
    ["json", "brief", false],
    ["yaml", "normal", false],
    ["md", "brief", false],
  ] as const)("%s at %s detail -> %p", (format, detail, expected) => {
    expect(metricsIncludeRows({ format, detail })).toBe(expected);
  });
});
