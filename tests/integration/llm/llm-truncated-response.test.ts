// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Truncated LLM responses (`finishReason: "length"`), issue #865.
 *
 * `#815`/`#816` fixed the CAUSE in normal operation (`reasoningEffort` is now
 * a first-class field, so the token-budget truncation that cost ~50% of
 * reflect calls no longer routinely happens). The HANDLING stayed untested:
 * when a response IS truncated mid-JSON, `chatCompletion` resolves
 * successfully (a 200 with valid envelope JSON is not a transport error) and
 * returns only the raw content string — `finishReason` is computed for
 * telemetry (`emitLlmUsage`) but never reaches the caller. `runStructured`
 * (src/core/structured.ts), which every structured-output call site sits on,
 * then fails to parse the truncated JSON and reports the same generic
 * `parse_error` it would for garbled or empty model output — there is no
 * channel for "the model was still writing when the token cap cut it off" to
 * reach that classification at all.
 *
 * This test pins that current behavior. See the accompanying report for the
 * judgment call on whether `finishReason: "length"` should get a distinct
 * classification (decision: no — see PR/issue notes).
 */
import { describe, expect, test } from "bun:test";
import { chatCompletion } from "../../../src/llm/client";
import { jsonParser, structuredLoop } from "../../../src/llm/structured";

function createRequestServer(respond: () => Response): { url: string; server: ReturnType<typeof Bun.serve> } {
  const server = Bun.serve({ port: 0, fetch: () => respond() });
  return { url: `http://localhost:${server.port}`, server };
}

describe("truncated LLM responses collapse into a generic parse_error (#865)", () => {
  test("chatCompletion resolves successfully with the truncated content, dropping finishReason", async () => {
    const { url, server } = createRequestServer(() =>
      Response.json({
        choices: [
          { message: { content: '{"file":"a.ts","summary":"this got cut off mid-str' }, finish_reason: "length" },
        ],
      }),
    );
    try {
      const raw = await chatCompletion({ endpoint: url, model: "test-model" }, [{ role: "user", content: "go" }]);
      // The truncated JSON comes through as-is — chatCompletion neither throws
      // nor exposes `finishReason` to the caller.
      expect(raw).toBe('{"file":"a.ts","summary":"this got cut off mid-str');
    } finally {
      server.stop(true);
    }
  });

  test("the structured loop reports the same parse_error for a truncated response as for garbage", async () => {
    const parse = jsonParser((candidate) => ({ ok: true, value: candidate }));
    const truncated = await structuredLoop({
      dispatch: async () => '{"file":"a.ts","summary":"this got cut off mid-str',
      parse,
      attempts: 1,
    });
    const garbage = await structuredLoop({
      dispatch: async () => "the model said something unrelated, no JSON at all",
      parse,
      attempts: 1,
    });

    expect(truncated.ok).toBe(false);
    expect(garbage.ok).toBe(false);
    if (!truncated.ok && !garbage.ok) {
      // Both land on the exact same classification — a caller (or a user
      // reading the error) cannot tell "hit the token cap" from "bad output".
      expect(truncated.reason).toBe("parse_error");
      expect(garbage.reason).toBe("parse_error");
      expect(truncated.errors).toEqual(garbage.errors);
    }
  });
});
