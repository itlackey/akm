// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import { prerequisiteGap } from "./_helpers/prerequisites";

describe("a test's machine prerequisite", () => {
  test("a met prerequisite has no gap, in CI or not", () => {
    expect(prerequisiteGap("non-root", { met: true, ci: false })).toBeUndefined();
    expect(prerequisiteGap("non-root", { met: true, ci: true })).toBeUndefined();
  });

  test("an unmet one is a skip reason locally", () => {
    expect(prerequisiteGap("non-root", { met: false, ci: false })).toContain("running as root");
  });

  test("an unmet one fails under CI, naming the reason", () => {
    expect(() => prerequisiteGap("non-root", { met: false, ci: true })).toThrow(/CI must meet.*running as root/);
  });
});
