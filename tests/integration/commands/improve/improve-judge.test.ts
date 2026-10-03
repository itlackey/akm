// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm improve judge`: reflect's quality judge on a revision read from stdin,
 * with the engine the reflect quality gate names. Spawns the real CLI against a
 * stub chat-completions server.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import path from "node:path";
import { saveConfig } from "../../../../src/core/config/config";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../../../_helpers/sandbox";

const repoRoot = path.resolve(import.meta.dir, "../../../..");

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
});

afterEach(() => {
  storage.cleanup();
});

async function spawnJudge(stdin: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(["bun", "src/cli.ts", "improve", "judge", "--format", "json"], {
    cwd: repoRoot,
    env: { ...process.env },
    stdin: new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stdout, stderr };
}

describe("akm improve judge", () => {
  test("judges the revision with the reflect quality gate's engine and prints its verdict", async () => {
    const prompts: string[] = [];
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const body = (await request.json()) as { messages: { role: string; content: string }[] };
        prompts.push(body.messages.at(-1)?.content ?? "");
        const reply = { scores: { need: 5, preservation: 5, quality: 4 }, reason: "Fixes the truncated description." };
        return Response.json({ choices: [{ message: { role: "assistant", content: JSON.stringify(reply) } }] });
      },
    });
    try {
      saveConfig({
        semanticSearchMode: "off",
        engines: {
          gate: { kind: "llm", endpoint: `http://127.0.0.1:${server.port}/v1/chat/completions`, model: "gate-model" },
        },
        improve: { strategies: { default: { processes: { reflect: { qualityGate: { engine: "gate" } } } } } },
      });

      const result = await spawnJudge(
        JSON.stringify({
          source: "description: Deploys the",
          candidate: "description: Deploys the app",
          feedback: "truncated",
        }),
      );

      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: true,
        engine: "gate",
        pass: true,
        criteria: { need: 5, preservation: 5, quality: 4 },
        reason: "Fixes the truncated description.",
      });
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toContain("description: Deploys the app");
      expect(prompts[0]).toContain("truncated");
    } finally {
      server.stop(true);
    }
  });

  test("fails when the reflect quality gate names no engine", async () => {
    saveConfig({ semanticSearchMode: "off" });

    const result = await spawnJudge(JSON.stringify({ source: "a", candidate: "b" }));

    expect(result.code).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("processes.reflect.qualityGate.engine");
  });
});
