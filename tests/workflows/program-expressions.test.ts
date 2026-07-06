// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import {
  type ExpressionAst,
  type ExpressionScope,
  formatReference,
  listReferences,
  parseExpression,
  parseTemplate,
  resolveReference,
  resolveTemplate,
  type TemplateSegment,
} from "../../src/workflows/program/expressions";

/**
 * R1 — the deterministic expression language. `${{ … }}` references are
 * parsed once into an AST; resolution is a single pass with no re-scanning,
 * so substituted content can never inject further directives.
 */

function segmentsOf(template: string): TemplateSegment[] {
  const result = parseTemplate(template);
  if (!result.ok) {
    throw new Error(`expected parse success, got: ${result.errors.map((e) => `${e.index}:${e.message}`).join(" | ")}`);
  }
  return result.segments;
}

function errorsOf(template: string): Array<{ index: number; message: string }> {
  const result = parseTemplate(template);
  if (result.ok) throw new Error(`expected parse failure for ${JSON.stringify(template)}`);
  return result.errors;
}

function refs(template: string): ExpressionAst[] {
  return listReferences(segmentsOf(template));
}

// ── parseTemplate: literals ──────────────────────────────────────────────────

describe("parseTemplate literals", () => {
  test("plain text is a single byte-exact literal", () => {
    const segments = segmentsOf("hello world");
    expect(segments).toEqual([{ kind: "literal", text: "hello world" }]);
  });

  test("empty template parses to zero segments", () => {
    expect(segmentsOf("")).toEqual([]);
  });

  test("hostile characters that do not form the exact ${{ opener pass through byte-exact", () => {
    const hostile = "$& ${ x } }} { } $ {{ y }} ${x} $}} {{}}";
    expect(segmentsOf(hostile)).toEqual([{ kind: "literal", text: hostile }]);
  });

  test("unicode literals are byte-exact", () => {
    const text = "héllo 🎉 — 日本語 ​ ${ not-a-ref }";
    expect(segmentsOf(text)).toEqual([{ kind: "literal", text }]);
  });

  test("a lone $ before an opener stays literal", () => {
    const segments = segmentsOf("$${{ params.x }}");
    expect(segments[0]).toEqual({ kind: "literal", text: "$" });
    expect(segments[1]).toMatchObject({ kind: "reference", expr: { kind: "param", name: "x" } });
  });

  test("trailing }} after a closed reference is literal", () => {
    const segments = segmentsOf("${{ item }} }}");
    expect(segments).toHaveLength(2);
    expect(segments[1]).toEqual({ kind: "literal", text: " }}" });
  });
});

// ── parseTemplate: references (every AST kind) ───────────────────────────────

describe("parseTemplate references", () => {
  test("params reference", () => {
    expect(refs("${{ params.changed_files }}")).toEqual([{ kind: "param", name: "changed_files" }]);
  });

  test("param names allow hyphens, underscores, digits after the first char", () => {
    expect(refs("${{ params.my-param_2 }}")).toEqual([{ kind: "param", name: "my-param_2" }]);
  });

  test("item and item_index references", () => {
    expect(refs("${{ item }}")).toEqual([{ kind: "item" }]);
    expect(refs("${{ item_index }}")).toEqual([{ kind: "itemIndex" }]);
  });

  test("bare step output has an empty path", () => {
    expect(refs("${{ steps.discover.output }}")).toEqual([{ kind: "stepOutput", stepId: "discover", path: [] }]);
  });

  test("deep path with dot idents and indexers", () => {
    expect(refs("${{ steps.review.output.files[0].name }}")).toEqual([
      { kind: "stepOutput", stepId: "review", path: ["files", 0, "name"] },
    ]);
  });

  test("chained indexers directly on output", () => {
    expect(refs("${{ steps.s.output[0][12] }}")).toEqual([{ kind: "stepOutput", stepId: "s", path: [0, 12] }]);
  });

  test("whitespace inside the delimiters is tolerated; none required", () => {
    expect(refs("${{   item   }}")).toEqual([{ kind: "item" }]);
    expect(refs("${{params.x}}")).toEqual([{ kind: "param", name: "x" }]);
  });

  test("adjacent references produce no phantom literal", () => {
    const segments = segmentsOf("${{ params.a }}${{ params.b }}");
    expect(segments).toHaveLength(2);
    expect(segments.every((s) => s.kind === "reference")).toBe(true);
  });

  test("reference segments record raw source text and opener index", () => {
    const segments = segmentsOf("ab ${{ params.x }} cd");
    const ref = segments[1];
    if (ref.kind !== "reference") throw new Error("expected reference");
    expect(ref.raw).toBe("${{ params.x }}");
    expect(ref.index).toBe(3);
  });
});

// ── parseTemplate: errors ────────────────────────────────────────────────────

describe("parseTemplate errors", () => {
  test("unterminated reference", () => {
    const errors = errorsOf("hi ${{ params.x");
    expect(errors).toHaveLength(1);
    expect(errors[0].index).toBe(3);
    expect(errors[0].message).toContain("nterminated");
  });

  test("nested opener inside a reference", () => {
    const errors = errorsOf("${{ params.${{ item }} }}");
    expect(errors).toHaveLength(1);
    expect(errors[0].index).toBe(11);
    expect(errors[0].message.toLowerCase()).toContain("nested");
  });

  test("unknown roots", () => {
    expect(errorsOf("${{ env.HOME }}")[0].message).toContain("env");
    expect(errorsOf("${{ secrets.token }}")[0].message).toContain("secrets");
    expect(errorsOf("${{ params2.x }}")[0].message).toContain("params2");
  });

  test("empty expression", () => {
    expect(errorsOf("${{}}")).toHaveLength(1);
    expect(errorsOf("${{   }}")).toHaveLength(1);
  });

  test("params without a name, with a trailing dot, or with extra path", () => {
    expect(errorsOf("${{ params }}")).toHaveLength(1);
    expect(errorsOf("${{ params. }}")).toHaveLength(1);
    expect(errorsOf("${{ params.a.b }}")).toHaveLength(1);
    expect(errorsOf("${{ params.a[0] }}")).toHaveLength(1);
  });

  test("invalid identifiers", () => {
    expect(errorsOf("${{ params.9lives }}")).toHaveLength(1);
    expect(errorsOf("${{ params.-x }}")).toHaveLength(1);
    expect(errorsOf("${{ 0abc }}")).toHaveLength(1);
  });

  test("steps references must go through .output", () => {
    expect(errorsOf("${{ steps }}")).toHaveLength(1);
    expect(errorsOf("${{ steps.x }}")).toHaveLength(1);
    expect(errorsOf("${{ steps.x.result }}")).toHaveLength(1);
    expect(errorsOf("${{ steps.x[0] }}")).toHaveLength(1);
  });

  test("malformed step output paths", () => {
    expect(errorsOf("${{ steps.x.output. }}")).toHaveLength(1);
    expect(errorsOf("${{ steps.x.output[] }}")).toHaveLength(1);
    expect(errorsOf("${{ steps.x.output[-1] }}")).toHaveLength(1);
    expect(errorsOf("${{ steps.x.output[1.5] }}")).toHaveLength(1);
    expect(errorsOf("${{ steps.x.output[abc] }}")).toHaveLength(1);
    expect(errorsOf("${{ steps.x.output[0 }}")).toHaveLength(1);
  });

  test("item and item_index take no path", () => {
    expect(errorsOf("${{ item.foo }}")).toHaveLength(1);
    expect(errorsOf("${{ item[0] }}")).toHaveLength(1);
    expect(errorsOf("${{ item_index.x }}")).toHaveLength(1);
    expect(errorsOf("${{ item index }}")).toHaveLength(1);
  });

  test("multiple errors are all collected with ascending indexes", () => {
    const errors = errorsOf("${{ nope }} and ${{ params }}");
    expect(errors).toHaveLength(2);
    expect(errors[0].index).toBe(0);
    expect(errors[1].index).toBe(16);
  });
});

// ── parseExpression (single-expression contexts) ─────────────────────────────

describe("parseExpression", () => {
  test("parses a bare expression without delimiters", () => {
    const result = parseExpression("steps.discover.output.files");
    expect(result).toEqual({ ok: true, expr: { kind: "stepOutput", stepId: "discover", path: ["files"] } });
  });

  test("rejects garbage with a message, not a throw", () => {
    const result = parseExpression("Math.random()");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message.length).toBeGreaterThan(0);
  });
});

// ── resolveTemplate ──────────────────────────────────────────────────────────

const EMPTY_SCOPE: ExpressionScope = { params: {}, stepOutputs: {} };

function scope(partial: Partial<ExpressionScope>): ExpressionScope {
  return { params: {}, stepOutputs: {}, ...partial };
}

function resolvedText(template: string, s: ExpressionScope): string {
  const result = resolveTemplate(segmentsOf(template), s);
  if (!result.ok) {
    throw new Error(`expected resolution success: ${result.errors.map((e) => e.message).join(" | ")}`);
  }
  return result.text;
}

function resolutionErrors(template: string, s: ExpressionScope) {
  const result = resolveTemplate(segmentsOf(template), s);
  if (result.ok) throw new Error("expected resolution failure");
  return result.errors;
}

describe("resolveTemplate", () => {
  test("strings insert verbatim", () => {
    expect(resolvedText("Review ${{ params.file }} now", scope({ params: { file: "a b.ts" } }))).toBe(
      "Review a b.ts now",
    );
  });

  test("single pass: a param value containing ${{ ... }} stays literal", () => {
    const s = scope({ params: { x: "injected ${{ params.y }} text" } });
    expect(resolvedText("A ${{ params.x }} B", s)).toBe("A injected ${{ params.y }} text B");
  });

  test("single pass: an item value containing ${{ params.x }} stays literal and is never re-scanned", () => {
    const s = scope({ item: "${{ params.x }}", itemIndex: 0 });
    // params.x does not even exist — if the engine re-scanned, this would error.
    expect(resolvedText("Process ${{ item }} at ${{ item_index }}", s)).toBe("Process ${{ params.x }} at 0");
  });

  test("hostile replacement-pattern characters insert byte-exact", () => {
    const s = scope({ params: { x: "$& $' $` $1 $<name>" } });
    expect(resolvedText("[${{ params.x }}]", s)).toBe("[$& $' $` $1 $<name>]");
  });

  test("numbers and booleans stringify; zero and false are not treated as missing", () => {
    const s = scope({ params: { n: 0, b: false } });
    expect(resolvedText("${{ params.n }}/${{ params.b }}", s)).toBe("0/false");
  });

  test("item_index of 0 resolves", () => {
    expect(resolvedText("#${{ item_index }}", scope({ item: "a", itemIndex: 0 }))).toBe("#0");
  });

  test("objects insert as canonical JSON with recursively sorted keys", () => {
    const s = scope({ params: { cfg: { b: 1, a: { d: 4, c: [2, { z: 1, y: 0 }] } } } });
    expect(resolvedText("${{ params.cfg }}", s)).toBe('{"a":{"c":[2,{"y":0,"z":1}],"d":4},"b":1}');
  });

  test("arrays insert as JSON", () => {
    const s = scope({ stepOutputs: { d: { files: ["a.ts", "b.ts"] } } });
    expect(resolvedText("${{ steps.d.output.files }}", s)).toBe('["a.ts","b.ts"]');
  });

  test("deep path resolution through objects and arrays", () => {
    const s = scope({ stepOutputs: { review: { files: [{ name: "x.ts" }, { name: "y.ts" }] } } });
    expect(resolvedText("${{ steps.review.output.files[1].name }}", s)).toBe("y.ts");
  });

  test("missing param is a resolution error naming the path", () => {
    const errors = resolutionErrors("${{ params.ghost }}", EMPTY_SCOPE);
    expect(errors).toHaveLength(1);
    expect(errors[0].reference).toBe("params.ghost");
    expect(errors[0].message).toContain("params.ghost");
  });

  test("null and undefined values are resolution errors", () => {
    const s = scope({ params: { a: null, b: undefined } });
    expect(resolutionErrors("${{ params.a }}", s)[0].message).toContain("null");
    expect(resolutionErrors("${{ params.b }}", s)).toHaveLength(1);
  });

  test("missing step output is an error naming the step", () => {
    const errors = resolutionErrors("${{ steps.ghost.output }}", EMPTY_SCOPE);
    expect(errors[0].message).toContain("ghost");
  });

  test("missing deep path names the full failing path", () => {
    const s = scope({ stepOutputs: { review: { files: ["only-one"] } } });
    const errors = resolutionErrors("${{ steps.review.output.files[5] }}", s);
    expect(errors[0].message).toContain("steps.review.output.files");
    expect(errors[0].message).toContain("5");
  });

  test("descending into a non-object is an error", () => {
    const s = scope({ stepOutputs: { d: { n: 42 } } });
    expect(resolutionErrors("${{ steps.d.output.n.deeper }}", s)[0].message).toContain("steps.d.output.n");
  });

  test("item and item_index outside a fan-out are errors", () => {
    expect(resolutionErrors("${{ item }}", EMPTY_SCOPE)[0].reference).toBe("item");
    expect(resolutionErrors("${{ item_index }}", EMPTY_SCOPE)[0].reference).toBe("item_index");
  });

  test("all resolution errors are collected, not just the first", () => {
    const errors = resolutionErrors("${{ params.a }} ${{ params.b }}", EMPTY_SCOPE);
    expect(errors).toHaveLength(2);
  });
});

// ── resolveReference (whole-value contexts) ──────────────────────────────────

describe("resolveReference", () => {
  test("arrays stay arrays (raw value, same identity)", () => {
    const files = ["a.ts", "b.ts"];
    const [expr] = refs("${{ steps.d.output.files }}");
    const result = resolveReference(expr, scope({ stepOutputs: { d: { files } } }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(files);
  });

  test("objects come back raw, not canonicalized", () => {
    const value = { b: 1, a: 2 };
    const [expr] = refs("${{ steps.d.output }}");
    const result = resolveReference(expr, scope({ stepOutputs: { d: value } }));
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value).toBe(value);
  });

  test("scalars and item resolve raw", () => {
    const [itemExpr] = refs("${{ item }}");
    const itemResult = resolveReference(itemExpr, scope({ item: { file: "x.ts" }, itemIndex: 3 }));
    if (!itemResult.ok) throw new Error(itemResult.error.message);
    expect(itemResult.value).toEqual({ file: "x.ts" });

    const [idxExpr] = refs("${{ item_index }}");
    const idxResult = resolveReference(idxExpr, scope({ item: "x", itemIndex: 3 }));
    if (!idxResult.ok) throw new Error(idxResult.error.message);
    expect(idxResult.value).toBe(3);
  });

  test("null value and missing path follow the same error discipline", () => {
    const [expr] = refs("${{ steps.d.output.value }}");
    const nullResult = resolveReference(expr, scope({ stepOutputs: { d: { value: null } } }));
    expect(nullResult.ok).toBe(false);
    if (!nullResult.ok) expect(nullResult.error.message).toContain("null");

    const missingResult = resolveReference(expr, scope({ stepOutputs: { d: {} } }));
    expect(missingResult.ok).toBe(false);
    if (!missingResult.ok) expect(missingResult.error.reference).toBe("steps.d.output.value");
  });
});

// ── listReferences + formatReference ─────────────────────────────────────────

describe("listReferences", () => {
  test("returns reference ASTs in document order, skipping literals", () => {
    const template = "a ${{ params.p }} b ${{ steps.s.output.x[2] }} c ${{ item }}";
    expect(refs(template)).toEqual([
      { kind: "param", name: "p" },
      { kind: "stepOutput", stepId: "s", path: ["x", 2] },
      { kind: "item" },
    ]);
  });

  test("pure literal template lists no references", () => {
    expect(refs("nothing here")).toEqual([]);
  });
});

describe("formatReference", () => {
  test("round-trips the canonical spelling of each AST kind", () => {
    expect(formatReference({ kind: "param", name: "x" })).toBe("params.x");
    expect(formatReference({ kind: "stepOutput", stepId: "s", path: ["files", 0, "name"] })).toBe(
      "steps.s.output.files[0].name",
    );
    expect(formatReference({ kind: "stepOutput", stepId: "s", path: [] })).toBe("steps.s.output");
    expect(formatReference({ kind: "item" })).toBe("item");
    expect(formatReference({ kind: "itemIndex" })).toBe("item_index");
  });
});
