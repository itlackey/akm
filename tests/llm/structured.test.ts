/**
 * Tests for the structured loop: dispatch, parse, and one corrective dispatch
 * that carries what the parser refused.
 *
 * Covered:
 *   • A reply the parser accepts comes back at once, with no correction asked for.
 *   • A refused reply is corrected once, and the correction names what was wrong.
 *   • A reply still refused after the last attempt is a typed failure, never a throw.
 *   • One attempt means a command is never run twice to fix its output.
 *   • A dispatch that fails ends the loop with that failure, unchanged and uncorrected.
 *   • The JSON parser tolerates fenced and prose-wrapped replies.
 */
import { describe, expect, test } from "bun:test";
import type { Parsed } from "../../src/core/structured";
import { type Correction, isRefused, jsonParser, structuredLoop } from "../../src/llm/structured";

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

/** A dispatch that produced `raw`. */
const reply = (raw: string) => ({ ok: true, raw }) as const;

describe("structuredLoop", () => {
  test("a reply the parser accepts comes back at once, with no correction", async () => {
    const corrections: (Correction | undefined)[] = [];
    const result = await structuredLoop({
      dispatch: async (correction) => {
        corrections.push(correction);
        return reply('{"file":"a.ts","summary":"ok"}');
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
        return reply(replies.shift() ?? "");
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
        return reply(replies.shift() ?? "");
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
        return reply('{"file": 42}');
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
        return reply("nope");
      },
      parse,
      attempts: 1,
    });
    expect(calls).toBe(1);
    expect(result).toMatchObject({ ok: false, reason: "parse_error", attempts: 1 });
  });

  test("a dispatch that fails ends the loop with that failure, as the dispatch reported it", async () => {
    const failure = { ok: false, reason: "timeout", error: "Request timed out after 50ms" } as const;
    const first = await structuredLoop({ dispatch: async () => failure, parse });
    expect(first).toEqual({ ...failure, attempts: 1 });
    expect(isRefused(first)).toBe(false);

    // A failure on the corrective dispatch is passed through the same way, not retried.
    let calls = 0;
    const second = await structuredLoop<Finding>({
      dispatch: async (correction) => {
        calls += 1;
        return correction ? failure : reply("prose");
      },
      parse,
    });
    expect(second).toEqual({ ...failure, attempts: 2 });
    expect(calls).toBe(2);
  });

  test("a caller's own failure shape passes through, so a workflow unit keeps its reasons", async () => {
    const result = await structuredLoop<Finding, { failureReason: string; error: string }>({
      dispatch: async () => ({ ok: false, failureReason: "dispatch_error", error: "boom" }),
      parse,
    });
    expect(result).toEqual({ ok: false, failureReason: "dispatch_error", error: "boom", attempts: 1 });
  });

  test("a refused reply and a failed dispatch are told apart", async () => {
    const refused = await structuredLoop({ dispatch: async () => reply("prose"), parse, attempts: 1 });
    expect(isRefused(refused)).toBe(true);
  });

  test("the jsonParser tolerates fenced and prose-wrapped JSON", async () => {
    const result = await structuredLoop({
      dispatch: async () => reply('Here you go:\n```json\n{"file":"d.ts","summary":"fenced"}\n```\nHope that helps!'),
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
        return reply(replies.shift() ?? "");
      },
      parse,
      correct: (refusal) => `CUSTOM:${refusal.reason}:${refusal.errors.join("|")}`,
    });
    expect(corrections[1]?.text).toBe("CUSTOM:parse_error:no JSON structure found in response");
  });
});
