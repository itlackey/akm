/**
 * Tests for `runStructured` — the transport-free structured-output core
 * (P0.5 seam for the workflow engine's schema units).
 *
 * Covered:
 *   • First-attempt success (no retry, no feedback).
 *   • Parse miss → corrective feedback → success on retry.
 *   • Validation miss → validator errors surface in the feedback.
 *   • Exhausted attempts return a typed failure (never throws).
 *   • Transport errors propagate untouched (transports own their retries).
 *   • Default parser tolerates fenced/prose-wrapped JSON.
 */
import { describe, expect, test } from "bun:test";
import { runStructured, type StructuredValidation } from "../../src/core/structured";

interface Finding {
  file: string;
  summary: string;
}

function validateFinding(candidate: unknown): StructuredValidation<Finding> {
  if (typeof candidate !== "object" || candidate === null) {
    return { ok: false, errors: ["expected an object"] };
  }
  const record = candidate as Record<string, unknown>;
  const errors: string[] = [];
  if (typeof record.file !== "string") errors.push("file: expected string");
  if (typeof record.summary !== "string") errors.push("summary: expected string");
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: { file: record.file as string, summary: record.summary as string } };
}

describe("runStructured", () => {
  test("first-attempt success passes no feedback and reports attempts: 1", async () => {
    const feedbacks: (string | undefined)[] = [];
    const result = await runStructured({
      dispatch: async (feedback) => {
        feedbacks.push(feedback);
        return '{"file":"a.ts","summary":"ok"}';
      },
      validate: validateFinding,
    });
    expect(result).toEqual({ ok: true, value: { file: "a.ts", summary: "ok" }, attempts: 1 });
    expect(feedbacks).toEqual([undefined]);
  });

  test("parse miss retries with corrective feedback and succeeds", async () => {
    const feedbacks: (string | undefined)[] = [];
    const responses = ["total prose, no json here", '{"file":"b.ts","summary":"fixed"}'];
    const result = await runStructured({
      dispatch: async (feedback) => {
        feedbacks.push(feedback);
        return responses.shift() ?? "";
      },
      validate: validateFinding,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.attempts).toBe(2);
    expect(feedbacks[1]).toContain("no parseable JSON");
  });

  test("validation miss feeds the validator's errors back to the transport", async () => {
    const feedbacks: (string | undefined)[] = [];
    const responses = ['{"file":123}', '{"file":"c.ts","summary":"now valid"}'];
    const result = await runStructured({
      dispatch: async (feedback) => {
        feedbacks.push(feedback);
        return responses.shift() ?? "";
      },
      validate: validateFinding,
    });
    expect(result.ok).toBe(true);
    expect(feedbacks[1]).toContain("file: expected string");
    expect(feedbacks[1]).toContain("summary: expected string");
  });

  test("exhausted attempts return the FINAL attempt's typed failure", async () => {
    let calls = 0;
    const result = await runStructured({
      dispatch: async () => {
        calls++;
        return '{"file": 42}';
      },
      validate: validateFinding,
      maxAttempts: 3,
    });
    expect(calls).toBe(3);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("validation_error");
      expect(result.attempts).toBe(3);
      expect(result.raw).toBe('{"file": 42}');
    }
  });

  test("maxAttempts: 1 disables retry entirely", async () => {
    let calls = 0;
    const result = await runStructured({
      dispatch: async () => {
        calls++;
        return "nope";
      },
      validate: validateFinding,
      maxAttempts: 1,
    });
    expect(calls).toBe(1);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("parse_error");
  });

  test("transport errors propagate — runStructured owns only structure retries", async () => {
    await expect(
      runStructured({
        dispatch: async () => {
          throw new Error("connection refused");
        },
        validate: validateFinding,
      }),
    ).rejects.toThrow("connection refused");
  });

  test("default parser handles fenced and prose-wrapped JSON", async () => {
    const result = await runStructured({
      dispatch: async () => 'Here you go:\n```json\n{"file":"d.ts","summary":"fenced"}\n```\nHope that helps!',
      validate: validateFinding,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.file).toBe("d.ts");
  });

  test("custom buildFeedback overrides the default corrective message", async () => {
    const feedbacks: (string | undefined)[] = [];
    const responses = ["prose", '{"file":"e.ts","summary":"ok"}'];
    await runStructured({
      dispatch: async (feedback) => {
        feedbacks.push(feedback);
        return responses.shift() ?? "";
      },
      validate: validateFinding,
      buildFeedback: ({ reason }) => `CUSTOM:${reason}`,
    });
    expect(feedbacks[1]).toBe("CUSTOM:parse_error");
  });
});
