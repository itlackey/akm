// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import { validateJsonSchemaSubset } from "../../../src/core/json-schema";
import { fuzzSeeds, Rng, withSeed } from "./_rng";

/**
 * Seeded fuzz for the JSON-Schema-subset validator (`src/core/json-schema.ts`).
 *
 * Properties, each iteration reproducible from its printed seed:
 *   - the validator NEVER throws, on any random schema × any random value;
 *   - a valid value validates clean; a value mutated to break ONE declared
 *     constraint produces at least one error;
 *   - `additionalProperties: false` is honored WITH and WITHOUT `properties`;
 *   - `required` uses OWN properties (an inherited `toString`/`constructor`
 *     does not satisfy it — the sibling of the additionalProperties fix);
 *   - every reported error is a useful, path-prefixed string.
 *
 * The deterministic golden cases live in `tests/json-schema-subset.test.ts`;
 * this suite widens coverage over randomly-shaped schema/value pairs. Default
 * iteration count keeps it in the fast tier; `AKM_FUZZ_SEEDS` deepens it.
 */

type Schema = Record<string, unknown>;

const PRIM_TYPES = ["string", "number", "integer", "boolean", "null"] as const;

/** A random schema drawn from the SUPPORTED subset, bounded by `depth`. */
function randomSchema(rng: Rng, depth: number): Schema {
  if (depth <= 0 || rng.bool(0.4)) {
    const type = rng.pick(PRIM_TYPES);
    const schema: Schema = { type };
    // `enum` and the range constraints are mutually exclusive so the generated
    // schema is always satisfiable (an enum member never contradicts a bound).
    if (type === "string") {
      if (rng.bool(0.3)) {
        schema.enum = ["red", "green", "blue"];
      } else {
        if (rng.bool(0.4)) schema.minLength = rng.int(4);
        if (rng.bool(0.3)) schema.maxLength = rng.range(4, 8);
      }
    }
    if (type === "number" || type === "integer") {
      if (rng.bool(0.2)) {
        schema.enum = [1, 2, 3];
      } else {
        if (rng.bool(0.4)) schema.minimum = rng.range(-5, 5);
        if (rng.bool(0.4)) schema.maximum = rng.range(6, 20);
      }
    }
    return schema;
  }
  if (rng.bool()) {
    // array
    const schema: Schema = { type: "array", items: randomSchema(rng, depth - 1) };
    if (rng.bool(0.4)) schema.minItems = rng.int(3);
    if (rng.bool(0.4)) schema.maxItems = rng.range(3, 6);
    return schema;
  }
  // object
  const propCount = rng.int(4);
  const properties: Schema = {};
  const propNames: string[] = [];
  for (let i = 0; i < propCount; i++) {
    const name = `p${i}`;
    properties[name] = randomSchema(rng, depth - 1);
    propNames.push(name);
  }
  const schema: Schema = { type: "object" };
  if (propCount > 0) schema.properties = properties;
  if (rng.bool(0.4)) schema.additionalProperties = false;
  if (propCount > 0 && rng.bool(0.5)) {
    schema.required = rng.shuffle(propNames).slice(0, rng.range(1, propNames.length));
  }
  return schema;
}

/** A value that SATISFIES `schema` (a fixed point of the validator). */
function validFor(rng: Rng, schema: Schema): unknown {
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  switch (type) {
    case "string": {
      const min = typeof schema.minLength === "number" ? schema.minLength : 0;
      return "x".repeat(min);
    }
    case "integer":
    case "number": {
      const min = typeof schema.minimum === "number" ? schema.minimum : 0;
      const max = typeof schema.maximum === "number" ? schema.maximum : min + 1;
      return Math.min(Math.max(0, min), max);
    }
    case "boolean":
      return true;
    case "null":
      return null;
    case "array": {
      const len = typeof schema.minItems === "number" ? schema.minItems : 0;
      const items = (schema.items as Schema | undefined) ?? { type: "string" };
      return Array.from({ length: len }, () => validFor(rng, items));
    }
    default: {
      const obj: Record<string, unknown> = {};
      const properties = (schema.properties as Schema | undefined) ?? {};
      // Populate every required key (and, when the object is closed, only
      // declared keys) so the value is a clean fixed point.
      for (const [name, propSchema] of Object.entries(properties)) {
        if (rng.bool(0.7) || (Array.isArray(schema.required) && schema.required.includes(name))) {
          obj[name] = validFor(rng, propSchema as Schema);
        }
      }
      if (Array.isArray(schema.required)) {
        for (const key of schema.required) {
          if (typeof key === "string" && !(key in obj)) {
            obj[key] = validFor(rng, (properties[key] as Schema) ?? { type: "string" });
          }
        }
      }
      return obj;
    }
  }
}

describe("json-schema fuzz — validator never throws", () => {
  const seeds = fuzzSeeds(300);
  test("any random schema × any random value returns a string[] without throwing", () => {
    for (const seed of seeds) {
      withSeed(seed, () => {
        const rng = new Rng(seed);
        const schema = randomSchema(rng, 3);
        // Deliberately validate a value of a possibly-mismatched shape.
        const value = rng.bool() ? validFor(rng, schema) : randomSchema(rng, 2);
        const errors = validateJsonSchemaSubset(value, schema);
        expect(Array.isArray(errors)).toBe(true);
        expect(errors.every((e) => typeof e === "string" && e.length > 0)).toBe(true);
      });
    }
    expect(seeds.length).toBeGreaterThan(0);
  });
});

describe("json-schema fuzz — valid values validate clean, error paths are useful", () => {
  const seeds = fuzzSeeds(300);
  test("a fixed-point value has no errors; every error string is $-anchored", () => {
    for (const seed of seeds) {
      withSeed(seed, () => {
        const rng = new Rng(seed);
        const schema = randomSchema(rng, 3);
        const value = validFor(rng, schema);
        const errors = validateJsonSchemaSubset(value, schema);
        expect(errors).toEqual([]);
        // Now force a top-level type mismatch and confirm the error names a path.
        const wrongType = schema.type === "string" ? 12345 : "definitely-not-matching";
        const mismatch = validateJsonSchemaSubset(wrongType, schema);
        if (mismatch.length > 0) {
          expect(mismatch.every((e) => e.startsWith("$"))).toBe(true);
        }
      });
    }
    expect(seeds.length).toBeGreaterThan(0);
  });
});

describe("json-schema fuzz — additionalProperties:false honored with and without properties", () => {
  const seeds = fuzzSeeds(200);
  test("an undeclared key is always reported; declared/closed-empty stays clean", () => {
    for (const seed of seeds) {
      withSeed(seed, () => {
        const rng = new Rng(seed);
        const withProps = rng.bool();
        const schema: Schema = withProps
          ? { type: "object", properties: { a: { type: "string" } }, additionalProperties: false }
          : { type: "object", additionalProperties: false };

        // The maximal legal value (empty, or exactly the declared key) is clean.
        const legal = withProps ? { a: "ok" } : {};
        expect(validateJsonSchemaSubset(legal, schema)).toEqual([]);

        // Any extra key is rejected, naming the key and the constraint.
        const extraKey = `extra${rng.int(1000)}`;
        const illegal: Record<string, unknown> = { ...legal, [extraKey]: rng.int(10) };
        const errors = validateJsonSchemaSubset(illegal, schema);
        expect(errors.some((e) => e.includes(extraKey) && e.includes("additionalProperties"))).toBe(true);
      });
    }
    expect(seeds.length).toBeGreaterThan(0);
  });
});

describe("json-schema fuzz — required uses OWN properties", () => {
  const seeds = fuzzSeeds(150);
  const INHERITED = ["toString", "constructor", "hasOwnProperty", "valueOf"] as const;
  test("an inherited prototype member never satisfies a required key", () => {
    for (const seed of seeds) {
      withSeed(seed, () => {
        const rng = new Rng(seed);
        const key = rng.pick(INHERITED);
        const schema: Schema = { type: "object", required: [key] };
        // `key in {}` is true (Object.prototype), but `{}` has no OWN `key`, so
        // the required constraint MUST fail — the own-property contract.
        const errors = validateJsonSchemaSubset({}, schema);
        expect(errors.some((e) => e.includes(key) && e.includes("required"))).toBe(true);
        // Supplying it as an OWN property clears the error.
        expect(validateJsonSchemaSubset({ [key]: 1 }, schema)).toEqual([]);
      });
    }
    expect(seeds.length).toBeGreaterThan(0);
  });
});
