/**
 * Tests for the structured loop: dispatch, parse, and one corrective dispatch
 * that carries what the parser refused.
 *
 * Covered:
 *   • A reply the parser accepts comes back at once, with no correction asked for.
 *   • A refused reply is corrected once, and the correction names what was wrong.
 *   • A reply still refused after the last attempt is a typed failure, never a throw.
 *   • One attempt means a command is never run twice to fix its output.
 *   • A dispatch that fails is not retried by the loop.
 *   • The JSON parser tolerates fenced and prose-wrapped replies.
 */
import { describe, expect, test } from "bun:test";
import type { Parsed } from "../../src/core/structured";
import { type Correction, jsonParser, structuredLoop } from "../../src/llm/structured";

interface Finding {
  file: string;
  summary: string;
}

function validateFinding(candidate: unknown): Parsed<Finding> {
  if (typeof candidate !== "object" || candidate === null) {
    return { ok: false, errors: ["expected an object"], reason: "validation_error" };
  }
  const record = candidate as Record<string, unknown>;
  const errors: string[] = [];
  if (typeof record.file !== "string") errors.push("file: expected string");
  if (typeof record.summary !== "string") errors.push("summary: expected string");
  if (errors.length > 0) return { ok: false, errors, reason: "validation_error" };
  return { ok: true, value: { file: record.file as string, summary: record.summary as string } };
}

const parse = jsonParser(validateFinding);

describe("structuredLoop", () => {
  test("a reply the parser accepts comes back at once, with no correction", async () => {
    const corrections: (Correction | undefined)[] = [];
    const result = await structuredLoop({
      dispatch: async (correction) => {
        corrections.push(correction);
        return '{"file":"a.ts","summary":"ok"}';
      },
      parse,
    });
    expect(result).toEqual({
      ok: true,
      value: { file: "a.ts", summary: "ok" },
      raw: '{"file":"a.ts","summary":"ok"}',
      attempts: 1,
    });
    expect(corrections).toEqual([undefined]);
  });

  test("a reply with no JSON in it is corrected once, and the correction says so", async () => {
    const corrections: (Correction | undefined)[] = [];
    const replies = ["total prose, no json here", '{"file":"b.ts","summary":"fixed"}'];
    const result = await structuredLoop({
      dispatch: async (correction) => {
        corrections.push(correction);
        return replies.shift() ?? "";
      },
      parse,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.attempts).toBe(2);
    expect(corrections[1]?.text).toContain("no parseable JSON");
    expect(corrections[1]?.reply).toBe("total prose, no json here");
  });

  test("a reply that fails validation is corrected with the validator's errors", async () => {
    const corrections: (Correction | undefined)[] = [];
    const replies = ['{"file":123}', '{"file":"c.ts","summary":"now valid"}'];
    const result = await structuredLoop({
      dispatch: async (correction) => {
        corrections.push(correction);
        return replies.shift() ?? "";
      },
      parse,
    });
    expect(result.ok).toBe(true);
    expect(corrections[1]?.text).toContain("failed validation");
    expect(corrections[1]?.text).toContain("file: expected string");
    expect(corrections[1]?.text).toContain("summary: expected string");
  });

  test("a reply still refused after the last attempt is the final attempt's typed failure", async () => {
    let calls = 0;
    const result = await structuredLoop({
      dispatch: async () => {
        calls += 1;
        return '{"file": 42}';
      },
      parse,
      attempts: 3,
    });
    expect(calls).toBe(3);
    expect(result).toMatchObject({ ok: false, reason: "validation_error", attempts: 3, raw: '{"file": 42}' });
  });

  test("one attempt dispatches once: nothing is run twice to fix its output", async () => {
    let calls = 0;
    const result = await structuredLoop({
      dispatch: async () => {
        calls += 1;
        return "nope";
      },
      parse,
      attempts: 1,
    });
    expect(calls).toBe(1);
    expect(result).toMatchObject({ ok: false, reason: "parse_error", attempts: 1 });
  });

  test("a dispatch that fails ends the loop with its error: the loop owns only the reply's shape", async () => {
    await expect(
      structuredLoop({
        dispatch: async () => {
          throw new Error("connection refused");
        },
        parse,
      }),
    ).rejects.toThrow("connection refused");

    let calls = 0;
    await expect(
      structuredLoop({
        dispatch: async (correction) => {
          calls += 1;
          if (correction) throw new Error("connection dropped on the retry");
          return "prose";
        },
        parse,
      }),
    ).rejects.toThrow("connection dropped on the retry");
    expect(calls).toBe(2);
  });

  test("the jsonParser tolerates fenced and prose-wrapped JSON", async () => {
    const result = await structuredLoop({
      dispatch: async () => 'Here you go:\n```json\n{"file":"d.ts","summary":"fenced"}\n```\nHope that helps!',
      parse,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.file).toBe("d.ts");
  });

  test("a caller's own correction text replaces the default", async () => {
    const corrections: (Correction | undefined)[] = [];
    const replies = ["prose", '{"file":"e.ts","summary":"ok"}'];
    await structuredLoop({
      dispatch: async (correction) => {
        corrections.push(correction);
        return replies.shift() ?? "";
      },
      parse,
      correct: (refusal) => `CUSTOM:${refusal.reason}:${refusal.errors.join("|")}`,
    });
    expect(corrections[1]?.text).toBe("CUSTOM:parse_error:no JSON structure found in response");
  });
});
