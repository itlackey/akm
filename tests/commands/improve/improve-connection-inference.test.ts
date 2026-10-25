// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * An improve process's `llm` overlay (`improve.strategies.<s>.processes.<p>.llm`)
 * reaches a connection's model work. Model work resolves its runner once,
 * freezes it in the improve plan, and every stage call resolves from that
 * runner again, so the overlay must survive that round trip. With no overlay,
 * akm sends nothing of its own and the connection's own request fields apply.
 */

import { describe, expect, test } from "bun:test";
import { resolveImproveExecution } from "../../../src/commands/improve/execution";
import type { AkmConfig } from "../../../src/core/config/config";
import { buildExecution, resolveExecution } from "../../../src/integrations/agent/execution";
import { runExecution } from "../../../src/integrations/agent/runner-dispatch";
import type { ChatCompletionConfig } from "../../../src/llm/client";

const CONNECTION = {
  endpoint: "https://lab.invalid/v1",
  models: { fast: "krang/chat/qwen3.8-27b" },
};

function configFor(connection: Record<string, unknown>, llm?: Record<string, unknown>): AkmConfig {
  return {
    configVersion: "0.9.0",
    connections: { x: connection },
    improve: {
      strategies: { s: { processes: { reflect: { enabled: true } } } },
      ...(llm ? { processes: { reflect: { llm } } } : {}),
    },
  } as unknown as AkmConfig;
}

function resolveReflect(config: AkmConfig) {
  const resolved = resolveImproveExecution({ config, processName: "reflect" });
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
  test("the process overlay survives the frozen runner and reaches the chat call", async () => {
    const config = configFor(CONNECTION, { reasoningEffort: "low", temperature: 0.2 });
    const resolved = resolveReflect(config);

    expect(resolved.notices.filter((notice) => (notice.field ?? "").startsWith("inference."))).toEqual([]);
    const { connection } = await dispatchedAgain(resolved.runner);
    expect(connection).toMatchObject({ model: "krang/chat/qwen3.8-27b" });
    expect(connection.request).toEqual({ temperature: 0.2, reasoning_effort: "low" });
  });

  test("with no setting anywhere, akm sends nothing of its own", async () => {
    const config = configFor(CONNECTION);
    const { runner } = resolveReflect(config);
    const { again, connection } = await dispatchedAgain(runner);

    expect(again.request).not.toHaveProperty("inference");
    expect(connection.request).toEqual({});
  });

  test("the connection's own request fields stay under the overlay", async () => {
    const config = configFor({ ...CONNECTION, top_p: 0.9, temperature: 0.7 }, { temperature: 0.2 });
    const { connection } = await dispatchedAgain(resolveReflect(config).runner);

    expect(connection.request).toEqual({ top_p: 0.9, temperature: 0.2 });
  });
});
