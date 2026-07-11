// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import { redactSensitiveText } from "../src/core/redaction";

describe("redactSensitiveText", () => {
  test("redacts exact values longest-first without treating them as patterns", () => {
    expect(
      redactSensitiveText("long-secret and secret and cost=$&-sentinel", ["secret", "long-secret", "$&-sentinel"]),
    ).toBe("[REDACTED] and [REDACTED] and cost=[REDACTED]");
  });

  test("ignores empty and short values that would destroy ordinary output", () => {
    expect(redactSensitiveText("a=abc ab=a", ["", "a", "ab", "abc"])).toBe("a=abc ab=a");
  });
});
