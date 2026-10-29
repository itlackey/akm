import { type ChatCompletionConfig, chatCompletion } from "../../src/llm/client";
import { withMockedFetch } from "./sandbox";

/**
 * Make this process see `connection` reject `response_format: json_schema`, the
 * way a real first call does: a schema call to an endpoint that answers 400 to it
 * and 200 to the same request without it. The client remembers the rejection for
 * the rest of the process (until `_resetEndpointSupportTrackersForTests`), so
 * callers that choose their framing up front (reflect) frame the reply instead.
 */
export async function rejectJsonSchemaOn(connection: Pick<ChatCompletionConfig, "endpoint" | "model">): Promise<void> {
  await withMockedFetch(
    async () => {
      await chatCompletion({ ...connection }, [{ role: "user", content: "warm up" }], {
        responseSchema: { type: "object" },
      });
    },
    async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { response_format?: unknown };
      return body.response_format
        ? new Response(JSON.stringify({ error: { message: "response_format.json_schema is not supported" } }), {
            status: 400,
            headers: { "content-type": "application/json" },
          })
        : new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
    },
  );
}
