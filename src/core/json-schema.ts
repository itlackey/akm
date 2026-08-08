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
 *   `maxItems`, `minLength`, `maxLength`, `minimum`, `maximum`, and the
 *   combinators `allOf`, `anyOf`, `oneOf`, `not`.
 *
 *   Ignored (permissive): `$ref`, `pattern`, `format`, `patternProperties`,
 *   tuple-form `items`, schema-form `additionalProperties`, and every other
 *   keyword. Unknown keywords never throw — a schema using them simply
 *   constrains less. Callers needing full JSON Schema semantics should
 *   validate downstream.
 *
 *   `pattern` is deliberately NOT evaluated. Matching an author-supplied regex
 *   with the platform `RegExp` inside a synchronous gate decision would need a
 *   static safety analysis to stay bounded, and any such analysis rejects
 *   legitimate patterns — machinery that makes authoring fail for no benefit
 *   the workflows here ask for. `pattern` is a recognized-but-unsupported
 *   keyword instead: {@link checkJsonSchemaDefinition} reports it loudly at
 *   authoring time, so nobody writes one believing it is enforced.
 *
 * ## Totality and bounds
 *
 * Evaluation is TOTAL and BOUNDED. Recursion is capped at
 * {@link MAX_VALIDATION_DEPTH} and the whole evaluation shares a single
 * node-visit budget ({@link MAX_VALIDATION_NODES}); exhausting either emits an
 * explicit error rather than silently accepting the value — the subset never
 * fails open. The schema tree is finite and acyclic (no `$ref`), so combinator
 * branching multiplies work by schema size, never exponentially.
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

/** Deepest schema nesting {@link validateJsonSchemaSubset} evaluates. */
const MAX_VALIDATION_DEPTH = 64;

/** Total (schema node × value node) visits one {@link validateJsonSchemaSubset} call may make. */
const MAX_VALIDATION_NODES = 100_000;

export function validateJsonSchemaSubset(value: unknown, schema: Record<string, unknown>): string[] {
  const errors: string[] = [];
  const budget = { nodes: MAX_VALIDATION_NODES, exceeded: false };
  validateNode(value, schema, "$", { errors, budget, depth: 0 });
  if (budget.exceeded) {
    errors.push(`$: schema evaluation exceeded the limit of ${MAX_VALIDATION_NODES} checks and was stopped`);
  }
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
  "type, enum, properties, required, items, additionalProperties: false, minItems, maxItems, " +
  "minLength, maxLength, minimum, maximum, allOf, anyOf, oneOf, not";

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

/**
 * Per-keyword follow-up for the `"unsupported"` message. Where the subset can
 * express the same intent, name the keyword that does it; where it cannot, say
 * so plainly rather than sending the author to another unsupported keyword.
 */
const UNSUPPORTED_KEYWORD_HINTS = new Map<string, string>([
  ["$ref", `inline the referenced schema (the subset resolves no references, so it cannot follow "$ref")`],
  ["$defs", `inline the definitions at their use sites — "$ref" is not resolved, so "$defs" can never be reached`],
  [
    "definitions",
    `inline the definitions at their use sites — "$ref" is not resolved, so "definitions" can never be reached`,
  ],
  ["const", `use a single-value "enum" (e.g. enum: [pass])`],
  [
    "pattern",
    `use "enum" when the allowed strings can be listed, or "minLength"/"maxLength" for a size bound — ` +
      `a regular-expression constraint is not expressible in the subset; check the shape in the step's gate rubric instead`,
  ],
  [
    "format",
    `"format" is annotation-only in JSON Schema 2020-12 and the subset enforces no string-shape keyword — ` +
      `use "enum" when the allowed values can be listed, otherwise check the shape in the step's gate rubric`,
  ],
  ["patternProperties", `declare the properties explicitly under "properties", or drop the constraint`],
  ["if", `use "anyOf"/"oneOf" to express the alternatives directly`],
  ["then", `use "anyOf"/"oneOf" to express the alternatives directly`],
  ["else", `use "anyOf"/"oneOf" to express the alternatives directly`],
  ["uniqueItems", `drop the constraint, or validate uniqueness in the step's gate rubric`],
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
      const hint = UNSUPPORTED_KEYWORD_HINTS.get(keyword);
      pushIssue(
        issues,
        [...path, keyword],
        keyword,
        "unsupported",
        `keyword "${keyword}" is not enforced by the workflow schema subset — the schema would silently not ` +
          `constrain what it looks like it constrains${hint ? `; ${hint}` : ""}`,
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

  for (const keyword of ["allOf", "anyOf", "oneOf"] as const) {
    const branches = schema[keyword];
    if (branches === undefined) continue;
    if (!Array.isArray(branches) || branches.length === 0) {
      pushIssue(
        issues,
        [...path, keyword],
        keyword,
        "malformed",
        `"${keyword}" must be a non-empty array of schema objects`,
      );
      continue;
    }
    branches.forEach((branch, index) => {
      if (isPlainObject(branch)) {
        checkDefinitionNode(branch, [...path, keyword, index], issues, depth + 1);
      } else {
        pushIssue(
          issues,
          [...path, keyword, index],
          keyword,
          "malformed",
          `"${keyword}[${index}]" must be a schema object`,
        );
      }
    });
  }

  if (schema.not !== undefined) {
    if (isPlainObject(schema.not)) {
      checkDefinitionNode(schema.not, [...path, "not"], issues, depth + 1);
    } else {
      pushIssue(issues, [...path, "not"], "not", "malformed", `"not" must be a schema object`);
    }
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

/**
 * Evaluation state. `budget` is SHARED by every nested/branch evaluation of one
 * {@link validateJsonSchemaSubset} call, so combinator branching cannot buy
 * more work than the whole call is allowed; `errors` is per-branch (a
 * combinator evaluates its branches into a scratch list).
 */
interface EvalCtx {
  errors: string[];
  budget: { nodes: number; exceeded: boolean };
  depth: number;
}

/** Evaluate `schema` against `value` in a scratch error list, sharing the caller's budget. */
function branchErrors(value: unknown, schema: Record<string, unknown>, path: string, ctx: EvalCtx): string[] {
  const errors: string[] = [];
  validateNode(value, schema, path, { errors, budget: ctx.budget, depth: ctx.depth + 1 });
  return errors;
}

/** The schemas of a combinator keyword, or `[]` when the keyword is absent/malformed (permissive). */
function combinatorBranches(schema: Record<string, unknown>, keyword: string): Record<string, unknown>[] {
  const raw = schema[keyword];
  if (!Array.isArray(raw)) return [];
  return raw.filter(isPlainObject);
}

/** First error of each failing branch, truncated — enough to act on without dumping every branch. */
function summarizeBranchFailures(failures: Array<{ index: number; errors: string[] }>): string {
  const shown = failures.slice(0, 3).map((f) => `${f.index + 1}: ${f.errors[0] ?? "no match"}`);
  if (failures.length > shown.length) shown.push(`…${failures.length - shown.length} more`);
  return shown.join("; ");
}

function validateCombinators(value: unknown, schema: Record<string, unknown>, path: string, ctx: EvalCtx): void {
  for (const branch of combinatorBranches(schema, "allOf")) {
    // `allOf` failures ARE the value's failures — surface them verbatim.
    ctx.errors.push(...branchErrors(value, branch, path, ctx));
  }

  for (const keyword of ["anyOf", "oneOf"] as const) {
    const branches = combinatorBranches(schema, keyword);
    if (branches.length === 0) continue;
    const failures: Array<{ index: number; errors: string[] }> = [];
    const matched: number[] = [];
    branches.forEach((branch, index) => {
      const errors = branchErrors(value, branch, path, ctx);
      if (errors.length === 0) matched.push(index + 1);
      else failures.push({ index, errors });
    });
    if (matched.length === 0) {
      ctx.errors.push(
        `${path}: value matches none of the ${branches.length} "${keyword}" schemas (${summarizeBranchFailures(failures)})`,
      );
    } else if (keyword === "oneOf" && matched.length > 1) {
      ctx.errors.push(
        `${path}: value matches ${matched.length} "oneOf" schemas (branches ${matched.join(", ")}); exactly one must match`,
      );
    }
  }

  const not = schema.not;
  if (isPlainObject(not) && branchErrors(value, not, path, ctx).length === 0) {
    ctx.errors.push(`${path}: value must not match the "not" schema`);
  }
}

function validateNode(value: unknown, schema: Record<string, unknown>, path: string, ctx: EvalCtx): void {
  const errors = ctx.errors;
  if (ctx.depth > MAX_VALIDATION_DEPTH) {
    errors.push(`${path}: schema nesting exceeds the depth limit of ${MAX_VALIDATION_DEPTH}`);
    return;
  }
  if (ctx.budget.nodes <= 0) {
    // Fail CLOSED: a truncated evaluation never returns "valid" — the wrapper
    // turns the exhausted budget into a top-level error.
    ctx.budget.exceeded = true;
    return;
  }
  ctx.budget.nodes--;

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

  // Combinators are type-agnostic, so they run BEFORE the per-type branches
  // below (each of which returns). A schema with no combinator keyword is
  // untouched by this call.
  validateCombinators(value, schema, path, ctx);

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
        validateNode(element, items as Record<string, unknown>, `${path}[${index}]`, {
          errors,
          budget: ctx.budget,
          depth: ctx.depth + 1,
        });
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
          validateNode(record[key], propSchema as Record<string, unknown>, `${path}.${key}`, {
            errors,
            budget: ctx.budget,
            depth: ctx.depth + 1,
          });
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
