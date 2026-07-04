// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//
// Coverage-hardening: parseAssetRef special-cased branches.
//
// The existing tests/asset-ref.test.ts exercises the happy path plus the
// generic invalid-type path (widget:/tool:). But two SPECIAL branches in
// parseAssetRef — the `environment:` → `env` alias (TYPE_ALIASES) and the
// `vault:` removed-type migration error — are never exercised. A regression
// that deleted the alias or changed the migration message would keep every
// committed test green. These tests lock in the exact behaviour of those
// branches plus a cluster of name-normalization shapes that the happy-path
// tests skip (the relink-class "only the easy input is tested" gap).
//

import { describe, expect, test } from "bun:test";
import { makeAssetRef, parseAssetRef, refToString } from "../../src/core/asset/asset-ref";

describe("parseAssetRef — environment→env alias (TYPE_ALIASES)", () => {
  test("bare `environment:` resolves to the canonical `env` type", () => {
    const ref = parseAssetRef("environment:prod");
    expect(ref.type).toBe("env");
    expect(ref.name).toBe("prod");
    expect(ref.origin).toBeUndefined();
  });

  test("origin-qualified `environment:` also aliases to `env`", () => {
    const ref = parseAssetRef("local//environment:prod");
    expect(ref.type).toBe("env");
    expect(ref.origin).toBe("local");
    expect(ref.name).toBe("prod");
  });

  test("the alias canonicalizes — it does NOT round-trip to `environment:`", () => {
    // refToString on an aliased parse must emit the canonical `env:` form, not
    // the spelling the caller typed. This is the observable contract of an
    // alias vs a distinct type.
    expect(refToString(parseAssetRef("environment:prod"))).toBe("env:prod");
  });
});

describe("parseAssetRef — removed `vault` type migration branch", () => {
  test("`vault:` throws the 0.9.0 migration message (not the generic invalid-type error)", () => {
    // Must point the caller at env:/secret:, and must NOT be the generic
    // "Invalid asset type" message the widget:/tool: cases produce.
    expect(() => parseAssetRef("vault:secret")).toThrow(/vault. asset type was removed in 0.9.0/);
    expect(() => parseAssetRef("vault:secret")).toThrow(/env:/);
    expect(() => parseAssetRef("vault:secret")).not.toThrow(/Invalid asset type/);
  });

  test("origin-qualified `vault` ref still hits the migration branch", () => {
    expect(() => parseAssetRef("local//vault:secret")).toThrow(/removed in 0.9.0/);
  });
});

describe("parseAssetRef — name normalization shapes (beyond the tested `../`)", () => {
  test("a name that normalizes to a bare `.` is rejected as a relative segment", () => {
    expect(() => parseAssetRef("script:.")).toThrow(/relative path segments|Path traversal/);
  });

  test("leading `./` is stripped by normalization", () => {
    expect(parseAssetRef("script:./deploy.sh").name).toBe("deploy.sh");
  });

  test("an interior `.` segment collapses (`a/./b` → `a/b`)", () => {
    expect(parseAssetRef("script:a/./b").name).toBe("a/b");
  });

  test("an interior `..` that stays within bounds collapses (`a/../b` → `b`)", () => {
    // This is allowed because after normalization it does not escape the root
    // and contains no leading `..` segment — a subtle branch the happy-path
    // tests never cover.
    expect(parseAssetRef("script:a/../b").name).toBe("b");
  });

  test("a leading colon (empty type) is an invalid ref", () => {
    expect(() => parseAssetRef(":name")).toThrow(/Invalid ref/);
  });
});

describe("parseAssetRef — `//` boundary is greedy to the first occurrence", () => {
  test("a name containing `//` is misparsed as an origin boundary and rejected", () => {
    // `//` ALWAYS delimits origin from body (indexOf, first occurrence). So a
    // name that itself contains `//` splits into origin=`script:a`, body=`b`,
    // and `b` has no colon → invalid ref. This documents why names must never
    // embed `//` (the same origin-vs-body ambiguity that hid the relink bug).
    expect(() => parseAssetRef("script:a//b")).toThrow(/Invalid ref/);
  });

  test("a scoped-npm origin keeps its own single-colon intact after the boundary", () => {
    // The first `//` is the scope/pkg boundary; the type colon lives in the
    // body. Confirms the boundary split does not swallow the type's colon.
    const ref = parseAssetRef("npm:@scope/pkg//env:prod");
    expect(ref.origin).toBe("npm:@scope/pkg");
    expect(ref.type).toBe("env");
    expect(ref.name).toBe("prod");
  });
});

describe("makeAssetRef — origin is not re-validated but name always is", () => {
  test("makeAssetRef does not apply the environment→env alias (aliases are parse-only)", () => {
    // makeAssetRef takes an already-canonical AkmAssetType, so it emits exactly
    // what it is given. Feeding it "env" yields "env:x"; there is no reverse
    // alias. This pins the asymmetry between construction and parsing.
    expect(makeAssetRef("env", "x")).toBe("env:x");
  });
});
