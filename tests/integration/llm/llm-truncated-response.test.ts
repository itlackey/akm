// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Truncated and empty LLM replies, issue #865 and B10-14.
 *
 * `chatCompletion` fails a reply cut at the output limit (`finish_reason: "length"`) and a reply with no content, as a
 * `parse_error` that says so; the model's reasoning is never returned as the answer. The usage event records the
 * failure and keeps `finishReason`. `structuredLoop` (src/llm/structured.ts) still reports the same generic
 * `parse_error` for garbled model output.
 */
import { describe, expect, test } from "bun:test";
import { chatCompletion, LlmCallError } from "../../../src/llm/client";
import { isRefused, jsonParser, structuredLoop } from "../../../src/llm/structured";
import { clearLlmUsageSink, type LlmUsageRecord, setLlmUsageSink } from "../../../src/llm/usage-telemetry";

function createRequestServer(respond: () => Response): { url: string; server: ReturnType<typeof Bun.serve> } {
  const server = Bun.serve({ port: 0, fetch: () => respond() });
  return { url: `http://localhost:${server.port}`, server };
}

describe("a cut-off or empty reply is a failure that says so", () => {
  test("a reply cut at the output limit fails with parse_error naming finish_reason and the model; the usage event keeps it", async () => {
    const events: LlmUsageRecord[] = [];
    setLlmUsageSink((record) => events.push(record));
    const { url, server } = createRequestServer(() =>
      Response.json({
        model: "served-model",
        choices: [
          { message: { content: '{"file":"a.ts","summary":"this got cut off mid-str' }, finish_reason: "length" },
        ],
      }),
    );
    try {
      const failure = await chatCompletion({ endpoint: url, model: "test-model" }, [
        { role: "user", content: "go" },
      ]).then(
        () => undefined,
        (error) => error,
      );
      expect(failure).toBeInstanceOf(LlmCallError);
      expect((failure as LlmCallError).code).toBe("parse_error");
      expect((failure as LlmCallError).message).toContain('reply cut at the output limit (finish_reason "length")');
      expect((failure as LlmCallError).message).toContain("served-model");
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ outcome: "error", errorCode: "parse_error", finishReason: "length" });
    } finally {
      clearLlmUsageSink();
      server.stop(true);
    }
  });

  test("an empty content fails with parse_error; reasoning_content is never returned as the answer", async () => {
    const { url, server } = createRequestServer(() =>
      Response.json({
        choices: [
          {
            message: { content: "", reasoning_content: "Let me think. The user wants a summary." },
            finish_reason: "stop",
          },
        ],
      }),
    );
    try {
      const failure = await chatCompletion({ endpoint: url, model: "test-model" }, [
        { role: "user", content: "go" },
      ]).then(
        (answer) => answer,
        (error) => error,
      );
      expect(failure).toBeInstanceOf(LlmCallError);
      expect((failure as LlmCallError).code).toBe("parse_error");
      expect((failure as LlmCallError).message).toContain("reply had no content");
      expect((failure as LlmCallError).message).toContain("reasoning_content");
    } finally {
      server.stop(true);
    }
  });

  test("a complete reply is returned unchanged", async () => {
    const { url, server } = createRequestServer(() =>
      Response.json({ choices: [{ message: { content: "done" }, finish_reason: "stop" }] }),
    );
    try {
      expect(await chatCompletion({ endpoint: url, model: "test-model" }, [{ role: "user", content: "go" }])).toBe(
        "done",
      );
    } finally {
      server.stop(true);
    }
  });

  test("the structured loop reports the same parse_error for a truncated response as for garbage", async () => {
    const parse = jsonParser((candidate) => ({ ok: true, value: candidate }));
    const truncated = await structuredLoop({
      dispatch: async () => ({ ok: true, raw: '{"file":"a.ts","summary":"this got cut off mid-str' }),
      parse,
      attempts: 1,
    });
    const garbage = await structuredLoop({
      dispatch: async () => ({ ok: true, raw: "the model said something unrelated, no JSON at all" }),
      parse,
      attempts: 1,
    });

    expect(truncated.ok).toBe(false);
    expect(garbage.ok).toBe(false);
    if (isRefused(truncated) && isRefused(garbage)) {
      // Both land on the exact same classification — a caller (or a user
      // reading the error) cannot tell "hit the token cap" from "bad output".
      expect(truncated.reason).toBe("parse_error");
      expect(garbage.reason).toBe("parse_error");
      expect(truncated.errors).toEqual(garbage.errors);
    }
  });
});
