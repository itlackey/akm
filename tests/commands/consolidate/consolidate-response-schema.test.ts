/**
 * Tests for the structured-output (`responseSchema`) lift in `akm consolidate`.
 *
 * Asset-writers-investigation PR 1: the chunk-plan LLM call passes the
 * CONSOLIDATE_PLAN_JSON_SCHEMA so providers that honour
 * `response_format: json_schema` enforce the `{operations}` shape upstream.
 * The chunk-level "invalid plan from AI — skipping" branch in `runConsolidate`
 * becomes unreachable for schema-honouring providers.
 *
 * R12a (promote-only): `merge`/`delete`/`contradict` were advisory-only — the
 * apply loop only ever executed `promote` — and cost 21-30k completion tokens
 * per run for output nothing acted on. The schema, the system prompt, and the
 * `{operations}` top-level `warnings` array were all cut down to promote-only.
 *
 * These are schema-shape unit tests; the end-to-end LLM call site is exercised
 * by the existing `consolidate-chunks` / `consolidate-pipeline-fixes` tests.
 */

import { describe, expect, test } from "bun:test";

import consolidateSystemPrompt from "../../../src/assets/prompts/consolidate-system.md" with { type: "text" };
import { CONSOLIDATE_PLAN_JSON_SCHEMA } from "../../../src/commands/improve/consolidate";
import { isValidOp } from "../../../src/commands/improve/consolidate/merge";

// Internal-shape view of the schema for assertion convenience.
interface SchemaView {
  type: string;
  required: string[];
  additionalProperties: boolean;
  properties: {
    operations: {
      type: string;
      items: {
        type: string;
        required: string[];
        additionalProperties: boolean;
        properties: Record<string, unknown>;
      };
    };
    warnings?: unknown;
  };
}

describe("CONSOLIDATE_PLAN_JSON_SCHEMA — top-level shape", () => {
  test("requires operations array; no top-level warnings property", () => {
    const s = CONSOLIDATE_PLAN_JSON_SCHEMA as unknown as SchemaView;
    expect(s.type).toBe("object");
    expect(s.required).toContain("operations");
    expect(s.properties.warnings).toBeUndefined();
  });

  test("forbids additionalProperties at the top level", () => {
    const s = CONSOLIDATE_PLAN_JSON_SCHEMA as unknown as SchemaView;
    expect(s.additionalProperties).toBe(false);
  });

  test("operations items are a single promote-shaped object — no oneOf, no merge/delete/contradict", () => {
    const s = CONSOLIDATE_PLAN_JSON_SCHEMA as unknown as SchemaView;
    expect(s.properties.operations.type).toBe("array");
    const items = s.properties.operations.items;
    expect(items).not.toHaveProperty("oneOf");
    expect(items.type).toBe("object");
    const opEnum = (items.properties.op as { enum?: string[] } | undefined)?.enum;
    expect(opEnum).toEqual(["promote"]);
  });
});

describe("CONSOLIDATE_PLAN_JSON_SCHEMA — promote op shape", () => {
  test("requires ref, knowledgeRef, reason; description is optional", () => {
    const s = CONSOLIDATE_PLAN_JSON_SCHEMA as unknown as SchemaView;
    const v = s.properties.operations.items;
    expect(v.required).toContain("ref");
    expect(v.required).toContain("knowledgeRef");
    expect(v.required).toContain("reason");
    expect(v.required).not.toContain("description");
    const desc = v.properties.description as { type?: string };
    expect(desc.type).toBe("string");
  });

  test("caps reason at 200 chars", () => {
    const s = CONSOLIDATE_PLAN_JSON_SCHEMA as unknown as SchemaView;
    const reason = s.properties.operations.items.properties.reason as { maxLength?: number };
    expect(reason.maxLength).toBe(200);
  });

  test("additionalProperties: false blocks field smuggling", () => {
    const s = CONSOLIDATE_PLAN_JSON_SCHEMA as unknown as SchemaView;
    expect(s.properties.operations.items.additionalProperties).toBe(false);
  });

  test("a well-formed promote op has every required key", () => {
    const sample = {
      op: "promote",
      ref: "memories/auth-tips",
      knowledgeRef: "knowledge/auth-tips",
      reason: "Stable, reusable guidance.",
    };
    const s = CONSOLIDATE_PLAN_JSON_SCHEMA as unknown as SchemaView;
    expect(s.properties.operations.items.required.every((k) => k in sample)).toBe(true);
  });

  test("a payload missing the required `knowledgeRef` field fails the required-key check", () => {
    const broken = { op: "promote", ref: "memories/auth-tips", reason: "Stable, reusable guidance." };
    const s = CONSOLIDATE_PLAN_JSON_SCHEMA as unknown as SchemaView;
    expect(s.properties.operations.items.required.every((k) => k in broken)).toBe(false);
  });
});

describe("consolidate-system.md — promote-only prompt (R12a)", () => {
  test("no longer offers the merge, delete, or contradict ops as rules or JSON examples", () => {
    expect(consolidateSystemPrompt).not.toMatch(/^\d+\.\s*MERGE:/m);
    expect(consolidateSystemPrompt).not.toMatch(/^\d+\.\s*DELETE:/m);
    expect(consolidateSystemPrompt).not.toMatch(/^\d+\.\s*CONTRADICT:/m);
    expect(consolidateSystemPrompt).not.toContain('"op": "merge"');
    expect(consolidateSystemPrompt).not.toContain('"op": "delete"');
    expect(consolidateSystemPrompt).not.toContain('"op": "contradict"');
  });

  test("still documents PROMOTE and KEEP", () => {
    expect(consolidateSystemPrompt).toContain("PROMOTE");
    expect(consolidateSystemPrompt).toContain("KEEP");
  });

  test("the JSON example carries no top-level warnings array", () => {
    expect(consolidateSystemPrompt).not.toContain('"warnings"');
  });
});

describe("isValidOp — rejects retired advisory op shapes (R12a)", () => {
  test("accepts a well-formed promote op", () => {
    expect(
      isValidOp({
        op: "promote",
        ref: "memories/foo",
        knowledgeRef: "knowledge/foo",
        reason: "stable fact",
      }),
    ).toBe(true);
  });

  test("rejects a merge op from an old model response instead of throwing", () => {
    expect(() =>
      isValidOp({
        op: "merge",
        primary: "memories/foo",
        secondaries: ["memories/bar"],
        mergeStrategy: "synthesize",
      }),
    ).not.toThrow();
    expect(
      isValidOp({
        op: "merge",
        primary: "memories/foo",
        secondaries: ["memories/bar"],
        mergeStrategy: "synthesize",
      }),
    ).toBe(false);
  });

  test("rejects a delete op from an old model response instead of throwing", () => {
    expect(() => isValidOp({ op: "delete", ref: "memories/foo", reason: "stale" })).not.toThrow();
    expect(isValidOp({ op: "delete", ref: "memories/foo", reason: "stale" })).toBe(false);
  });

  test("rejects a contradict op from an old model response instead of throwing", () => {
    expect(() =>
      isValidOp({ op: "contradict", ref: "memories/foo", contradictedByRef: "memories/bar", reason: "conflict" }),
    ).not.toThrow();
    expect(
      isValidOp({ op: "contradict", ref: "memories/foo", contradictedByRef: "memories/bar", reason: "conflict" }),
    ).toBe(false);
  });
});
