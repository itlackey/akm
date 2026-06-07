/**
 * Tests for the structured-output (`responseSchema`) lift in `akm consolidate`.
 *
 * Asset-writers-investigation PR 1: the chunk-plan LLM call now passes the
 * CONSOLIDATE_PLAN_JSON_SCHEMA so providers that honour
 * `response_format: json_schema` enforce the `{operations, warnings?}` shape
 * upstream. The chunk-level "invalid plan from AI — skipping" branch in
 * `runConsolidate` becomes unreachable for schema-honouring providers.
 *
 * These are schema-shape unit tests; the end-to-end LLM call site is exercised
 * by the existing `consolidate-chunks` / `consolidate-pipeline-fixes` tests.
 */

import { describe, expect, test } from "bun:test";

import { CONSOLIDATE_PLAN_JSON_SCHEMA } from "../../../src/commands/improve/consolidate";

// Internal-shape view of the schema for assertion convenience.
interface SchemaView {
  type: string;
  required: string[];
  additionalProperties: boolean;
  properties: {
    operations: {
      type: string;
      items: { oneOf: Array<{ type: string; required: string[]; properties: Record<string, unknown> }> };
    };
    warnings: { type: string; items: { type: string } };
  };
}

describe("CONSOLIDATE_PLAN_JSON_SCHEMA — top-level shape", () => {
  test("requires operations array, warnings optional", () => {
    const s = CONSOLIDATE_PLAN_JSON_SCHEMA as unknown as SchemaView;
    expect(s.type).toBe("object");
    expect(s.required).toContain("operations");
    expect(s.required).not.toContain("warnings");
  });

  test("forbids additionalProperties at the top level", () => {
    const s = CONSOLIDATE_PLAN_JSON_SCHEMA as unknown as SchemaView;
    expect(s.additionalProperties).toBe(false);
  });

  test("operations is an array of one-of operation variants", () => {
    const s = CONSOLIDATE_PLAN_JSON_SCHEMA as unknown as SchemaView;
    expect(s.properties.operations.type).toBe("array");
    expect(Array.isArray(s.properties.operations.items.oneOf)).toBe(true);
    // The four current op variants — merge / delete / promote / contradict.
    expect(s.properties.operations.items.oneOf.length).toBe(4);
  });

  test("warnings is a string array when present", () => {
    const s = CONSOLIDATE_PLAN_JSON_SCHEMA as unknown as SchemaView;
    expect(s.properties.warnings.type).toBe("array");
    expect(s.properties.warnings.items.type).toBe("string");
  });
});

describe("CONSOLIDATE_PLAN_JSON_SCHEMA — per-variant required fields", () => {
  function variant(opName: string): { type: string; required: string[]; properties: Record<string, unknown> } {
    const s = CONSOLIDATE_PLAN_JSON_SCHEMA as unknown as SchemaView;
    const found = s.properties.operations.items.oneOf.find((v) => {
      const opProp = v.properties.op as { enum?: string[] } | undefined;
      return Array.isArray(opProp?.enum) && opProp.enum.includes(opName);
    });
    if (!found) throw new Error(`variant for op=${opName} not found in schema`);
    return found;
  }

  test("merge op requires primary, secondaries (>=1), and mergeStrategy", () => {
    const v = variant("merge");
    expect(v.required).toContain("primary");
    expect(v.required).toContain("secondaries");
    expect(v.required).toContain("mergeStrategy");
    const secs = v.properties.secondaries as { minItems?: number; items?: { type?: string } };
    expect(secs.minItems).toBe(1);
    expect(secs.items?.type).toBe("string");
  });

  test("delete op requires ref and reason — no extra fields permitted", () => {
    const v = variant("delete");
    expect(v.required).toContain("ref");
    expect(v.required).toContain("reason");
    // additionalProperties off so the LLM cannot smuggle an unsanctioned field.
    const view = v as unknown as { additionalProperties: boolean };
    expect(view.additionalProperties).toBe(false);
  });

  test("promote op requires ref, knowledgeRef, reason; description is optional", () => {
    const v = variant("promote");
    expect(v.required).toContain("ref");
    expect(v.required).toContain("knowledgeRef");
    expect(v.required).toContain("reason");
    expect(v.required).not.toContain("description");
    // description is still typed when present.
    const desc = v.properties.description as { type?: string };
    expect(desc.type).toBe("string");
  });

  test("contradict op requires ref, contradictedByRef, and reason", () => {
    const v = variant("contradict");
    expect(v.required).toContain("ref");
    expect(v.required).toContain("contradictedByRef");
    expect(v.required).toContain("reason");
  });

  test("every operation variant has additionalProperties: false to block field smuggling", () => {
    const s = CONSOLIDATE_PLAN_JSON_SCHEMA as unknown as SchemaView;
    for (const v of s.properties.operations.items.oneOf) {
      const view = v as unknown as { additionalProperties: boolean };
      expect(view.additionalProperties).toBe(false);
    }
  });
});

describe("CONSOLIDATE_PLAN_JSON_SCHEMA — typed-shape acceptance", () => {
  test("a well-formed plan with merge + delete ops matches the schema's required-key contract", () => {
    // We do not have a JSON-schema validator in tree; verify the typed contract
    // by confirming a sample payload has every required key the schema names.
    const sample = {
      operations: [
        {
          op: "merge",
          primary: "memory:auth-tips",
          secondaries: ["memory:auth-helpers"],
          mergeStrategy: "synthesize",
        },
        {
          op: "delete",
          ref: "memory:outdated",
          reason: "Superseded by knowledge:deploy.",
        },
      ],
    };
    const s = CONSOLIDATE_PLAN_JSON_SCHEMA as unknown as SchemaView;
    expect(s.required.every((k) => k in sample)).toBe(true);

    const mergeVariant = s.properties.operations.items.oneOf.find((v) => {
      const opProp = v.properties.op as { enum?: string[] };
      return opProp.enum?.includes("merge");
    });
    expect(mergeVariant?.required.every((k) => k in sample.operations[0])).toBe(true);

    const deleteVariant = s.properties.operations.items.oneOf.find((v) => {
      const opProp = v.properties.op as { enum?: string[] };
      return opProp.enum?.includes("delete");
    });
    expect(deleteVariant?.required.every((k) => k in sample.operations[1])).toBe(true);
  });

  test("a payload missing the required `primary` field for a merge op fails the required-key check", () => {
    const broken = { operations: [{ op: "merge", secondaries: ["memory:foo"], mergeStrategy: "synthesize" }] };
    const s = CONSOLIDATE_PLAN_JSON_SCHEMA as unknown as SchemaView;
    const mergeVariant = s.properties.operations.items.oneOf.find((v) => {
      const opProp = v.properties.op as { enum?: string[] };
      return opProp.enum?.includes("merge");
    });
    expect(mergeVariant?.required.every((k) => k in broken.operations[0])).toBe(false);
  });
});
