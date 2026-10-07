// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The client sends a response schema `strict: true`, and a strict structured-
 * output provider (OpenAI's) refuses one whose objects do not list every
 * property in `required`:
 *
 *   400 Invalid schema for response_format 'akm_response': In context=(),
 *   'required' is required to be supplied and to be an array including every
 *   key in properties. Missing 'tags'.
 *
 * Distill's lesson schema left `tags` out (the knowledge schema, `tags` and
 * `sources`), so its first request always failed; after a 4xx the client retries
 * once without the schema, and through a gateway that answers 502 instead
 * every lesson call failed (#1046). The stub here applies that rule over the
 * wire, so what is under test is the request distill sends, not its shape alone.
 *
 * Lives under tests/integration/ because it serves HTTP on localhost. Each test serves on a port of
 * its own, so its connection's in-memory "schema unsupported" verdict never reaches another.
 */

import { describe, expect, test } from "bun:test";
import { DISTILL_KNOWLEDGE_JSON_SCHEMA, DISTILL_LESSON_JSON_SCHEMA } from "../../../src/commands/improve/distill";
import type { LlmConnectionConfig } from "../../../src/core/config/config";
import { chatCompletion, isJsonSchemaKnownUnsupported } from "../../../src/llm/client";

/** OpenAI's first complaint about an object that does not require all of its properties, or undefined. */
function strictSchemaViolation(schema: unknown, context: string[] = []): string | undefined {
  if (typeof schema !== "object" || schema === null) return undefined;
  const node = schema as { properties?: Record<string, unknown>; required?: string[]; items?: unknown };
  const where = `In context=(${context.map((key) => `'${key}'`).join(", ")})`;
  if (node.properties) {
    const missing = Object.keys(node.properties).find((key) => !node.required?.includes(key));
    if (missing !== undefined) {
      return `Invalid schema for response_format 'akm_response': ${where}, 'required' is required to be supplied and to be an array including every key in properties. Missing '${missing}'.`;
    }
    for (const [key, child] of Object.entries(node.properties)) {
      const violation = strictSchemaViolation(child, [...context, "properties", key]);
      if (violation) return violation;
    }
  }
  return node.items === undefined ? undefined : strictSchemaViolation(node.items, [...context, "items"]);
}

interface Strictness {
  url: string;
  requests: Array<Record<string, unknown>>;
  stop: () => void;
}

function startStrictProvider(): Strictness {
  const requests: Array<Record<string, unknown>> = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as {
        response_format?: { json_schema?: { schema?: unknown; strict?: boolean } };
      };
      requests.push(body as Record<string, unknown>);
      const jsonSchema = body.response_format?.json_schema;
      const violation = jsonSchema?.strict ? strictSchemaViolation(jsonSchema.schema) : undefined;
      if (violation)
        return Response.json({ error: { message: violation, type: "invalid_request_error" } }, { status: 400 });
      return Response.json({ choices: [{ message: { content: "{}" } }] });
    },
  });
  return { url: `http://localhost:${server.port}`, requests, stop: () => server.stop(true) };
}

const messages = [{ role: "user" as const, content: "Distill this." }];

describe("distill's response schemas against a strict structured-output provider (#1046)", () => {
  test.each([
    ["lesson", DISTILL_LESSON_JSON_SCHEMA],
    ["knowledge", DISTILL_KNOWLEDGE_JSON_SCHEMA],
  ])("the %s schema is accepted on the first request, with no fall-back to a schema-free retry", async (_kind, schema) => {
    const provider = startStrictProvider();
    const config: LlmConnectionConfig = { endpoint: provider.url, model: "gpt-test" };
    try {
      await chatCompletion(config, messages, { responseSchema: schema });
      expect(provider.requests).toHaveLength(1);
      expect(provider.requests[0]).toHaveProperty("response_format");
      expect(isJsonSchemaKnownUnsupported(config)).toBe(false);
    } finally {
      provider.stop();
    }
  });

  test("the stub does refuse a schema that leaves a property out of `required`", async () => {
    const provider = startStrictProvider();
    const config: LlmConnectionConfig = { endpoint: provider.url, model: "gpt-test" };
    const optionalTags = {
      type: "object",
      required: ["body"],
      additionalProperties: false,
      properties: { body: { type: "string" }, tags: { type: "array", items: { type: "string" } } },
    };
    try {
      await chatCompletion(config, messages, { responseSchema: optionalTags });
      // Rejected, then retried without the schema.
      expect(provider.requests).toHaveLength(2);
      expect(provider.requests[1]).not.toHaveProperty("response_format");
      expect(isJsonSchemaKnownUnsupported(config)).toBe(true);
    } finally {
      provider.stop();
    }
  });
});
