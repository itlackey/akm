// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import { buildPrefixQuery, sanitizeFtsQuery } from "../src/indexer/search/fts-query";

// These are pure string helpers extracted out of indexer/db/db.ts — they touch
// no database state, so they are tested here in complete isolation.

describe("sanitizeFtsQuery", () => {
  test("splits compound identifiers into AND-joined tokens", () => {
    expect(sanitizeFtsQuery("code-review")).toBe("code review");
    expect(sanitizeFtsQuery("k8s.setup")).toBe("k8s setup");
    expect(sanitizeFtsQuery("deploy_prod")).toBe("deploy_prod");
  });

  test("strips FTS5 syntax characters", () => {
    expect(sanitizeFtsQuery('"hello" (world) test*')).toBe("hello world test");
  });

  test("neutralizes the NEAR proximity operator", () => {
    expect(sanitizeFtsQuery("NEAR foo bar")).toBe("foo bar");
  });

  test("returns empty string when nothing survives sanitization", () => {
    expect(sanitizeFtsQuery("")).toBe("");
    expect(sanitizeFtsQuery('"()*:^{}')).toBe("");
  });

  test("preserves short (single-character) tokens", () => {
    expect(sanitizeFtsQuery("R")).toBe("R");
    expect(sanitizeFtsQuery("R language")).toBe("R language");
  });
});

describe("buildPrefixQuery", () => {
  test("appends * to tokens 3+ chars long", () => {
    expect(buildPrefixQuery("deploy prod")).toBe("deploy* prod*");
  });

  test("keeps short (<3 char) tokens unexpanded but expands longer ones", () => {
    expect(buildPrefixQuery("ai deploy")).toBe("ai deploy*");
  });

  test("returns null when no token qualifies for prefix expansion", () => {
    expect(buildPrefixQuery("ai ml")).toBeNull();
    expect(buildPrefixQuery("")).toBeNull();
  });
});
