// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import { validateJsonSchemaSubset } from "../src/core/json-schema";

/**
 * Structural JSON-Schema-subset validator used by the workflow engine's
 * structured-output normalization (orchestration plan P1). Deliberately a
 * bounded subset — see the module doc for what is and is not supported.
 */

describe("validateJsonSchemaSubset", () => {
  test("accepts a matching object with required keys and nested types", () => {
    const schema = {
      type: "object",
      properties: {
        file: { type: "string" },
        line: { type: "integer" },
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["file", "line"],
    };
    expect(validateJsonSchemaSubset({ file: "a.ts", line: 3, tags: ["x"] }, schema)).toEqual([]);
  });

  test("reports missing required keys and wrong types with paths", () => {
    const schema = {
      type: "object",
      properties: { file: { type: "string" }, line: { type: "integer" } },
      required: ["file", "line"],
    };
    const errors = validateJsonSchemaSubset({ line: "three" }, schema);
    expect(errors.some((e) => e.includes("file") && e.includes("required"))).toBe(true);
    expect(errors.some((e) => e.includes("line"))).toBe(true);
  });

  test("integer rejects floats; number accepts them", () => {
    expect(validateJsonSchemaSubset(1.5, { type: "integer" })).not.toEqual([]);
    expect(validateJsonSchemaSubset(1.5, { type: "number" })).toEqual([]);
  });

  test("enum constrains primitive values", () => {
    const schema = { type: "string", enum: ["low", "high"] };
    expect(validateJsonSchemaSubset("low", schema)).toEqual([]);
    expect(validateJsonSchemaSubset("mid", schema)).not.toEqual([]);
  });

  test("array items and minItems/maxItems", () => {
    const schema = { type: "array", items: { type: "integer" }, minItems: 1, maxItems: 2 };
    expect(validateJsonSchemaSubset([1], schema)).toEqual([]);
    expect(validateJsonSchemaSubset([], schema)).not.toEqual([]);
    expect(validateJsonSchemaSubset([1, 2, 3], schema)).not.toEqual([]);
    expect(validateJsonSchemaSubset([1, "x"], schema)).not.toEqual([]);
  });

  test("additionalProperties: false rejects unknown keys", () => {
    const schema = { type: "object", properties: { a: { type: "string" } }, additionalProperties: false };
    expect(validateJsonSchemaSubset({ a: "x" }, schema)).toEqual([]);
    expect(validateJsonSchemaSubset({ a: "x", b: 1 }, schema)).not.toEqual([]);
  });

  test("union type arrays are supported", () => {
    const schema = { type: ["string", "null"] };
    expect(validateJsonSchemaSubset(null, schema)).toEqual([]);
    expect(validateJsonSchemaSubset("x", schema)).toEqual([]);
    expect(validateJsonSchemaSubset(3, schema)).not.toEqual([]);
  });

  test("schemas with no recognized constraints accept anything (permissive)", () => {
    expect(validateJsonSchemaSubset({ anything: true }, {})).toEqual([]);
  });

  test("unsupported keywords are ignored rather than throwing", () => {
    const schema = { type: "object", allOf: [{ type: "object" }], $ref: "#/x" };
    expect(validateJsonSchemaSubset({}, schema)).toEqual([]);
  });
});
