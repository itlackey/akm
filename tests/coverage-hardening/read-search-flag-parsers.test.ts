// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Coverage for the `akm search` flag parsers that gate which pool and which
 * belief slice a search runs against. `parseBeliefFilterMode` had ZERO tests;
 * `parseSearchSource` had only envelope-level coverage. Both are pure and
 * branchy, and a silent regression (e.g. the `local`→`stash` alias breaking,
 * or the belief throw-branch being downgraded to a silent default) would
 * quietly change what results a user sees with no failing test.
 */

import { describe, expect, test } from "bun:test";
import { parseBeliefFilterMode, parseSearchSource } from "../../src/commands/read/search";
import { UsageError } from "../../src/core/errors";

describe("parseBeliefFilterMode", () => {
  test("undefined defaults to 'all'", () => {
    expect(parseBeliefFilterMode(undefined)).toBe("all");
  });

  test("explicit 'all' stays 'all'", () => {
    expect(parseBeliefFilterMode("all")).toBe("all");
  });

  test("'current' and 'historical' pass through", () => {
    expect(parseBeliefFilterMode("current")).toBe("current");
    expect(parseBeliefFilterMode("historical")).toBe("historical");
  });

  test("an unknown value throws UsageError (INVALID_FLAG_VALUE), not a silent default", () => {
    let err: unknown;
    try {
      parseBeliefFilterMode("bogus");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(UsageError);
    expect((err as UsageError).message).toContain("all|current|historical");
  });

  test("case-sensitive: 'All' / 'CURRENT' are rejected (no accidental normalization)", () => {
    expect(() => parseBeliefFilterMode("All")).toThrow(UsageError);
    expect(() => parseBeliefFilterMode("CURRENT")).toThrow(UsageError);
  });

  test("empty string is rejected (not treated as the 'all' default)", () => {
    expect(() => parseBeliefFilterMode("")).toThrow(UsageError);
  });
});

describe("parseSearchSource", () => {
  test("canonical values pass through unchanged", () => {
    expect(parseSearchSource("stash")).toBe("stash");
    expect(parseSearchSource("registry")).toBe("registry");
    expect(parseSearchSource("both")).toBe("both");
  });

  test("'local' is an alias for 'stash'", () => {
    expect(parseSearchSource("local")).toBe("stash");
  });

  test("undefined defaults to 'stash'", () => {
    expect(parseSearchSource(undefined)).toBe("stash");
  });

  test("an unknown string passes through verbatim (a named source resolved later)", () => {
    // Must NOT be coerced to 'stash' — akmSearch validates named sources against
    // config and needs the original string to look it up / error helpfully.
    expect(parseSearchSource("team-stash")).toBe("team-stash");
  });
});
