// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The JSON-Schema subset's NEWLY ENFORCED keywords — the combinators
 * `allOf`/`anyOf`/`oneOf`/`not` (`src/core/json-schema.ts`).
 *
 * Each was previously a loud author-time error precisely because the runtime
 * ignored it, so the load-bearing assertion in every case below is the
 * NEGATIVE one: an invalid value must be REJECTED. A test that only checks
 * that a valid value passes would pass just as happily against the old
 * ignore-the-keyword behavior.
 *
 * `pattern` is deliberately NOT in that set: it stays a recognized-but-
 * unsupported keyword, reported loudly at authoring time
 * (see `tests/workflows/schema-definition.test.ts`) and ignored at evaluation.
 *
 * Also pins the evaluation bounds documented in that module's header —
 * exhausting the depth or node budget is an ERROR, not a silent acceptance:
 * the subset never fails open.
 */

import { describe, expect, test } from "bun:test";
import { JSON_SCHEMA_SUBSET_SUPPORTED_KEYWORDS, validateJsonSchemaSubset } from "../../src/core/json-schema";

describe("validateJsonSchemaSubset — pattern is NOT evaluated", () => {
  test("a string is not matched against `pattern` — the keyword constrains nothing at run time", () => {
    // `pattern` is a recognized-but-unsupported keyword: authors are told so
    // loudly at parse time, so evaluation can ignore it without surprising
    // anyone. Evaluating it would need a regex safety analysis whose only
    // effect on real workflows was rejecting patterns authors legitimately
    // wrote.
    const semver = { type: "string", pattern: "^\\d+\\.\\d+\\.\\d+$" };
    expect(validateJsonSchemaSubset("1.2.3", semver)).toEqual([]);
    expect(validateJsonSchemaSubset("v1.2", semver)).toEqual([]);
    // …including the shapes the removed screen used to reject outright.
    expect(validateJsonSchemaSubset("aaaaaaaaaaaaaaaaaaaa!", { type: "string", pattern: "^(a+)+$" })).toEqual([]);
    expect(validateJsonSchemaSubset("x".repeat(100_000), { type: "string", pattern: "^x+$" })).toEqual([]);
  });

  test("the keywords the subset DOES enforce still apply alongside an ignored `pattern`", () => {
    const schema = { type: "string", pattern: "^ok$", minLength: 4 };
    expect(validateJsonSchemaSubset("okay", schema)).toEqual([]);
    const errors = validateJsonSchemaSubset("ok", schema);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("minLength");
  });
});

describe("validateJsonSchemaSubset — combinators", () => {
  test("oneOf accepts exactly one match and REJECTS zero or several", () => {
    const schema = { oneOf: [{ type: "string" }, { type: "integer" }] };
    expect(validateJsonSchemaSubset("x", schema)).toEqual([]);
    expect(validateJsonSchemaSubset(7, schema)).toEqual([]);

    const none = validateJsonSchemaSubset(true, schema);
    expect(none).toHaveLength(1);
    expect(none[0]).toContain('matches none of the 2 "oneOf" schemas');

    // `integer` also satisfies `number`, so 7 matches BOTH branches here.
    const several = validateJsonSchemaSubset(7, { oneOf: [{ type: "integer" }, { type: "number" }] });
    expect(several).toHaveLength(1);
    expect(several[0]).toContain("exactly one must match");
  });

  test("anyOf accepts any matching branch and REJECTS a value matching none", () => {
    const schema = {
      anyOf: [
        { type: "string", minLength: 3 },
        { type: "integer", minimum: 10 },
      ],
    };
    expect(validateJsonSchemaSubset("abc", schema)).toEqual([]);
    expect(validateJsonSchemaSubset(11, schema)).toEqual([]);

    const errors = validateJsonSchemaSubset("ab", schema);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('matches none of the 2 "anyOf" schemas');
    // The summary names why each branch failed, so it is actionable.
    expect(errors[0]).toContain("minLength");
  });

  test("allOf requires every branch and surfaces each failure verbatim", () => {
    const schema = {
      allOf: [
        { type: "object", required: ["a"] },
        { type: "object", required: ["b"] },
      ],
    };
    expect(validateJsonSchemaSubset({ a: 1, b: 2 }, schema)).toEqual([]);
    const errors = validateJsonSchemaSubset({ a: 1 }, schema);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(`missing required property "b"`);
  });

  test("not inverts its subschema", () => {
    expect(validateJsonSchemaSubset("x", { not: { type: "number" } })).toEqual([]);
    const errors = validateJsonSchemaSubset(3, { not: { type: "number" } });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(`must not match the "not" schema`);
  });

  test("combinators nest inside properties/items and keep the value path", () => {
    const schema = {
      type: "object",
      properties: {
        results: {
          type: "array",
          items: { anyOf: [{ type: "string", enum: ["ok"] }, { type: "null" }] },
        },
      },
    };
    expect(validateJsonSchemaSubset({ results: ["ok", null] }, schema)).toEqual([]);
    const errors = validateJsonSchemaSubset({ results: ["ok", "nope"] }, schema);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("$.results[1]");
  });

  test("combinators and the type/enum keywords coexist on one schema", () => {
    const schema = { type: "string", enum: ["pass", "fail"], allOf: [{ minLength: 4 }] };
    expect(validateJsonSchemaSubset("pass", schema)).toEqual([]);
    expect(validateJsonSchemaSubset("skip", schema)).not.toEqual([]);
    expect(validateJsonSchemaSubset(7, schema)).not.toEqual([]);
  });
});

describe("validateJsonSchemaSubset — totality", () => {
  test("a deeply nested combinator chain terminates and reports the depth limit", () => {
    let schema: Record<string, unknown> = { type: "string" };
    for (let i = 0; i < 200; i++) schema = { allOf: [schema] };
    const errors = validateJsonSchemaSubset("x", schema);
    expect(errors.some((e) => e.includes("depth limit"))).toBe(true);
  });

  test("a large array against a combinator schema stays bounded and fails closed", () => {
    const schema = {
      type: "array",
      items: { anyOf: [{ type: "string" }, { type: "integer" }, { type: "null" }] },
    };
    const value = Array.from({ length: 200_000 }, (_, i) => i);
    const errors = validateJsonSchemaSubset(value, schema);
    // The evaluation is stopped by the node budget rather than running forever,
    // and says so instead of returning a clean (i.e. "valid") result.
    expect(errors.some((e) => e.includes("exceeded the limit"))).toBe(true);
  });

  test("the advertised supported-keyword list names the enforced keywords and omits `pattern`", () => {
    for (const keyword of ["allOf", "anyOf", "oneOf", "not"]) {
      expect(JSON_SCHEMA_SUBSET_SUPPORTED_KEYWORDS).toContain(keyword);
    }
    expect(JSON_SCHEMA_SUBSET_SUPPORTED_KEYWORDS).not.toContain("pattern");
  });
});
