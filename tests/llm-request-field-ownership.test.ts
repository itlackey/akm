// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Which request fields are the user's to set, on both transports: a connection or
 * model entry writes tuning fields (`top_p`, `reasoning_effort`, provider
 * options), and akm owns the model, the conversation, the tools, streaming and
 * the response format. `effectiveRequestFields` is where both transports take the
 * user's fields from; the chat client's body is checked here, the runtime's
 * requests in tests/integration/opencode-runtime-sessions.test.ts.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AkmConfig } from "../src/core/config/config-types";
import { LlmInvocationOverridesSchema } from "../src/core/config/schema/primitives";
import { effectiveRequestFields, OWNED_REQUEST_FIELDS } from "../src/core/llm-inference";
import { _resetWarnOnceForTests, _setWarnSinkForTests } from "../src/core/warn";
import { resolveTarget } from "../src/integrations/agent/resolution";
import { chatCompletion } from "../src/llm/client";
import { withMockedFetch } from "./_helpers/sandbox";

let warnings: string[] = [];
beforeEach(() => {
  warnings = [];
  _resetWarnOnceForTests();
  _setWarnSinkForTests((level, args) => {
    if (level === "warn") warnings.push(args.map(String).join(" "));
  });
});

afterEach(() => {
  _setWarnSinkForTests(undefined);
  _resetWarnOnceForTests();
});

const written = {
  model: "overridden",
  messages: [],
  tools: [{ type: "function" }],
  stream: true,
  response_format: { type: "json_object" },
  top_p: 0.9,
  provider: { order: ["a"] },
};

describe("effectiveRequestFields", () => {
  test("keeps tuning fields and provider options, and drops the five fields akm owns, with one warning", () => {
    const fields = effectiveRequestFields(written, { temperature: 0.2 });
    expect(fields).toEqual({ top_p: 0.9, provider: { order: ["a"] }, temperature: 0.2 });
    effectiveRequestFields(written, undefined);
    const named = warnings.filter((w) => w.includes("ignored"));
    expect(named).toHaveLength(1);
    for (const field of OWNED_REQUEST_FIELDS) expect(named[0]).toContain(`"${field}"`);
  });

  test("says nothing when none is written", () => {
    expect(effectiveRequestFields({ top_p: 0.9 }, undefined)).toEqual({ top_p: 0.9 });
    expect(warnings).toEqual([]);
  });
});

describe("an extraParams of a call, a process or a workflow step", () => {
  // The schema keeps `model`, `messages`, `stream` and `response_format` out of an extraParams; `tools` it lets through.
  const extras = { tools: [{ type: "function" }], top_k: 40 };

  test("is accepted by the schema, and its tools are taken out of the final fields", () => {
    const inference = LlmInvocationOverridesSchema.parse({ extraParams: extras });
    expect(inference.extraParams).toHaveProperty("tools");
    expect(effectiveRequestFields({ top_p: 0.9 }, inference)).toEqual({ top_p: 0.9, top_k: 40 });
    expect(warnings.filter((w) => w.includes("ignored"))).toHaveLength(1);
    expect(warnings[0]).toContain('"tools"');
  });

  test("is taken out whatever layer brought it, and every owned field is taken out of the merged result", () => {
    const merged = { ...written, ...extras };
    const fields = effectiveRequestFields({}, { extraParams: merged } as never);
    expect(fields).toEqual({ top_p: 0.9, provider: { order: ["a"] }, top_k: 40 });
  });

  test("never reaches the chat transport's body when the layers resolve to a connection", async () => {
    const runner = resolveTarget({
      config: {
        connections: { lab: { endpoint: "https://example.invalid/v1", models: { fast: "resolved" } } },
      } as unknown as AkmConfig,
      modelWork: true,
      layers: [{ inference: { extraParams: extras } }, { inference: { extraParams: { tools: [] } } }],
    });
    expect(runner.kind).toBe("connection");
    if (runner.kind !== "connection") return;
    let body: Record<string, unknown> = {};
    await withMockedFetch(
      () =>
        chatCompletion(
          {
            endpoint: runner.endpoint,
            model: runner.model,
            request: runner.request,
            ...(runner.inference ? { inference: runner.inference } : {}),
          },
          [{ role: "user", content: "hi" }],
        ),
      async (_url, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json({ choices: [{ message: { content: "ok" } }] });
      },
    );
    expect(body).not.toHaveProperty("tools");
    expect(body.top_k).toBe(40);
  });
});

describe("the chat transport", () => {
  test("sends the resolved model, its own messages and the caller's response schema whatever the connection writes", async () => {
    let body: Record<string, unknown> = {};
    await withMockedFetch(
      () =>
        chatCompletion(
          { endpoint: "https://example.invalid/v1", model: "resolved", request: written },
          [{ role: "user", content: "hi" }],
          { responseSchema: { type: "object" } },
        ),
      async (_url, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json({ choices: [{ message: { content: "ok" } }] });
      },
    );
    expect(body.model).toBe("resolved");
    expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
    expect(body.response_format).toMatchObject({ type: "json_schema" });
    expect(body).not.toHaveProperty("tools");
    expect(body).not.toHaveProperty("stream");
    expect(body.top_p).toBe(0.9);
    expect(body.provider).toEqual({ order: ["a"] });
  });

  test("sends no response format when the caller asks for none, even if the connection writes one", async () => {
    let body: Record<string, unknown> = {};
    await withMockedFetch(
      () =>
        chatCompletion({ endpoint: "https://example.invalid/v1", model: "m", request: written }, [
          { role: "user", content: "hi" },
        ]),
      async (_url, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json({ choices: [{ message: { content: "ok" } }] });
      },
    );
    expect(body).not.toHaveProperty("response_format");
  });
});
