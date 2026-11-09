// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * A connection's model alias carries request fields (`models.<alias>: { model, ...fields }`), and they reach a
 * connection's improve model work. Model work resolves its runner once, freezes it in the improve plan, and every
 * stage call resolves from that runner again, so the fields must survive that round trip. With none, akm sends
 * nothing of its own and the connection's own request fields apply.
 */

import { describe, expect, test } from "bun:test";
import { resolveImproveExecution } from "../../../src/commands/improve/execution";
import type { AkmConfig } from "../../../src/core/config/config";
import { effectiveRequestFields, thinkingSetting } from "../../../src/core/llm-inference";
import { buildExecution, resolveExecution } from "../../../src/integrations/agent/execution";
import { runExecution } from "../../../src/integrations/agent/runner-dispatch";
import type { ChatCompletionConfig } from "../../../src/llm/client";

const CONNECTION = {
  endpoint: "https://lab.invalid/v1",
  models: { fast: "krang/chat/qwen3.8-27b" },
};

function configFor(connection: Record<string, unknown>): AkmConfig {
  return {
    configVersion: "0.9.0",
    connections: { x: connection },
    improve: {
      strategies: { s: { processes: { reflect: { enabled: true } } } },
    },
  } as unknown as AkmConfig;
}

function resolveReflect(config: AkmConfig) {
  const resolved = resolveImproveExecution({ config, processName: "reflect", alias: "fast" });
  if (!resolved) throw new Error("no runner resolved");
  return resolved;
}

/** What a stage call resolves from the runner the improve plan froze, and the connection its chat call is given. */
async function dispatchedAgain(runner: ReturnType<typeof resolveReflect>["runner"]) {
  const again = resolveExecution({ content: "Reflect.", runner, modelWork: true });
  let connection: ChatCompletionConfig | undefined;
  await runExecution(buildExecution(again.request, again.runner), {
    chat: async (received) => {
      connection = received;
      return "ok";
    },
  });
  if (!connection) throw new Error("the chat transport was not called");
  return { again, connection };
}

describe("improve model work on a connection", () => {
  test("an alias's request fields survive the frozen runner and reach the chat call", async () => {
    const config = configFor({
      endpoint: CONNECTION.endpoint,
      models: {
        fast: {
          model: "krang/chat/qwen3.8-27b",
          temperature: 0.2,
          chat_template_kwargs: { enable_thinking: false },
        },
      },
    });
    const { runner } = resolveReflect(config);
    const { connection } = await dispatchedAgain(runner);

    expect(connection).toMatchObject({ model: "krang/chat/qwen3.8-27b" });
    const fields = effectiveRequestFields(connection.request, connection.inference);
    expect(fields).toMatchObject({ temperature: 0.2, chat_template_kwargs: { enable_thinking: false } });
    expect(thinkingSetting(fields)).toBe(false);
  });

  test("with no setting anywhere, akm sends nothing of its own", async () => {
    const config = configFor(CONNECTION);
    const { runner } = resolveReflect(config);
    const { again, connection } = await dispatchedAgain(runner);

    expect(again.request).not.toHaveProperty("inference");
    expect(effectiveRequestFields(connection.request, connection.inference)).toEqual({});
  });

  test("the connection's own request fields apply under the alias's", async () => {
    const config = configFor({
      ...CONNECTION,
      top_p: 0.9,
      temperature: 0.7,
      models: { fast: { model: "krang/chat/qwen3.8-27b", temperature: 0.2 } },
    });
    const { connection } = await dispatchedAgain(resolveReflect(config).runner);

    expect(effectiveRequestFields(connection.request, connection.inference)).toMatchObject({
      top_p: 0.9,
      temperature: 0.2,
    });
  });
});
