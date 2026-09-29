// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Lexical query building: the query's non-stopword tokens, matched with OR.
 */

import { describe, expect, test } from "bun:test";
import { ftsOrMatch, ftsQueryTokens } from "../src/indexer/search/fts-query";

describe("ftsQueryTokens", () => {
  test("NFKC-normalizes, lowercases and deduplicates Unicode tokens", () => {
    expect(ftsQueryTokens("CAFÉ café Ｄｏｃｋｅｒ docker")).toEqual(["café", "docker"]);
  });

  test("drops stopwords from a natural-language question", () => {
    expect(ftsQueryTokens("How do I fix the Docker healthcheck for llama.cpp?")).toEqual([
      "fix",
      "docker",
      "healthcheck",
      "llama",
      "cpp",
    ]);
  });

  test("keeps every token when the query is only stopwords", () => {
    expect(ftsQueryTokens("how to")).toEqual(["how", "to"]);
    expect(ftsQueryTokens("What is it?")).toEqual(["what", "is", "it"]);
  });

  test("splits identifiers on punctuation and never truncates a long query", () => {
    expect(ftsQueryTokens("code-review k8s.setup deploy_prod")).toEqual([
      "code",
      "review",
      "k8s",
      "setup",
      "deploy",
      "prod",
    ]);
    const long = Array.from({ length: 500 }, (_, index) => `tok${index}`).join(" ");
    expect(ftsQueryTokens(long)).toHaveLength(500);
  });

  test("returns nothing for input with no letters or numbers", () => {
    expect(ftsQueryTokens('"()*:^{}')).toEqual([]);
    expect(ftsQueryTokens("")).toEqual([]);
  });
});

describe("ftsOrMatch", () => {
  test("quotes every token and joins them with OR", () => {
    expect(ftsOrMatch(["near", "foo"])).toBe('"near" OR "foo"');
    expect(ftsOrMatch(ftsQueryTokens("NEAR(foo, bar) AND baz"))).toBe('"near" OR "foo" OR "bar" OR "baz"');
  });
});
