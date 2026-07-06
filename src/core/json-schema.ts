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
 */

export function validateJsonSchemaSubset(value: unknown, schema: Record<string, unknown>): string[] {
  const errors: string[] = [];
  validateNode(value, schema, "$", errors);
  return errors;
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
        if (typeof key === "string" && !(key in record)) {
          errors.push(`${path}: missing required property "${key}"`);
        }
      }
    }

    if (properties) {
      for (const [key, propSchema] of Object.entries(properties)) {
        if (!(key in record)) continue;
        if (propSchema && typeof propSchema === "object" && !Array.isArray(propSchema)) {
          validateNode(record[key], propSchema as Record<string, unknown>, `${path}.${key}`, errors);
        }
      }
    }

    if (schema.additionalProperties === false && properties) {
      for (const key of Object.keys(record)) {
        if (!(key in properties)) {
          errors.push(`${path}: unexpected property "${key}" (additionalProperties: false)`);
        }
      }
    }
  }
}
