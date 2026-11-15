// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import { checkUnquotedDescriptionColon } from "../src/core/asset/frontmatter-lint";

describe("checkUnquotedDescriptionColon", () => {
  test("accepts plain descriptions whose colons are valid YAML (URLs, scope:name)", () => {
    expect(checkUnquotedDescriptionColon("description: See https://example.com/docs for details.")).toBeNull();
    expect(checkUnquotedDescriptionColon("description: Needs the admin:snapshot scope.")).toBeNull();
  });

  test("a colon-bearing description is not blamed for malformed YAML elsewhere", () => {
    expect(checkUnquotedDescriptionColon("description: See https://example.com\ntags: [unclosed")).toBeNull();
  });

  test("flags a wrapped plain description whose continuation is malformed", () => {
    expect(checkUnquotedDescriptionColon("description: See https://example.com\n  and more: text")).toContain(
      "unquoted colon",
    );
  });

  test("accepts quoted descriptions wrapped across physical lines", () => {
    expect(
      checkUnquotedDescriptionColon(
        'description: "A long quoted description: remains valid when YAML wraps it\n  across physical lines."',
      ),
    ).toBeNull();
  });

  test("accepts folded and literal block descriptions containing colons", () => {
    expect(checkUnquotedDescriptionColon("description: >-\n  Folded: description")).toBeNull();
    expect(checkUnquotedDescriptionColon("description: |-\n  Literal: description")).toBeNull();
  });

  test("retains a finding for an ambiguous malformed plain scalar", () => {
    expect(checkUnquotedDescriptionColon("description: Proposal lint: blocks invalid output.")).toContain(
      "unquoted colon",
    );
  });
});
