// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import { getAssetTypes } from "../src/core/asset/asset-spec";
import * as ftsQueryModule from "../src/indexer/search/fts-query";

// These are pure string helpers extracted out of indexer/db/db.ts — they touch
// no database state, so they are tested here in complete isolation.

const { buildPrefixQuery, sanitizeFtsQuery } = ftsQueryModule;

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

// ── SPEC-4: parseRefPrefixQuery ──────────────────────────────────────────────
//
// Pure parser behind the ref-prefix search idiom `akm search "<type>:<prefix>/"`
// (docs/design/stash-conventions-code-spec.md, SPEC-4). It decides whether a raw
// query is a typed subtree-enumeration request or an ordinary keyword search.
// The export is looked up dynamically (instead of a named import) so that while
// the implementation does not exist yet only THESE tests fail — with a message
// naming the missing export — rather than the whole file erroring at load time.

type RefPrefixParse = { type: string; namePrefix: string } | null;
type ParseRefPrefixQueryFn = (query: string, knownTypes: readonly string[]) => RefPrefixParse;

function parseRefPrefixQuery(query: string, knownTypes: readonly string[]): RefPrefixParse {
  const fn = (ftsQueryModule as Record<string, unknown>).parseRefPrefixQuery;
  if (typeof fn !== "function") {
    throw new Error(
      "parseRefPrefixQuery is not exported from src/indexer/search/fts-query (SPEC-4 not implemented yet)",
    );
  }
  return (fn as ParseRefPrefixQueryFn)(query, knownTypes);
}

describe("parseRefPrefixQuery", () => {
  const KNOWN_TYPES: readonly string[] = ["memory", "knowledge", "wiki", "fact"];

  test("parses '<known-type>:<prefix>/' — trailing slash kept in namePrefix", () => {
    // The trailing slash MUST survive into namePrefix: the search branch feeds
    // it straight into `entry.name.startsWith(namePrefix)`, and "projecta/"
    // is what guarantees exact subtree semantics — a slashless "projecta"
    // would also match a sibling "projectalpha/..." subtree.
    expect(parseRefPrefixQuery("memory:projecta/", KNOWN_TYPES)).toEqual({
      type: "memory",
      namePrefix: "projecta/",
    });
  });

  test("parses nested directory prefixes", () => {
    expect(parseRefPrefixQuery("memory:projecta/nested/", KNOWN_TYPES)).toEqual({
      type: "memory",
      namePrefix: "projecta/nested/",
    });
  });

  test("bare '<known-type>:' enumerates the whole type (empty namePrefix)", () => {
    expect(parseRefPrefixQuery("wiki:", KNOWN_TYPES)).toEqual({ type: "wiki", namePrefix: "" });
    expect(parseRefPrefixQuery("memory:", KNOWN_TYPES)).toEqual({ type: "memory", namePrefix: "" });
  });

  test("a non-empty prefix REQUIRES the trailing slash", () => {
    expect(parseRefPrefixQuery("memory:projecta", KNOWN_TYPES)).toBeNull();
  });

  test("bare refs like memory:a/b stay ordinary searches (that's `akm show` territory)", () => {
    expect(parseRefPrefixQuery("memory:a/b", KNOWN_TYPES)).toBeNull();
    expect(parseRefPrefixQuery("knowledge:auth/oauth-refresh", KNOWN_TYPES)).toBeNull();
  });

  test("unknown types are not matched", () => {
    expect(parseRefPrefixQuery("bogus:stuff/", KNOWN_TYPES)).toBeNull();
    expect(parseRefPrefixQuery(":stuff/", KNOWN_TYPES)).toBeNull();
  });

  test("type validity comes from the caller-supplied list, not a baked-in set", () => {
    // Keeps fts-query dependency-free: the caller passes getAssetTypes().
    expect(parseRefPrefixQuery("memory:x/", ["knowledge"])).toBeNull();
    expect(parseRefPrefixQuery("customtype:x/", ["customtype"])).toEqual({
      type: "customtype",
      namePrefix: "x/",
    });
  });

  test("trims surrounding whitespace", () => {
    expect(parseRefPrefixQuery("  memory:projecta/  ", KNOWN_TYPES)).toEqual({
      type: "memory",
      namePrefix: "projecta/",
    });
    expect(parseRefPrefixQuery("\tknowledge:\n", KNOWN_TYPES)).toEqual({ type: "knowledge", namePrefix: "" });
  });

  test("interior whitespace disqualifies — prose mentioning a ref stays an ordinary search", () => {
    expect(parseRefPrefixQuery("memory:proj a/", KNOWN_TYPES)).toBeNull();
    expect(parseRefPrefixQuery("find memory:projecta/ now", KNOWN_TYPES)).toBeNull();
  });

  test("plain queries, empty strings, and lone colons are not matched", () => {
    expect(parseRefPrefixQuery("", KNOWN_TYPES)).toBeNull();
    expect(parseRefPrefixQuery("memory", KNOWN_TYPES)).toBeNull();
    expect(parseRefPrefixQuery("deploy prod", KNOWN_TYPES)).toBeNull();
    expect(parseRefPrefixQuery(":", KNOWN_TYPES)).toBeNull();
  });

  test("accepts the real asset-type registry as the known-type list", () => {
    expect(parseRefPrefixQuery("fact:conventions/", getAssetTypes())).toEqual({
      type: "fact",
      namePrefix: "conventions/",
    });
    expect(parseRefPrefixQuery("memory:projecta/", getAssetTypes())).toEqual({
      type: "memory",
      namePrefix: "projecta/",
    });
  });
});
