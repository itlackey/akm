// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Bug 10 regression — `output:` and `params` schemas are now validated AS
 * schema definitions (`core/json-schema.ts#checkJsonSchemaDefinition`): a
 * typo'd `type` or a keyword the runtime subset validator ignores used to
 * silently constrain nothing at run time; both are now loud, line-anchored
 * parser errors.
 */

import { describe, expect, test } from "bun:test";
import { checkJsonSchemaDefinition } from "../../src/core/json-schema";
import { parseWorkflow } from "../../src/workflows/parser";

function parseErrors(markdown: string): Array<{ line: number; message: string }> {
  const result = parseWorkflow(markdown, { path: "workflows/schemas.md" });
  if (result.ok) return [];
  return result.errors;
}

describe("checkJsonSchemaDefinition (core/json-schema.ts)", () => {
  test("a valid subset schema produces no issues", () => {
    expect(
      checkJsonSchemaDefinition({
        type: "object",
        description: "annotations are fine",
        required: ["files"],
        additionalProperties: false,
        properties: {
          files: { type: "array", minItems: 1, items: { type: "string", maxLength: 200 } },
          mode: { type: ["string", "null"], enum: ["fast", "slow", null] },
          count: { type: "integer", minimum: 0, maximum: 10 },
        },
      }),
    ).toEqual([]);
  });

  test("an unknown type name is a malformed issue with a pointer to the keyword", () => {
    const issues = checkJsonSchemaDefinition({ type: "strig" });
    expect(issues).toHaveLength(1);
    expect(issues[0]!.kind).toBe("malformed");
    expect(issues[0]!.keyword).toBe("type");
    expect(issues[0]!.pointer).toBe("$.type");
    expect(issues[0]!.message).toContain('unknown type "strig"');
    expect(issues[0]!.message).toContain("valid types");
  });

  test("nested malformed keywords are located precisely", () => {
    const issues = checkJsonSchemaDefinition({
      type: "object",
      properties: { name: { type: "str" }, size: { minimum: "big" } },
    });
    expect(issues.map((issue) => issue.pointer).sort()).toEqual([
      "$.properties.name.type",
      "$.properties.size.minimum",
    ]);
    expect(issues.every((issue) => issue.kind === "malformed")).toBe(true);
  });

  test("subset-ignored keywords are reported as unsupported, one per keyword", () => {
    const issues = checkJsonSchemaDefinition({
      type: "string",
      pattern: "^x-",
      format: "email",
    });
    expect(issues.map((issue) => [issue.kind, issue.keyword]).sort()).toEqual([
      ["unsupported", "format"],
      ["unsupported", "pattern"],
    ]);
  });

  test("$ref / combinators / schema-form additionalProperties are unsupported", () => {
    const refIssues = checkJsonSchemaDefinition({ $ref: "#/defs/x" });
    expect(refIssues.map((issue) => issue.keyword)).toEqual(["$ref"]);
    const combinator = checkJsonSchemaDefinition({ oneOf: [{ type: "string" }] });
    expect(combinator.map((issue) => issue.keyword)).toEqual(["oneOf"]);
    const additional = checkJsonSchemaDefinition({ type: "object", additionalProperties: { type: "string" } });
    expect(additional.map((issue) => issue.keyword)).toEqual(["additionalProperties"]);
    expect(additional[0]!.kind).toBe("unsupported");
  });

  test("malformed structural keywords are errors (required / properties / enum / items)", () => {
    expect(checkJsonSchemaDefinition({ required: "files" })[0]!.kind).toBe("malformed");
    expect(checkJsonSchemaDefinition({ properties: ["files"] })[0]!.kind).toBe("malformed");
    expect(checkJsonSchemaDefinition({ enum: [] })[0]!.kind).toBe("malformed");
    expect(checkJsonSchemaDefinition({ items: "string" })[0]!.kind).toBe("malformed");
  });

  test("unknown non-JSON-Schema keywords are ignored (open-keyword behavior, e.g. x- extensions)", () => {
    expect(checkJsonSchemaDefinition({ type: "object", "x-custom": true, notAKeyword: 1 })).toEqual([]);
  });
});

describe("bug 10 — workflow parser rejects malformed / unsupported schemas", () => {
  test('`type: "strig"` in a step output schema is a line-anchored parser error', () => {
    const markdown = [
      "---",
      "type: workflow",
      "steps:",
      "  - id: work",
      "    output:",
      "      type: strig",
      "---",
      "",
      "## work",
      "",
      "Do it.",
      "",
    ].join("\n");
    const errors = parseErrors(markdown);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.line).toBe(6); // the `type: strig` line
    expect(errors[0]!.message).toContain('Step "work" "output" is not a valid JSON Schema');
    expect(errors[0]!.message).toContain('unknown type "strig"');
  });

  test("`pattern:` in an output schema is a parser error naming the unsupported keyword and the supported subset", () => {
    const markdown = [
      "---",
      "type: workflow",
      "steps:",
      "  - id: work",
      "    output:",
      "      type: string",
      "      pattern: '^ok$'",
      "---",
      "",
      "## work",
      "",
      "Do it.",
      "",
    ].join("\n");
    const errors = parseErrors(markdown);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.line).toBe(7); // the `pattern:` line
    expect(errors[0]!.message).toContain('keyword "pattern" is not enforced');
    expect(errors[0]!.message).toContain("Supported JSON Schema keywords:");
  });

  test("a params schema gets the same definition checking", () => {
    const markdown = [
      "---",
      "type: workflow",
      "params:",
      "  files: { type: aray }",
      "steps:",
      "  - id: work",
      "---",
      "",
      "## work",
      "",
      "Do it.",
      "",
    ].join("\n");
    const errors = parseErrors(markdown);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.line).toBe(4);
    expect(errors[0]!.message).toContain('Param "files" schema is not a valid JSON Schema');
    expect(errors[0]!.message).toContain('unknown type "aray"');
  });

  test("a valid subset schema (with annotations) still parses cleanly", () => {
    const markdown = [
      "---",
      "type: workflow",
      "params:",
      "  files: { type: array, description: The files to review, items: { type: string } }",
      "steps:",
      "  - id: work",
      "    output:",
      "      type: object",
      "      required: [verdict]",
      "      properties:",
      "        verdict: { type: string, enum: [pass, fail] }",
      "---",
      "",
      "## work",
      "",
      "Do it.",
      "",
    ].join("\n");
    expect(parseErrors(markdown)).toHaveLength(0);
  });

  test("a unit-level output schema is checked too", () => {
    const markdown = [
      "---",
      "type: workflow",
      "steps:",
      "  - id: work",
      "    unit:",
      "      output: { type: object, patternProperties: { '^x': { type: string } } }",
      "---",
      "",
      "## work",
      "",
      "Do it.",
      "",
    ].join("\n");
    const errors = parseErrors(markdown);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain('keyword "patternProperties" is not enforced');
  });
});
