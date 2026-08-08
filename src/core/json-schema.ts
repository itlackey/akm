// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Structural JSON-Schema-subset validator (orchestration plan P1).
 *
 * The workflow engine's structured-output normalization needs to validate
 * unit results against the author-declared unit `output` schema on any harness —
 * including ones with no native schema support. Pulling in a full
 * draft-2020-12 validator is deliberately avoided (dependency surface); this
 * module implements the bounded subset that covers the schemas workflow
 * authors actually write:
 *
 *   Supported: `type` (string | string[] — string, number, integer, boolean,
 *   object, array, null), `properties`, `required`, `items`,
 *   `additionalProperties: false`, `enum` (primitives), `minItems`,
 *   `maxItems`, `minLength`, `maxLength`, `minimum`, `maximum`.
 *
 *   Ignored (permissive): `$ref`, `allOf`/`anyOf`/`oneOf`/`not`, `pattern`,
 *   `format`, and every other keyword. Unknown keywords never throw — a
 *   schema using them simply constrains less. Callers needing full JSON
 *   Schema semantics should validate downstream.
 *
 * Returns a flat list of human-readable error strings (empty = valid), each
 * prefixed with a JSON-pointer-ish path — the shape `runStructured`'s
 * corrective-feedback builder wants.
 *
 * {@link checkJsonSchemaDefinition} is the companion DEFINITION checker: it
 * walks an author-declared schema OBJECT (not a value) and reports typo'd
 * `type` names / structurally malformed keywords as `"malformed"` issues, and
 * recognized JSON Schema keywords this subset silently ignores as
 * `"unsupported"` issues — so a schema that would constrain nothing at
 * runtime can be rejected loudly at authoring time (the workflow parser does
 * exactly that for `output:` and `params` schemas). It deliberately does NOT
 * change {@link validateJsonSchemaSubset}'s permissive evaluation semantics.
 */

export function validateJsonSchemaSubset(value: unknown, schema: Record<string, unknown>): string[] {
  const errors: string[] = [];
  validateNode(value, schema, "$", errors);
  return errors;
}

// ── Schema-definition checking ───────────────────────────────────────────────

export interface SchemaDefinitionIssue {
  /** Key path of the offending keyword within the schema object (empty = root). */
  path: Array<string | number>;
  /** Dotted display form of `path`, rooted at `$` (e.g. `$.properties.name.type`). */
  pointer: string;
  /** The keyword the issue is about. */
  keyword: string;
  /**
   * `"malformed"`: the keyword's value is structurally invalid (typo'd `type`
   * name, non-array `required`, …). `"unsupported"`: a recognized JSON Schema
   * keyword the subset validator silently ignores — the schema would constrain
   * nothing at runtime where the author expects it to.
   */
  kind: "malformed" | "unsupported";
  message: string;
}

/** Human-readable list of the keywords {@link validateJsonSchemaSubset} enforces (for error messages). */
export const JSON_SCHEMA_SUBSET_SUPPORTED_KEYWORDS =
  "type, enum, properties, required, items, additionalProperties: false, minItems, maxItems, minLength, maxLength, minimum, maximum";

const KNOWN_TYPE_NAMES = new Set(["string", "number", "integer", "boolean", "object", "array", "null"]);

// Annotation keywords (`title`, `description`, `default`, `examples`,
// `$schema`, `$id`, `$comment`, `deprecated`, `readOnly`, `writeOnly`) are
// deliberately NOT in the unsupported set below: they constrain nothing in
// full JSON Schema either, so the subset ignoring them loses no semantics.
// Like any other unrecognized keyword (e.g. `x-…` extensions), they fall
// through the checker unreported — JSON Schema's own open-keyword behavior.

/**
 * Recognized JSON Schema keywords {@link validateJsonSchemaSubset} silently
 * ignores — a schema relying on one of these constrains LESS at runtime than
 * its author intended, so definition checking reports each as `"unsupported"`.
 */
const UNSUPPORTED_KEYWORDS = new Set([
  "$ref",
  "$defs",
  "definitions",
  "$anchor",
  "$dynamicRef",
  "$dynamicAnchor",
  "allOf",
  "anyOf",
  "oneOf",
  "not",
  "if",
  "then",
  "else",
  "const",
  "pattern",
  "format",
  "patternProperties",
  "propertyNames",
  "additionalItems",
  "prefixItems",
  "contains",
  "minContains",
  "maxContains",
  "uniqueItems",
  "multipleOf",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "minProperties",
  "maxProperties",
  "dependencies",
  "dependentRequired",
  "dependentSchemas",
  "unevaluatedItems",
  "unevaluatedProperties",
  "contentEncoding",
  "contentMediaType",
  "contentSchema",
]);

const MAX_DEFINITION_DEPTH = 64;

/**
 * Check a JSON Schema DEFINITION (the schema object itself, not a value)
 * against the subset {@link validateJsonSchemaSubset} enforces. Returns
 * accumulated issues (empty = the schema is a well-formed subset schema).
 * Keywords that are neither subset-enforced, unsupported-but-recognized, nor
 * annotations are ignored, matching JSON Schema's own open-keyword behavior.
 */
export function checkJsonSchemaDefinition(schema: Record<string, unknown>): SchemaDefinitionIssue[] {
  const issues: SchemaDefinitionIssue[] = [];
  checkDefinitionNode(schema, [], issues, 0);
  return issues;
}

function pointerFor(path: ReadonlyArray<string | number>): string {
  return path.length === 0 ? "$" : `$.${path.map(String).join(".")}`;
}

function pushIssue(
  issues: SchemaDefinitionIssue[],
  path: ReadonlyArray<string | number>,
  keyword: string,
  kind: SchemaDefinitionIssue["kind"],
  message: string,
): void {
  issues.push({ path: [...path], pointer: pointerFor(path), keyword, kind, message });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkDefinitionNode(
  schema: Record<string, unknown>,
  path: Array<string | number>,
  issues: SchemaDefinitionIssue[],
  depth: number,
): void {
  if (depth > MAX_DEFINITION_DEPTH) {
    pushIssue(
      issues,
      path,
      "(depth)",
      "malformed",
      `schema nesting exceeds the depth limit of ${MAX_DEFINITION_DEPTH}`,
    );
    return;
  }

  for (const keyword of Object.keys(schema)) {
    if (UNSUPPORTED_KEYWORDS.has(keyword)) {
      pushIssue(
        issues,
        [...path, keyword],
        keyword,
        "unsupported",
        `keyword "${keyword}" is not enforced by the workflow schema subset — the schema would silently not constrain what it looks like it constrains`,
      );
    }
  }

  const declared = schema.type;
  if (declared !== undefined) {
    const names = Array.isArray(declared) ? declared : [declared];
    if (names.length === 0) {
      pushIssue(issues, [...path, "type"], "type", "malformed", `"type" must name at least one type`);
    }
    for (const [index, name] of names.entries()) {
      const namePath = Array.isArray(declared) ? [...path, "type", index] : [...path, "type"];
      if (typeof name !== "string") {
        pushIssue(issues, namePath, "type", "malformed", `"type" must be a string or an array of strings`);
      } else if (!KNOWN_TYPE_NAMES.has(name)) {
        pushIssue(
          issues,
          namePath,
          "type",
          "malformed",
          `unknown type ${JSON.stringify(name)} (valid types: ${[...KNOWN_TYPE_NAMES].join(", ")})`,
        );
      }
    }
  }

  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || schema.enum.length === 0)) {
    pushIssue(issues, [...path, "enum"], "enum", "malformed", `"enum" must be a non-empty array of allowed values`);
  }

  if (schema.required !== undefined) {
    if (!Array.isArray(schema.required) || !schema.required.every((key) => typeof key === "string")) {
      pushIssue(
        issues,
        [...path, "required"],
        "required",
        "malformed",
        `"required" must be an array of property-name strings`,
      );
    }
  }

  if (schema.properties !== undefined) {
    if (!isPlainObject(schema.properties)) {
      pushIssue(
        issues,
        [...path, "properties"],
        "properties",
        "malformed",
        `"properties" must be an object mapping property names to schemas`,
      );
    } else {
      for (const [key, propSchema] of Object.entries(schema.properties)) {
        if (isPlainObject(propSchema)) {
          checkDefinitionNode(propSchema, [...path, "properties", key], issues, depth + 1);
        } else {
          pushIssue(
            issues,
            [...path, "properties", key],
            "properties",
            "malformed",
            `property ${JSON.stringify(key)} must be a schema object`,
          );
        }
      }
    }
  }

  if (schema.items !== undefined) {
    if (isPlainObject(schema.items)) {
      checkDefinitionNode(schema.items, [...path, "items"], issues, depth + 1);
    } else if (Array.isArray(schema.items)) {
      pushIssue(
        issues,
        [...path, "items"],
        "items",
        "unsupported",
        `tuple-form "items" (an array of schemas) is not enforced by the workflow schema subset — use a single schema object`,
      );
    } else {
      pushIssue(issues, [...path, "items"], "items", "malformed", `"items" must be a schema object`);
    }
  }

  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== "boolean") {
    if (isPlainObject(schema.additionalProperties)) {
      pushIssue(
        issues,
        [...path, "additionalProperties"],
        "additionalProperties",
        "unsupported",
        `schema-form "additionalProperties" is not enforced by the workflow schema subset — only "additionalProperties: false" is`,
      );
    } else {
      pushIssue(
        issues,
        [...path, "additionalProperties"],
        "additionalProperties",
        "malformed",
        `"additionalProperties" must be a boolean (only "false" is enforced)`,
      );
    }
  }

  for (const keyword of ["minItems", "maxItems", "minLength", "maxLength"] as const) {
    const value = schema[keyword];
    if (value !== undefined && (typeof value !== "number" || !Number.isInteger(value) || value < 0)) {
      pushIssue(issues, [...path, keyword], keyword, "malformed", `"${keyword}" must be a non-negative integer`);
    }
  }
  for (const keyword of ["minimum", "maximum"] as const) {
    const value = schema[keyword];
    if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value))) {
      pushIssue(issues, [...path, keyword], keyword, "malformed", `"${keyword}" must be a finite number`);
    }
  }
}

type JsonTypeName = "string" | "number" | "integer" | "boolean" | "object" | "array" | "null";

function typeOf(value: unknown): JsonTypeName {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  switch (typeof value) {
    case "string":
      return "string";
    case "boolean":
      return "boolean";
    case "number":
      return Number.isInteger(value) ? "integer" : "number";
    default:
      return "object";
  }
}

function matchesType(actual: JsonTypeName, expected: string): boolean {
  if (expected === actual) return true;
  // JSON Schema: every integer is also a number.
  return expected === "number" && actual === "integer";
}

function validateNode(value: unknown, schema: Record<string, unknown>, path: string, errors: string[]): void {
  const actual = typeOf(value);

  const declared = schema.type;
  if (typeof declared === "string" || Array.isArray(declared)) {
    const expected = (Array.isArray(declared) ? declared : [declared]).filter(
      (t): t is string => typeof t === "string",
    );
    if (expected.length > 0 && !expected.some((t) => matchesType(actual, t))) {
      errors.push(`${path}: expected type ${expected.join(" | ")}, got ${actual}`);
      return; // type mismatch makes the remaining constraints meaningless
    }
  }

  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    const allowed = schema.enum;
    if (!allowed.some((candidate) => candidate === value)) {
      errors.push(`${path}: value ${JSON.stringify(value)} is not one of ${JSON.stringify(allowed)}`);
      return;
    }
  }

  if (actual === "string" && typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) {
      errors.push(`${path}: string shorter than minLength ${schema.minLength}`);
    }
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
      errors.push(`${path}: string longer than maxLength ${schema.maxLength}`);
    }
    return;
  }

  if ((actual === "number" || actual === "integer") && typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      errors.push(`${path}: ${value} is below minimum ${schema.minimum}`);
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      errors.push(`${path}: ${value} is above maximum ${schema.maximum}`);
    }
    return;
  }

  if (actual === "array" && Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      errors.push(`${path}: array has fewer than minItems ${schema.minItems}`);
    }
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
      errors.push(`${path}: array has more than maxItems ${schema.maxItems}`);
    }
    const items = schema.items;
    if (items && typeof items === "object" && !Array.isArray(items)) {
      value.forEach((element, index) => {
        validateNode(element, items as Record<string, unknown>, `${path}[${index}]`, errors);
      });
    }
    return;
  }

  if (actual === "object" && typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const properties =
      schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)
        ? (schema.properties as Record<string, unknown>)
        : undefined;

    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        // `Object.hasOwn`, not `key in record`: a required key satisfied only by
        // an inherited prototype member (e.g. "toString", "constructor") is NOT
        // present on the value itself, so `{}` must fail `required: ["toString"]`.
        if (typeof key === "string" && !Object.hasOwn(record, key)) {
          errors.push(`${path}: missing required property "${key}"`);
        }
      }
    }

    if (properties) {
      for (const [key, propSchema] of Object.entries(properties)) {
        if (!Object.hasOwn(record, key)) continue;
        if (propSchema && typeof propSchema === "object" && !Array.isArray(propSchema)) {
          validateNode(record[key], propSchema as Record<string, unknown>, `${path}.${key}`, errors);
        }
      }
    }

    // `additionalProperties: false` closes the object to exactly its declared
    // `properties`. This MUST run even when no `properties` object is present:
    // `{ type: "object", additionalProperties: false }` admits only `{}`. Use
    // `Object.hasOwn` so an inherited key name (e.g. "toString") on the empty
    // property set is not mistaken for a declared property.
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(record)) {
        if (!properties || !Object.hasOwn(properties, key)) {
          errors.push(`${path}: unexpected property "${key}" (additionalProperties: false)`);
        }
      }
    }
  }
}
