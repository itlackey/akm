// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * P2a Lane B — the shared input contract (`src/execution/input-contract.ts`).
 *
 * See docs/plans/specs/p2a-task-source-v4.md §4 (Lane B) for the binding
 * design; §1.3 D3, and the disambiguations D3-N1 (import boundary),
 * D3-N2 (canonical JSON byte-equality), and D3-N3 (injected diagnostics
 * vocabulary) in §1.5. Row IDs (B-30, B-31, B-39) are the spec's §2 behavior
 * table. This lane owns ONLY this file.
 *
 * `src/execution/input-contract.ts` does not exist on disk yet — it is
 * Implement's job to create it by generalizing `src/workflows/ir/params.ts`
 * (§4.3). Every reference below to a symbol that module will export once
 * created is a genuine RED-phase reference. Per this phase's convention
 * (established in P1b, `@ts-expect-error P1b red-phase`, commit `ddceaa9`),
 * the single import of that not-yet-existing module below carries one
 * `// @ts-expect-error P2a red-phase: …` directive so `bunx tsc --noEmit`
 * stays green through the RED window: TypeScript reports exactly one
 * diagnostic for an unresolvable module specifier (on the import
 * declaration itself), and every name it introduces is typed `any` for the
 * rest of the file, so no further per-usage directive is needed — and none
 * is added, since a directive on a line with no diagnostic is itself a tsc
 * error ("Unused '@ts-expect-error' directive"). Implement removes the one
 * directive the moment the import resolves.
 *
 * At the bun:test *runtime* (as opposed to tsc), a static top-level import of
 * a module that is not yet on disk fails module resolution when this file is
 * loaded, so every test below is expected to fail as a block during the RED
 * window — that is the intended, and only, RED signal this file produces
 * before Implement lands the module.
 *
 * Three groups, plus a fourth that is deliberately NOT red:
 *
 *   1. The four pure functions' own behavior: `applyInputDefaults`,
 *      `validateInputs`, `materializeInputFlags`, `canonicalInputJson` /
 *      `canonicalInputHash` — each against `src/execution/input-contract.ts`
 *      directly, with no workflow or task machinery involved.
 *   2. `INPUT_NAME_PATTERN` parity with today's (still-exported, unmoved)
 *      `PROGRAM_PARAM_NAME_PATTERN` (D3-N1).
 *   3. The "delegation guarantee": `validateWorkflowParams` and
 *      `materializeWorkflowParameterFlags` — imported from the EXISTING,
 *      already-implemented `src/workflows/ir/params.ts`, unmodified by this
 *      lane's tests — keep their exact current `.message`/`.code`/`.hint()`
 *      byte-identically once params.ts becomes a thin consumer of this
 *      module (§4.3). This group is NOT red: it pins CURRENT behavior so
 *      that Implement's refactor of params.ts cannot silently drift it.
 *   4. Purity: a text/AST import scan of `src/execution/input-contract.ts`
 *      itself, asserting it imports only the D3-N1 allowlist (`node:crypto`,
 *      `src/core/errors`, `src/core/json-schema`, `src/execution/**`) and
 *      specifically none of `node:fs`, storage/db, config, or
 *      `src/workflows/**`. This group needs no `@ts-expect-error`: it reads
 *      the file as text/AST, not as an ES module, so it is RED today for the
 *      ordinary reason that the file does not exist yet (`fs.readFileSync`
 *      throws `ENOENT`), not a TypeScript one.
 */

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { UsageError } from "../../src/core/errors";
import { validateJsonSchemaSubset } from "../../src/core/json-schema";
import {
  applyInputDefaults,
  canonicalInputHash,
  canonicalInputJson,
  INPUT_NAME_PATTERN,
  type InputContract,
  type InputFlag,
  type InputFlagDiagnostics,
  materializeInputFlags,
  validateInputs,
} from "../../src/execution/input-contract";
import {
  materializeWorkflowParameterFlags,
  validateWorkflowParams,
  type WorkflowParameterFlag,
  type WorkflowParameterPlan,
} from "../../src/workflows/ir/params";
import { canonicalJson } from "../../src/workflows/ir/plan-hash";
import { PROGRAM_PARAM_NAME_PATTERN } from "../../src/workflows/parser";

const ROOT = path.resolve(import.meta.dir, "../..");

/** Capture a synchronous throw once, so a message/code pin never re-invokes the function under test. */
function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("expected function to throw");
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

// ── applyInputDefaults (§4.2) ────────────────────────────────────────────────

describe("applyInputDefaults (§4.2) — defaults are additive, supplied values always win", () => {
  test("applies a declared default when the input is absent from values", () => {
    const contract: InputContract = {
      scope: { schema: { type: "string", enum: ["changed", "all"] }, default: "changed", required: false },
    };
    expect(applyInputDefaults(contract, {})).toEqual({ scope: "changed" });
  });

  test("a supplied value wins over the declared default", () => {
    const contract: InputContract = {
      scope: { schema: { type: "string", enum: ["changed", "all"] }, default: "changed", required: false },
    };
    expect(applyInputDefaults(contract, { scope: "all" })).toEqual({ scope: "all" });
  });

  test('explicit false / 0 / "" are preserved and never overridden by a default', () => {
    const contract: InputContract = {
      strict: { schema: { type: "boolean" }, default: true, required: false },
      count: { schema: { type: "integer" }, default: 5, required: false },
      label: { schema: { type: "string" }, default: "x", required: false },
    };
    expect(applyInputDefaults(contract, { strict: false, count: 0, label: "" })).toEqual({
      strict: false,
      count: 0,
      label: "",
    });
  });

  test("a declared input with no default that is absent from values is left absent from the result", () => {
    const contract: InputContract = { ticket: { schema: { type: "string" }, required: false } };
    const result = applyInputDefaults(contract, {});
    expect(result).toEqual({});
    expect(Object.hasOwn(result, "ticket")).toBe(false);
  });

  test("returns a NEW object and never mutates the supplied values", () => {
    const contract: InputContract = { scope: { schema: { type: "string" }, default: "changed", required: false } };
    const values = Object.freeze({ label: "kept" });
    const result = applyInputDefaults(contract, values);
    expect(result).not.toBe(values);
    expect(result).toEqual({ label: "kept", scope: "changed" });
    // `values` is frozen: if applyInputDefaults had mutated it directly this
    // assertion would already have thrown above under strict mode.
    expect(values).toEqual({ label: "kept" });
  });

  test("values not named by the contract pass through unchanged — defaults are additive, not a filter", () => {
    const contract: InputContract = {};
    const values = { anything: 1, nested: { a: 2 } };
    expect(applyInputDefaults(contract, values)).toEqual(values);
  });
});

// ── validateInputs (§4.2) ────────────────────────────────────────────────────

/**
 * A structural mirror of `InputDeclaration`/`InputContract` (§4.2), used only
 * by the two oracle helpers below. During the RED window `InputContract` is
 * itself an unresolved type (see the file docstring), and TypeScript widens
 * `Object.entries()` over an unresolved-type-annotated value to
 * `[string, unknown][]` rather than `[string, any][]` — so these two helpers
 * (which genuinely iterate a contract's entries, unlike every other test
 * below, which only ever passes a contract *into* the real, `any`-typed
 * functions under test) declare their own concrete parameter type instead.
 * It is not a competing source of truth: every fixture built elsewhere in
 * this file is still typed as the real, imported `InputContract`, and this
 * local shape must stay structurally identical to it.
 */
interface ContractFixtureDeclaration {
  readonly schema: Record<string, unknown>;
  readonly default?: unknown;
  readonly required: boolean;
}
type ContractFixture = Readonly<Record<string, ContractFixtureDeclaration>>;

/** The same synthetic `{type:"object",properties:<schemas>}` §4.2 says validateInputs builds. */
function syntheticObjectSchema(contract: ContractFixture): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const [name, declaration] of Object.entries(contract)) {
    properties[name] = declaration.schema;
  }
  return { type: "object", properties };
}

/**
 * Independent oracle for validateInputs' expected output, built from already-
 * trusted `validateJsonSchemaSubset` plus the exact "additionally appends"
 * wording §4.2 quotes verbatim — not a re-implementation of the function
 * under test, since it never imports or calls it.
 */
function expectedValidateInputsErrors(
  contract: ContractFixture,
  values: Record<string, unknown>,
  pathRoot = "$",
): string[] {
  const schemaErrors = validateJsonSchemaSubset(values, syntheticObjectSchema(contract), { redactValues: true }).map(
    (error) => error.replace(/^\$/, pathRoot),
  );
  const missingRequired = Object.entries(contract)
    .filter(([name, declaration]) => declaration.required && !Object.hasOwn(values, name))
    .map(([name]) => `${pathRoot}.${name}: is required`);
  return [...schemaErrors, ...missingRequired];
}

describe("validateInputs (§4.2) — path-prefixed error strings", () => {
  test("a fully valid values object yields no errors", () => {
    const contract: InputContract = {
      scope: { schema: { type: "string", enum: ["changed", "all"] }, required: false },
    };
    expect(validateInputs(contract, { scope: "changed" })).toEqual([]);
  });

  test("a name absent from the contract is not constrained — undeclared inputs pass through", () => {
    const contract: InputContract = { scope: { schema: { type: "string" }, required: false } };
    expect(validateInputs(contract, { scope: "changed", extra: { anything: true } })).toEqual([]);
  });

  test('missing required — exact "<pathRoot>.<name>: is required" message, default pathRoot "$"', () => {
    const contract: InputContract = { ticket: { schema: { type: "string" }, required: true } };
    expect(validateInputs(contract, {})).toEqual(["$.ticket: is required"]);
    expect(validateInputs(contract, { ticket: "AKM-1" })).toEqual([]);
  });

  test("missing required honors a custom pathRoot", () => {
    const contract: InputContract = { ticket: { schema: { type: "string" }, required: true } };
    expect(validateInputs(contract, {}, { pathRoot: "inputs" })).toEqual(["inputs.ticket: is required"]);
  });

  test("schema violation — type mismatch, path-prefixed at the input's own name", () => {
    const contract: InputContract = { count: { schema: { type: "integer", minimum: 1 }, required: false } };
    const values = { count: "not-a-number" };
    expect(validateInputs(contract, values)).toEqual(expectedValidateInputsErrors(contract, values));
    expect(validateInputs(contract, values)).toEqual(["$.count: expected type integer, got string"]);
  });

  test("enum violation", () => {
    const contract: InputContract = { mode: { schema: { type: "string", enum: ["quick", "full"] }, required: false } };
    expect(validateInputs(contract, { mode: "slow" })).toEqual(['$.mode: value is not one of ["quick","full"]']);
  });

  test("nested object violation — path descends through properties, including additionalProperties:false", () => {
    const contract: InputContract = {
      profile: {
        schema: {
          type: "object",
          properties: { level: { type: "string", enum: ["low", "high"] } },
          additionalProperties: false,
        },
        required: false,
      },
    };
    expect(validateInputs(contract, { profile: { level: "medium" } })).toEqual([
      '$.profile.level: value is not one of ["low","high"]',
    ]);
    expect(validateInputs(contract, { profile: { level: "low", extra: 1 } })).toEqual([
      '$.profile: unexpected property "extra" (additionalProperties: false)',
    ]);
  });

  test("nested array violation — path carries the element index", () => {
    const contract: InputContract = {
      tags: { schema: { type: "array", items: { type: "string", minLength: 2 } }, required: false },
    };
    expect(validateInputs(contract, { tags: ["ok", "a"] })).toEqual(["$.tags[1]: string shorter than minLength 2"]);
  });

  test("every returned error string is prefixed with the resolved pathRoot", () => {
    const contract: InputContract = {
      count: { schema: { type: "integer", minimum: 5 }, required: false },
      ticket: { schema: { type: "string" }, required: true },
    };
    const errors = validateInputs(contract, { count: 1 }, { pathRoot: "params" });
    expect(errors.length).toBeGreaterThan(0);
    for (const error of errors as readonly string[]) expect(error.startsWith("params.")).toBe(true);
  });

  test("a schema violation on one input and a missing required on another are both reported, schema errors first", () => {
    const contract: InputContract = {
      count: { schema: { type: "integer", minimum: 5 }, required: false },
      ticket: { schema: { type: "string" }, required: true },
    };
    const values = { count: 1 };
    expect(validateInputs(contract, values)).toEqual(expectedValidateInputsErrors(contract, values));
    expect(validateInputs(contract, values)).toEqual(["$.count: value is below minimum 5", "$.ticket: is required"]);
  });
});

// ── materializeInputFlags (§4.2, D3-N3) ──────────────────────────────────────

interface DiagnosticsProbe {
  readonly diagnostics: InputFlagDiagnostics;
  readonly calls: {
    unknownFlag: Array<{ name: string; declared: readonly string[] }>;
    invalidValue: Array<{ name: string; detail: string }>;
    contractViolation: Array<{ errors: readonly string[] }>;
    duplicateNonArray: Array<{ name: string }>;
    malformedJson: Array<{ name: string }>;
  };
  readonly errors: {
    unknownFlag: UsageError;
    invalidValue: UsageError;
    contractViolation: UsageError;
    duplicateNonArray: UsageError;
    malformedJson: UsageError;
  };
}

/** A diagnostics vocabulary that records every call and returns a uniquely-identifiable sentinel UsageError. */
function probeDiagnostics(): DiagnosticsProbe {
  const calls: DiagnosticsProbe["calls"] = {
    unknownFlag: [],
    invalidValue: [],
    contractViolation: [],
    duplicateNonArray: [],
    malformedJson: [],
  };
  const errors: DiagnosticsProbe["errors"] = {
    unknownFlag: new UsageError("PROBE:unknownFlag", "UNKNOWN_FLAG"),
    invalidValue: new UsageError("PROBE:invalidValue", "INPUT_BINDING_INVALID"),
    contractViolation: new UsageError("PROBE:contractViolation", "INPUT_BINDING_INVALID"),
    duplicateNonArray: new UsageError("PROBE:duplicateNonArray", "INPUT_BINDING_INVALID"),
    malformedJson: new UsageError("PROBE:malformedJson", "INPUT_BINDING_INVALID"),
  };
  const diagnostics: InputFlagDiagnostics = {
    unknownFlag: (name: string, declared: readonly string[]) => {
      calls.unknownFlag.push({ name, declared });
      return errors.unknownFlag;
    },
    invalidValue: (name: string, detail: string) => {
      calls.invalidValue.push({ name, detail });
      return errors.invalidValue;
    },
    contractViolation: (violationErrors: readonly string[]) => {
      calls.contractViolation.push({ errors: violationErrors });
      return errors.contractViolation;
    },
    duplicateNonArray: (name: string) => {
      calls.duplicateNonArray.push({ name });
      return errors.duplicateNonArray;
    },
    malformedJson: (name: string) => {
      calls.malformedJson.push({ name });
      return errors.malformedJson;
    },
  };
  return { diagnostics, calls, errors };
}

/** A diagnostics vocabulary whose every formatter throws — proves a happy path calls none of them. */
function poisonedDiagnostics(): InputFlagDiagnostics {
  const fail = (label: string) => (): never => {
    throw new Error(`materializeInputFlags unexpectedly invoked diagnostics.${label} on a valid flag set`);
  };
  return {
    unknownFlag: fail("unknownFlag"),
    invalidValue: fail("invalidValue"),
    contractViolation: fail("contractViolation"),
    duplicateNonArray: fail("duplicateNonArray"),
    malformedJson: fail("malformedJson"),
  };
}

describe("materializeInputFlags (§4.2, D3-N3) — exact-name matching and coercion", () => {
  test("zero contract, zero flags: returns {} and calls no diagnostic (B-26 baseline)", () => {
    expect(materializeInputFlags({}, [], poisonedDiagnostics())).toEqual({});
  });

  test("an empty contract rejects ANY flag with unknownFlag — a v3 task's empty contract rejects every input (§5.1)", () => {
    const probe = probeDiagnostics();
    const flags: InputFlag[] = [{ name: "x", value: "1" }];
    const err = thrown(() => materializeInputFlags({}, flags, probe.diagnostics));
    expect(err).toBe(probe.errors.unknownFlag);
    expect(probe.calls.unknownFlag).toEqual([{ name: "x", declared: [] }]);
  });

  test("exact-name matching: an undeclared/typo'd flag name throws unknownFlag with the full declared set", () => {
    const probe = probeDiagnostics();
    const contract: InputContract = {
      scope: { schema: { type: "string" }, required: false },
      mode: { schema: { type: "string" }, required: false },
    };
    const err = thrown(() => materializeInputFlags(contract, [{ name: "scoep", value: "x" }], probe.diagnostics));
    expect(err).toBe(probe.errors.unknownFlag);
    expect((err as UsageError).code).toBe("UNKNOWN_FLAG");
    expect(probe.calls.unknownFlag).toHaveLength(1);
    expect(probe.calls.unknownFlag[0]?.name).toBe("scoep");
    expect([...(probe.calls.unknownFlag[0]?.declared ?? [])].sort()).toEqual(["mode", "scope"]);
    expect(probe.calls.invalidValue).toHaveLength(0);
  });

  test("exact-name matching: a name that fails the input-name pattern is unknown even if it happened to be a contract key", () => {
    // Mirrors materializeWorkflowParameterFlags: the flag name is checked
    // against the name pattern independently of contract membership
    // (params.ts:46, `!PROGRAM_PARAM_NAME_PATTERN.test(flag.name) || !declared.has(flag.name)`).
    const probe = probeDiagnostics();
    const contract = { "in-put": { schema: { type: "string" }, required: false } } as InputContract;
    const err = thrown(() => materializeInputFlags(contract, [{ name: "in-put", value: "x" }], probe.diagnostics));
    expect(err).toBe(probe.errors.unknownFlag);
    expect(probe.calls.unknownFlag[0]?.name).toBe("in-put");
  });

  test("a correctly-named flag round-trips with no diagnostic call", () => {
    const contract: InputContract = { scope: { schema: { type: "string" }, required: false } };
    expect(materializeInputFlags(contract, [{ name: "scope", value: "x" }], poisonedDiagnostics())).toEqual({
      scope: "x",
    });
  });

  test("repeated flag on an array-declared input groups into an array, in supplied order", () => {
    const contract: InputContract = {
      tags: { schema: { type: "array", items: { type: "string" } }, required: false },
    };
    const flags: InputFlag[] = [
      { name: "tags", value: "api" },
      { name: "tags", value: "worker" },
    ];
    expect(materializeInputFlags(contract, flags, poisonedDiagnostics())).toEqual({ tags: ["api", "worker"] });
  });

  test("JSON-array shorthand: a single value starting with `[` is parsed as JSON", () => {
    const contract: InputContract = {
      tags: { schema: { type: "array", items: { type: "string" } }, required: false },
    };
    expect(materializeInputFlags(contract, [{ name: "tags", value: '["a","b"]' }], poisonedDiagnostics())).toEqual({
      tags: ["a", "b"],
    });
  });

  test("malformed JSON-array shorthand throws malformedJson, not invalidValue", () => {
    const probe = probeDiagnostics();
    const contract: InputContract = { tags: { schema: { type: "array" }, required: false } };
    const err = thrown(() =>
      materializeInputFlags(contract, [{ name: "tags", value: "[not json" }], probe.diagnostics),
    );
    expect(err).toBe(probe.errors.malformedJson);
    expect(probe.calls.malformedJson).toEqual([{ name: "tags" }]);
    expect(probe.calls.invalidValue).toHaveLength(0);
  });

  test("repeated-flag rejection for a non-array declaration throws duplicateNonArray", () => {
    const probe = probeDiagnostics();
    const contract: InputContract = { mode: { schema: { type: "string" }, required: false } };
    const flags: InputFlag[] = [
      { name: "mode", value: "a" },
      { name: "mode", value: "b" },
    ];
    const err = thrown(() => materializeInputFlags(contract, flags, probe.diagnostics));
    expect(err).toBe(probe.errors.duplicateNonArray);
    expect((err as UsageError).code).toBe("INPUT_BINDING_INVALID");
    expect(probe.calls.duplicateNonArray).toEqual([{ name: "mode" }]);
  });

  test("boolean flags: a bare (native-boolean) flag on a boolean-declared input passes through unchanged", () => {
    const contract: InputContract = { strict: { schema: { type: "boolean" }, required: false } };
    expect(materializeInputFlags(contract, [{ name: "strict", value: true }], poisonedDiagnostics())).toEqual({
      strict: true,
    });
  });

  test('boolean flags: the strings "true"/"false" coerce to real booleans on a boolean-declared input', () => {
    const contract: InputContract = { strict: { schema: { type: "boolean" }, required: false } };
    expect(materializeInputFlags(contract, [{ name: "strict", value: "true" }], poisonedDiagnostics())).toEqual({
      strict: true,
    });
    expect(materializeInputFlags(contract, [{ name: "strict", value: "false" }], poisonedDiagnostics())).toEqual({
      strict: false,
    });
  });

  test('a native-boolean flag on a string-declared input stringifies (String(true) === "true")', () => {
    const contract: InputContract = { name: { schema: { type: "string" }, required: false } };
    expect(materializeInputFlags(contract, [{ name: "name", value: true }], poisonedDiagnostics())).toEqual({
      name: "true",
    });
  });

  test("a native-boolean flag on a type it can satisfy neither as boolean nor string throws invalidValue", () => {
    const probe = probeDiagnostics();
    const contract: InputContract = { count: { schema: { type: "integer" }, required: false } };
    const err = thrown(() => materializeInputFlags(contract, [{ name: "count", value: true }], probe.diagnostics));
    expect(err).toBe(probe.errors.invalidValue);
    expect((err as UsageError).code).toBe("INPUT_BINDING_INVALID");
    expect(probe.calls.invalidValue).toEqual([{ name: "count", detail: "requires a value of type integer" }]);
  });

  test('numeric-looking string preserved exactly: --version 001 on type:"string" stays the string "001" (B-30)', () => {
    const contract: InputContract = { version: { schema: { type: "string" }, required: false } };
    const result = materializeInputFlags(contract, [{ name: "version", value: "001" }], poisonedDiagnostics());
    expect(result).toEqual({ version: "001" });
    expect(typeof (result as { version: unknown }).version).toBe("string");
  });

  test('a string/number union also keeps the exact text: --version 007 on type:["number","string"] stays "007"', () => {
    const contract: InputContract = { version: { schema: { type: ["number", "string"] }, required: false } };
    const result = materializeInputFlags(contract, [{ name: "version", value: "007" }], poisonedDiagnostics());
    expect(result).toEqual({ version: "007" });
  });

  test("a plain integer-declared flag DOES coerce to a real number", () => {
    const contract: InputContract = { count: { schema: { type: "integer" }, required: false } };
    const result = materializeInputFlags(contract, [{ name: "count", value: "42" }], poisonedDiagnostics());
    expect(result).toEqual({ count: 42 });
    expect(typeof (result as { count: unknown }).count).toBe("number");
  });

  test("an untyped declaration (no `type` keyword) leaves any raw value untouched, string or boolean", () => {
    const contract: InputContract = { anything: { schema: {}, required: false } };
    expect(materializeInputFlags(contract, [{ name: "anything", value: "007" }], poisonedDiagnostics())).toEqual({
      anything: "007",
    });
    expect(materializeInputFlags(contract, [{ name: "anything", value: true }], poisonedDiagnostics())).toEqual({
      anything: true,
    });
  });

  // Regression (finding F1): `materializeFlagValues` took the array-grouping
  // branch whenever "array" appeared ANYWHERE in a union type — even when the
  // union also permits a scalar type that a single, non-bracketed value could
  // satisfy directly. A single `--x hello` against `type:["array","string"]`
  // was silently wrapped into `["hello"]` instead of staying the string
  // "hello", because the per-element map coerced against `items` (or nothing)
  // rather than trying the union's scalar alternatives first. This is
  // distinct from, and must not change, an array-ONLY declaration's existing
  // behavior (the two tests directly above, and the "repeated flag" / "JSON
  // shorthand" tests earlier in this describe block, all use a sole
  // `type: "array"` and are unaffected by this fix).
  describe('a union type that includes "array" alongside a scalar type (F1)', () => {
    test('a single, non-bracketed value on type:["array","string"] stays the string, never wrapped in an array', () => {
      const contract: InputContract = { x: { schema: { type: ["array", "string"] }, required: false } };
      const result = materializeInputFlags(contract, [{ name: "x", value: "hello" }], poisonedDiagnostics());
      expect(result).toEqual({ x: "hello" });
      expect(Array.isArray((result as { x: unknown }).x)).toBe(false);
    });

    test('a single "null" value on type:["array","null"] coerces to real null, not ["null"]', () => {
      const contract: InputContract = { x: { schema: { type: ["array", "null"] }, required: false } };
      expect(materializeInputFlags(contract, [{ name: "x", value: "null" }], poisonedDiagnostics())).toEqual({
        x: null,
      });
    });

    test('a numeric-looking string on type:["array","string"] is preserved exactly too (B-30 still applies inside the union)', () => {
      const contract: InputContract = { version: { schema: { type: ["array", "string"] }, required: false } };
      const result = materializeInputFlags(contract, [{ name: "version", value: "001" }], poisonedDiagnostics());
      expect(result).toEqual({ version: "001" });
      expect(typeof (result as { version: unknown }).version).toBe("string");
    });
  });

  test("invalid value error code: an unsatisfiable type coercion throws invalidValue with a detail naming the accepted types", () => {
    const probe = probeDiagnostics();
    const contract: InputContract = { count: { schema: { type: "integer" }, required: false } };
    const err = thrown(() =>
      materializeInputFlags(contract, [{ name: "count", value: "not-a-number" }], probe.diagnostics),
    );
    expect(err).toBe(probe.errors.invalidValue);
    expect((err as UsageError).code).toBe("INPUT_BINDING_INVALID");
    expect(probe.calls.invalidValue).toEqual([{ name: "count", detail: "must be integer" }]);
  });

  test("an unsatisfiable coercion never echoes the supplied value — typed flags can carry credentials", () => {
    const probe = probeDiagnostics();
    const contract: InputContract = { token: { schema: { type: "number" }, required: false } };
    const err = thrown(() =>
      materializeInputFlags(contract, [{ name: "token", value: "hunter2-secret" }], probe.diagnostics),
    );
    expect((err as UsageError).message).not.toContain("hunter2-secret");
    expect(JSON.stringify(probe.calls.invalidValue)).not.toContain("hunter2-secret");
  });

  test("ends by running validateInputs and raising contractViolation(errors) when the materialized flags violate the contract", () => {
    const probe = probeDiagnostics();
    const contract: InputContract = { count: { schema: { type: "integer", minimum: 5 }, required: false } };
    const values = { count: 2 };
    const expectedErrors = expectedValidateInputsErrors(contract, values);
    expect(expectedErrors).toEqual(["$.count: value is below minimum 5"]);

    const err = thrown(() => materializeInputFlags(contract, [{ name: "count", value: "2" }], probe.diagnostics));
    expect(err).toBe(probe.errors.contractViolation);
    expect((err as UsageError).code).toBe("INPUT_BINDING_INVALID");
    expect(probe.calls.contractViolation).toEqual([{ errors: expectedErrors }]);
  });
});

// ── canonicalInputJson / canonicalInputHash (D3-N2, B-39) ────────────────────

/** Nested objects, arrays, null, unicode keys, and insertion-order permutations — D3-N2's named categories. */
const CANONICAL_JSON_FIXTURES: readonly unknown[] = [
  {},
  { outer: { z: 1, a: 2 }, list: [3, 1, 2] },
  { a: null, b: [null, 1, null] },
  { héllo: "wörld", 日本語: 123 },
  { scope: "changed", strict: true, count: 0, tags: ["a", "b"], nested: { z: 1, a: { deep: [1, { y: 2, x: 1 }] } } },
];

describe("canonicalInputJson — byte-equal to canonicalJson (D3-N2)", () => {
  CANONICAL_JSON_FIXTURES.forEach((fixture, index) => {
    test(`fixture #${index} is byte-equal to canonicalJson`, () => {
      expect(canonicalInputJson(fixture)).toBe(canonicalJson(fixture));
    });
  });

  test("bare top-level primitives (string, number, boolean, null) are byte-equal to canonicalJson too", () => {
    for (const fixture of ["a plain string", 42, true, null] as const) {
      expect(canonicalInputJson(fixture)).toBe(canonicalJson(fixture));
    }
  });

  test("is stable across nested insertion-order permutations of the SAME logical value", () => {
    const a = { outer: { z: 1, a: 2, m: 3 }, list: [{ y: 1, x: 2 }] };
    const b = { list: [{ x: 2, y: 1 }], outer: { a: 2, m: 3, z: 1 } };
    expect(canonicalInputJson(a)).toBe(canonicalInputJson(b));
    expect(canonicalInputJson(a)).toBe(canonicalJson(a));
    expect(canonicalInputJson(b)).toBe(canonicalJson(b));
  });
});

describe("canonicalInputHash (D3-N2, B-39)", () => {
  test("is a stable 64-character lowercase hex sha256 digest", () => {
    const hash = canonicalInputHash({ a: 1 });
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(canonicalInputHash({ a: 1 })).toBe(hash);
  });

  test("matches an independently computed sha256 of canonicalJson's own output", () => {
    const value = { outer: { z: 1, a: 2 }, list: [3, 1, 2] };
    expect(canonicalInputHash(value)).toBe(sha256Hex(canonicalJson(value)));
  });

  test("is stable across top-level and nested key-order permutations", () => {
    const a = { b: 2, a: 1, nested: { y: 2, x: 1 } };
    const b = { a: 1, nested: { x: 1, y: 2 }, b: 2 };
    expect(canonicalInputHash(a)).toBe(canonicalInputHash(b));
  });

  test("differs when any top-level or nested value differs", () => {
    const base = { scope: "changed", nested: { count: 1 } };
    const baseHash = canonicalInputHash(base);
    expect(canonicalInputHash({ scope: "all", nested: { count: 1 } })).not.toBe(baseHash);
    expect(canonicalInputHash({ scope: "changed", nested: { count: 2 } })).not.toBe(baseHash);
  });

  test("is stable across equivalent JS number spellings (1 and 1.0 are the identical runtime value)", () => {
    expect(canonicalInputHash({ n: 1 })).toBe(canonicalInputHash({ n: 1.0 }));
  });

  test("is NOT stable across a string/number or string/boolean spelling — the hash does not normalize types", () => {
    expect(canonicalInputHash({ version: "1" })).not.toBe(canonicalInputHash({ version: 1 }));
    expect(canonicalInputHash({ flag: "true" })).not.toBe(canonicalInputHash({ flag: true }));
    // The "001 stays a string" contract (B-30) at the hash layer: a numeric-
    // looking string must not collapse onto the number it resembles.
    expect(canonicalInputHash({ version: "001" })).not.toBe(canonicalInputHash({ version: 1 }));
  });
});

// ── INPUT_NAME_PATTERN (D3-N1) ───────────────────────────────────────────────

describe("INPUT_NAME_PATTERN (D3-N1) — same grammar as today's PROGRAM_PARAM_NAME_PATTERN", () => {
  test("accepts/rejects the same identifier shapes as PROGRAM_PARAM_NAME_PATTERN", () => {
    const accepted = ["scope", "_scope", "scope1", "SCOPE_2"];
    const rejected = ["1scope", "sco-pe", "sco.pe", "", " scope", "scope "];
    for (const name of accepted) {
      expect(INPUT_NAME_PATTERN.test(name)).toBe(true);
      expect(PROGRAM_PARAM_NAME_PATTERN.test(name)).toBe(true);
    }
    for (const name of rejected) {
      expect(INPUT_NAME_PATTERN.test(name)).toBe(false);
      expect(PROGRAM_PARAM_NAME_PATTERN.test(name)).toBe(false);
    }
  });

  test("is the exact same regex source and flags as today's PROGRAM_PARAM_NAME_PATTERN (F-3: a re-export, not a redefinition)", () => {
    expect(INPUT_NAME_PATTERN.source).toBe(PROGRAM_PARAM_NAME_PATTERN.source);
    expect(INPUT_NAME_PATTERN.flags).toBe(PROGRAM_PARAM_NAME_PATTERN.flags);
  });
});

// ── Delegation guarantee: params.ts stays byte-identical (§4.3) ─────────────
//
// NOT a red-phase group: `validateWorkflowParams` and
// `materializeWorkflowParameterFlags` already exist and already produce these
// exact strings/codes/hints today, before params.ts is touched. These tests
// pin that CURRENT behavior precisely (full `.message`/`.code`/`.hint()`
// equality, not a `.toThrow(substring)` match) specifically so that once
// Implement turns params.ts into a thin consumer of
// `src/execution/input-contract.ts` (§4.3), any drift in the wrapper's
// observable contract is caught here — independent of, and in addition to,
// `tests/workflows/workflow-param-flags.test.ts` and
// `tests/integration/workflows/params-validation.test.ts`, which this lane
// does not own and must stay byte-unchanged.

describe("delegation guarantee — materializeWorkflowParameterFlags keeps its exact current messages/codes/hints", () => {
  test("unknown flag: exact message, UNKNOWN_FLAG code, and the sorted 'Declared parameters' hint", () => {
    const plan: WorkflowParameterPlan = {
      params: ["alpha", "beta"],
      paramSchemas: { alpha: { type: "string" }, beta: { type: "integer" } },
    };
    const err = thrown(() => materializeWorkflowParameterFlags(plan, [{ name: "gamma", value: "x" }]));
    expect(err).toBeInstanceOf(UsageError);
    const usageError = err as UsageError;
    expect(usageError.code).toBe("UNKNOWN_FLAG");
    expect(usageError.message).toBe(
      'Unknown workflow parameter "--gamma". Parameter flags must exactly match a declared workflow parameter.',
    );
    expect(usageError.hint()).toBe("Declared parameters: --alpha, --beta.");
  });

  test("unknown flag on a plan with no declared parameters: the no-parameters hint", () => {
    const err = thrown(() => materializeWorkflowParameterFlags({}, [{ name: "anything", value: "x" }]));
    const usageError = err as UsageError;
    expect(usageError.code).toBe("UNKNOWN_FLAG");
    expect(usageError.message).toBe(
      'Unknown workflow parameter "--anything". Parameter flags must exactly match a declared workflow parameter.',
    );
    expect(usageError.hint()).toBe("This workflow declares no parameters.");
  });

  test("duplicate non-array parameter: exact message and INVALID_FLAG_VALUE code", () => {
    const plan: WorkflowParameterPlan = { params: ["count"], paramSchemas: { count: { type: "integer" } } };
    const flags: WorkflowParameterFlag[] = [
      { name: "count", value: "2" },
      { name: "count", value: "3" },
    ];
    const err = thrown(() => materializeWorkflowParameterFlags(plan, flags));
    const usageError = err as UsageError;
    expect(usageError.code).toBe("INVALID_FLAG_VALUE");
    expect(usageError.message).toBe(
      'Workflow parameter "--count" was provided more than once but is not declared as an array.',
    );
  });

  test("schema-violating flag value: exact wrapper message built from validateWorkflowParams' own re-rooted errors", () => {
    const plan: WorkflowParameterPlan = { params: ["count"], paramSchemas: { count: { type: "integer", minimum: 5 } } };
    const expectedErrors = validateWorkflowParams(plan, { count: 2 });
    expect(expectedErrors).toEqual(["params.count: value is below minimum 5"]);

    const err = thrown(() => materializeWorkflowParameterFlags(plan, [{ name: "count", value: "2" }]));
    const usageError = err as UsageError;
    expect(usageError.code).toBe("INVALID_FLAG_VALUE");
    expect(usageError.message).toBe(
      `Workflow parameter flags do not satisfy the workflow's declared schemas:\n${expectedErrors.map((error) => `  - ${error}`).join("\n")}`,
    );
  });

  test("returns {} for zero flags before anything else, regardless of plan shape (params.ts:41)", () => {
    const plan: WorkflowParameterPlan = { params: ["a"], paramSchemas: { a: { type: "string" } } };
    expect(materializeWorkflowParameterFlags(plan, [])).toEqual({});
  });
});

describe("delegation guarantee — validateWorkflowParams keeps its exact current re-rooted error strings", () => {
  test("an empty or absent paramSchemas map is not constrained at all — returns []", () => {
    expect(validateWorkflowParams({}, { anything: 1 })).toEqual([]);
    expect(validateWorkflowParams({ paramSchemas: {} }, { anything: 1 })).toEqual([]);
  });

  test("an enum violation re-roots the leading $ to params.", () => {
    const plan: WorkflowParameterPlan = { paramSchemas: { mode: { type: "string", enum: ["quick", "full"] } } };
    expect(validateWorkflowParams(plan, { mode: "slow" })).toEqual([
      'params.mode: value is not one of ["quick","full"]',
    ]);
    expect(validateWorkflowParams(plan, { mode: "quick" })).toEqual([]);
  });
});

// ── Purity: src/execution/input-contract.ts's own import boundary ──────────
//
// Not a TypeScript red-phase group (see the file docstring) — reads the
// source file as text/AST, so it is RED today because the file does not
// exist (`fs.readFileSync` throws `ENOENT`), the ordinary way a not-yet-
// written file makes a test fail.

/** Top-level `import ... from "..."` and `export ... from "..."` module specifiers in a TypeScript source file. */
function importedModuleSpecifiers(filePath: string): string[] {
  const sourceText = fs.readFileSync(filePath, "utf8");
  const source = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true);
  const specifiers: string[] = [];
  source.forEachChild((node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      specifiers.push(node.moduleSpecifier.text);
    }
  });
  return specifiers;
}

const INPUT_CONTRACT_PATH = path.join(ROOT, "src/execution/input-contract.ts");
const EXECUTION_ROOT = path.resolve(ROOT, "src/execution");
const CORE_ERRORS = path.resolve(ROOT, "src/core/errors");
const CORE_JSON_SCHEMA = path.resolve(ROOT, "src/core/json-schema");

/** D3-N1's exact allowlist: node:crypto, src/core/errors, src/core/json-schema, src/execution/**. */
function isAllowedInputContractSpecifier(specifier: string): boolean {
  if (specifier === "node:crypto") return true;
  if (!specifier.startsWith(".")) return false;
  const resolved = path.resolve(path.dirname(INPUT_CONTRACT_PATH), specifier);
  return (
    resolved === CORE_ERRORS ||
    resolved === CORE_JSON_SCHEMA ||
    resolved === EXECUTION_ROOT ||
    resolved.startsWith(`${EXECUTION_ROOT}${path.sep}`)
  );
}

describe("purity — src/execution/input-contract.ts imports only the D3-N1 allowlist", () => {
  test("imports something (guards against a vacuous pass on an empty stub)", () => {
    expect(importedModuleSpecifiers(INPUT_CONTRACT_PATH).length).toBeGreaterThan(0);
  });

  test("every import specifier is node:crypto, src/core/errors, src/core/json-schema, or under src/execution/**", () => {
    const specifiers = importedModuleSpecifiers(INPUT_CONTRACT_PATH);
    for (const specifier of specifiers) {
      expect({ specifier, allowed: isAllowedInputContractSpecifier(specifier) }).toEqual({
        specifier,
        allowed: true,
      });
    }
  });

  test("imports no node:fs (no IO — the pure-module header property)", () => {
    const specifiers = importedModuleSpecifiers(INPUT_CONTRACT_PATH);
    expect(specifiers.some((specifier) => specifier === "fs" || specifier === "node:fs")).toBe(false);
  });

  test("imports no storage/db module", () => {
    const specifiers = importedModuleSpecifiers(INPUT_CONTRACT_PATH);
    expect(specifiers.some((specifier) => /\bstorage\b|state-db/.test(specifier))).toBe(false);
  });

  test("imports no config module", () => {
    const specifiers = importedModuleSpecifiers(INPUT_CONTRACT_PATH);
    expect(specifiers.some((specifier) => /\bconfig\b/.test(specifier))).toBe(false);
  });

  test("imports nothing from src/workflows/** (D3-N1: execution must not import workflows)", () => {
    const specifiers = importedModuleSpecifiers(INPUT_CONTRACT_PATH);
    expect(specifiers.some((specifier) => /workflows/.test(specifier))).toBe(false);
  });

  test("keeps params.ts's pure-module header line, and names this spec plus D3-N1/D3-N2", () => {
    const sourceText = fs.readFileSync(INPUT_CONTRACT_PATH, "utf8");
    expect(sourceText).toContain("Pure module: no IO, no engine imports.");
    expect(sourceText).toContain("D3-N1");
    expect(sourceText).toContain("D3-N2");
  });
});

// ── Structure: src/workflows/ir/params.ts becomes a THIN CONSUMER (§4.3, §9) ─
//
// Test-review remediation (finding recorded against
// tests/execution/input-contract.test.ts:678): the "delegation guarantee"
// group above pins ONLY the wrappers' observable strings/codes/hints, which
// an UNTOUCHED params.ts — one that adds this file and leaves its OWN
// duplicate coercion/validation logic in place — satisfies trivially, since
// nothing routes through the new module at all. §9's structure criterion is
// explicit: "src/workflows/ir/params.ts contains no coercion or validation
// logic of its own — only the plan→contract adapter, the diagnostics
// vocabulary, and the three re-exported wrappers." This is the mirror image
// of the purity scan directly above — same `importedModuleSpecifiers` helper,
// pointed at params.ts instead of input-contract.ts — plus a declaration scan
// proving the four private coercion helpers (`coerceFlagValue`, `schemaTypes`,
// `materializeFlagValues`, `parseJsonFlag`) are GONE from params.ts, not
// merely unused.
//
// NOT a red-phase group in the tsc sense (params.ts already exists and
// compiles today) — it reads params.ts as text/AST, so it is genuinely RED
// right now for the ordinary reason that params.ts has not been rewritten
// yet: it imports nothing from ../../execution/input-contract, and it still
// declares all four helpers itself (src/workflows/ir/params.ts:78-160, read
// directly above by the "delegation guarantee" group's own module import).

const PARAMS_TS_PATH = path.join(ROOT, "src/workflows/ir/params.ts");
const INPUT_CONTRACT_MODULE = path.resolve(EXECUTION_ROOT, "input-contract");
const PARAMS_TS_MOVED_HELPERS = ["coerceFlagValue", "schemaTypes", "materializeFlagValues", "parseJsonFlag"] as const;

/** Every name a TypeScript source file declares at its TOP LEVEL via `function`, `const`/`let`/`var`, or `class`. */
function topLevelDeclaredNames(filePath: string): Set<string> {
  const sourceText = fs.readFileSync(filePath, "utf8");
  const source = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true);
  const names = new Set<string>();
  source.forEachChild((node) => {
    if (ts.isFunctionDeclaration(node) && node.name) {
      names.add(node.name.text);
    } else if (ts.isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) names.add(declaration.name.text);
      }
    } else if (ts.isClassDeclaration(node) && node.name) {
      names.add(node.name.text);
    }
  });
  return names;
}

describe("structure — src/workflows/ir/params.ts becomes a thin consumer of input-contract.ts (§4.3, §9)", () => {
  test("imports from ../../execution/input-contract", () => {
    const specifiers = importedModuleSpecifiers(PARAMS_TS_PATH);
    const resolvesToInputContract = specifiers.some(
      (specifier) =>
        specifier.startsWith(".") && path.resolve(path.dirname(PARAMS_TS_PATH), specifier) === INPUT_CONTRACT_MODULE,
    );
    expect({ specifiers, resolvesToInputContract }).toEqual({ specifiers, resolvesToInputContract: true });
  });

  test("no longer declares coerceFlagValue / schemaTypes / materializeFlagValues / parseJsonFlag itself", () => {
    const declared = topLevelDeclaredNames(PARAMS_TS_PATH);
    for (const helper of PARAMS_TS_MOVED_HELPERS) {
      expect({ helper, stillDeclaredLocally: declared.has(helper) }).toEqual({ helper, stillDeclaredLocally: false });
    }
  });
});
