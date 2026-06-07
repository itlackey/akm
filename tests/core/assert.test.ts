/**
 * Tests for src/core/assert.ts — the exhaustiveness keystone.
 *
 * Verifies the runtime behaviour of `assertNever`: it always throws and the
 * thrown message includes a serialization of the offending value (and any
 * optional context label) for diagnostics. The compile-time exhaustiveness
 * benefit is exercised by the consuming switch refactors, not here.
 */

import { describe, expect, test } from "bun:test";

import { assertNever } from "../../src/core/assert";

describe("assertNever", () => {
  test("throws including the JSON of the unexpected value", () => {
    expect(() => assertNever("oops" as never)).toThrow(/assertNever.*"oops"/);
  });

  test("serializes object values via JSON", () => {
    expect(() => assertNever({ mode: "surprise" } as never)).toThrow(/\{"mode":"surprise"\}/);
  });

  test("includes the optional context label", () => {
    expect(() => assertNever("x" as never, "improve.classify")).toThrow(/\(improve\.classify\)/);
  });

  test("falls back to String() for non-JSON-serializable values", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => assertNever(circular as never)).toThrow(/assertNever/);
  });

  test("handles undefined without producing a literal 'undefined' string gap", () => {
    expect(() => assertNever(undefined as never)).toThrow(/undefined/);
  });
});
