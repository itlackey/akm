// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Integration: runs the real OpenCode 1 CLI as a child process, against a loopback model.
//
// Gate: `AKM_TEST_OPENCODE1_BIN=/path/to/opencode` (an OpenCode 1). Without it the suite is one skipped test. Model work
// on OpenCode 1 must reach the model with akm's one-line system prompt in place of OpenCode's coding prompt, without the
// `skill` tool and its listing, and make no session-title request; only the real CLI says whether it reads the agent the way the builder writes it. The run is
// sandboxed: HOME, the XDG directories and the working directory are temporary, and the only provider is the loopback fake.

import { afterEach, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { harnessProfile } from "../../src/integrations/agent/profiles";
import { runAgent } from "../../src/integrations/agent/spawn";
import { _setOpencodeVersionProbeForTests, isOpencode2 } from "../../src/integrations/harnesses/opencode/version";
import { makeSandboxDir, withEnv } from "../_helpers/sandbox";

const GATE = "AKM_TEST_OPENCODE1_BIN";
const BIN = process.env[GATE];

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** An OpenAI-compatible endpoint on loopback that answers `PROBE_OK` and records each request's system and user text and tools. */
function fakeModel() {
  const requests: Array<{ system: string; user: string; tools: string[] }> = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as {
        messages?: Array<{ role: string; content?: unknown }>;
        tools?: Array<{ function?: { name?: string } }>;
      };
      const text = (role: string): string =>
        (body.messages ?? [])
          .filter((message) => message.role === role)
          .map((message) => (typeof message.content === "string" ? message.content : JSON.stringify(message.content)))
          .join("\n");
      requests.push({
        system: text("system"),
        user: text("user"),
        tools: (body.tools ?? []).map((tool) => tool.function?.name ?? ""),
      });
      const chunk = (delta: unknown, finish: string | null): string =>
        `data: ${JSON.stringify({
          id: "compat",
          object: "chat.completion.chunk",
          created: 1,
          model: "fake-model",
          choices: [{ index: 0, delta, finish_reason: finish }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        })}\n\n`;
      return new Response(
        `${chunk({ role: "assistant", content: "PROBE_OK" }, null)}${chunk({}, "stop")}data: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  cleanups.push(() => server.stop(true));
  return { url: `http://127.0.0.1:${server.port}/v1`, requests };
}

function registerSuite(bin: string): void {
  beforeAll(() => {
    _setOpencodeVersionProbeForTests(undefined);
  });

  test("model work sends akm's one-line system prompt, no skill listing and no title request", async () => {
    const sb = makeSandboxDir("akm-oc1-prompt");
    cleanups.push(sb.cleanup);
    const at = (name: string): string => {
      const dir = path.join(sb.dir, name);
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    };
    const model = fakeModel();
    // A skill OpenCode 1 finds under HOME, which its `skill` tool would list in the system prompt.
    const skill = path.join(at("home"), ".claude", "skills", "fixture-skill");
    fs.mkdirSync(skill, { recursive: true });
    fs.writeFileSync(
      path.join(skill, "SKILL.md"),
      "---\nname: fixture-skill\ndescription: FIXTURE_SKILL_LISTED\n---\nbody\n",
    );
    // The user's own provider arrives in OPENCODE_CONFIG_CONTENT, which model work merges its agent into.
    const userConfig = {
      model: "fixture/fake-model",
      provider: {
        fixture: {
          npm: "@ai-sdk/openai-compatible",
          options: { baseURL: model.url, apiKey: "SYNTHETIC_KEY" },
          models: { "fake-model": {} },
        },
      },
    };
    const env = {
      HOME: at("home"),
      XDG_CONFIG_HOME: at("config"),
      XDG_DATA_HOME: at("data"),
      XDG_CACHE_HOME: at("cache"),
      XDG_STATE_HOME: at("state"),
      OPENCODE_CONFIG_CONTENT: JSON.stringify(userConfig),
    };
    const profile = harnessProfile({
      kind: "harness",
      name: "opencode",
      platform: "opencode",
      bin,
      args: ["run"],
      timeoutMs: 60_000,
    });

    const result = await withEnv(env, async () => {
      expect(isOpencode2(bin)).toBe(false);
      return runAgent(profile, {
        cwd: at("work"),
        stdio: "captured",
        timeoutMs: 60_000,
        env: { OPENCODE_DISABLE_MODELS_FETCH: "1" },
        dispatch: { prompt: "probe", modelWork: true },
      });
    });

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("PROBE_OK");
    expect(model.requests).toHaveLength(1);
    expect(model.requests[0]?.system).toStartWith("Do the task in the message. Reply with exactly what it asks for.");
    expect(model.requests[0]?.system).not.toContain("You are opencode");
    expect(model.requests[0]?.system).not.toContain("FIXTURE_SKILL_LISTED");
    expect(model.requests[0]?.tools).not.toContain("skill");
    expect(model.requests[0]?.user).toContain("probe");
  }, 90_000);
}

if (!BIN || process.platform === "win32") {
  test.skip(`the OpenCode 1 model-work prompt test needs ${GATE} naming an OpenCode 1 binary (not run on Windows)`, () => {});
} else {
  registerSuite(BIN);
}
