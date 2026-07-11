// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import { akmAgentDispatch } from "../../src/commands/agent/agent-dispatch";
import { UsageError } from "../../src/core/errors";

describe("akmAgentDispatch engine capability", () => {
  test("returns the exact v2 public result envelope", async () => {
    const result = await akmAgentDispatch({
      engine: "test-agent",
      prompt: "hello",
      agentConfig: {
        configVersion: "0.9.0",
        semanticSearchMode: "auto",
        engines: {
          "test-agent": { kind: "agent", platform: "aider", bin: "/bin/true" },
        },
        defaults: { engine: "test-agent" },
      },
    });
    expect(result).toEqual({
      schemaVersion: 2,
      ok: true,
      shape: "agent-result",
      engine: "test-agent",
      exitCode: 0,
      stdout: "",
      stderr: "",
      durationMs: expect.any(Number),
    });
  });

  test("rejects an LLM engine instead of falling back to an agent profile", async () => {
    await expect(
      akmAgentDispatch({
        engine: "fast",
        prompt: "hello",
        agentConfig: {
          configVersion: "0.9.0",
          semanticSearchMode: "auto",
          engines: {
            fast: {
              kind: "llm",
              endpoint: "https://example.test/v1/chat/completions",
              model: "test",
            },
          },
          defaults: { engine: "fast" },
        },
      }),
    ).rejects.toBeInstanceOf(UsageError);
  });
});
