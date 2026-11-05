// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Integration: runs the real OpenCode 1 CLI as a child process, against a loopback model.
//
// Gate: `AKM_TEST_OPENCODE1_BIN=/path/to/opencode` (an OpenCode 1.x). Without it the suite is one skipped test. Only
// a real OpenCode 1 says whether it reads akm's model-work agent the way the builder writes it: akm's one-line system
// prompt in place of OpenCode's coding prompt, no session-title request, and a permission map that hides a tool and
// also refuses a call to it (`opencode-cli-compat.test.ts` does the same for OpenCode 2). OpenCode 1 fetches the
// provider package it does not bundle (`@ai-sdk/openai-compatible`) into its sandboxed cache on first use, so the run
// needs the network.
//
// Every run is sandboxed: HOME, the XDG directories and every OPENCODE_* variable point inside a temporary directory
// or are blanked, and the model is a loopback fake, so no real account, key or OpenCode file is opened.

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { harnessProfile } from "../../src/integrations/agent/profiles";
import { runAgent } from "../../src/integrations/agent/spawn";
import { _setOpencodeVersionProbeForTests, isOpencode2 } from "../../src/integrations/harnesses/opencode/version";
import { makeSandboxDir, withEnv } from "../_helpers/sandbox";

const BIN = process.env.AKM_TEST_OPENCODE1_BIN;

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

interface ModelRequest {
  readonly system: string;
  readonly user: string;
  readonly tools: readonly string[];
  readonly toolResults: readonly string[];
}

/** An OpenAI-compatible endpoint on loopback that asks for `callTool` once, then answers `PROBE_OK`. */
function fakeModel(callTool?: string, callArguments = "{}") {
  const requests: ModelRequest[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as {
        messages?: Array<{ role: string; content?: unknown }>;
        tools?: Array<{ function?: { name?: string } }>;
      };
      const texts = (role: string): string[] =>
        (body.messages ?? [])
          .filter((message) => message.role === role)
          .map((message) => (typeof message.content === "string" ? message.content : JSON.stringify(message.content)));
      const tools = (body.tools ?? []).map((tool) => tool.function?.name ?? "");
      const toolResults = texts("tool");
      requests.push({ system: texts("system").join("\n"), user: texts("user").join("\n"), tools, toolResults });
      const calling = callTool !== undefined && toolResults.length === 0 && tools.length > 0;
      const delta = calling
        ? {
            role: "assistant",
            tool_calls: [
              { index: 0, id: "c1", type: "function", function: { name: callTool, arguments: callArguments } },
            ],
          }
        : { role: "assistant", content: "PROBE_OK" };
      const chunk = (change: unknown, finish: string | null): string =>
        `data: ${JSON.stringify({
          id: "compat",
          object: "chat.completion.chunk",
          created: 1,
          model: "fake-model",
          choices: [{ index: 0, delta: change, finish_reason: finish }],
        })}\n\n`;
      return new Response(`${chunk(delta, null)}${chunk({}, calling ? "tool_calls" : "stop")}data: [DONE]\n\n`, {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  cleanups.push(() => server.stop(true));
  return { url: `http://127.0.0.1:${server.port}/v1`, requests };
}

/**
 * Model work through akm's own spawn path, in a sandbox whose project directory holds a plugin registering
 * `pluginTools` and whose HOME holds a Claude Code skill, which OpenCode's `skill` tool would list in the system prompt.
 */
async function runModelWork(model: ReturnType<typeof fakeModel>, pluginTools: readonly string[] = []) {
  const sb = makeSandboxDir("akm-oc1-compat");
  cleanups.push(sb.cleanup);
  const at = (name: string): string => {
    const dir = path.join(sb.dir, name);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };
  const work = at("work");
  const marker = path.join(sb.dir, "marker.txt");
  const skill = path.join(at("home"), ".claude", "skills", "fixture-skill");
  fs.mkdirSync(skill, { recursive: true });
  fs.writeFileSync(
    path.join(skill, "SKILL.md"),
    "---\nname: fixture-skill\ndescription: FIXTURE_SKILL_LISTED\n---\nbody\n",
  );
  if (pluginTools.length > 0) {
    fs.mkdirSync(path.join(work, ".opencode", "plugin"), { recursive: true });
    const tools = pluginTools
      .map(
        (name) =>
          `${name}:{description:"a fixture tool",args:{},async execute(){require("node:fs").writeFileSync(${JSON.stringify(marker)},"written");return "ran";}}`,
      )
      .join(",");
    fs.writeFileSync(
      path.join(work, ".opencode", "plugin", "fixture.js"),
      `export const Fixture = async () => ({ tool: { ${tools} } });\n`,
    );
  }
  // The user's own provider arrives in OPENCODE_CONFIG_CONTENT, which model work merges its agent into.
  const userConfig = {
    model: "fixture/fake-model",
    disabled_providers: ["opencode"],
    provider: {
      fixture: {
        npm: "@ai-sdk/openai-compatible",
        options: { baseURL: model.url, apiKey: "SYNTHETIC_KEY" },
        models: { "fake-model": { tool_call: true, limit: { context: 100000, output: 4000 } } },
      },
    },
  };
  const env = {
    HOME: at("home"),
    XDG_CONFIG_HOME: at("config"),
    XDG_DATA_HOME: at("data"),
    XDG_CACHE_HOME: at("cache"),
    XDG_STATE_HOME: at("state"),
    ...Object.fromEntries(
      Object.keys(process.env)
        .filter((name) => name.startsWith("OPENCODE_"))
        .map((name) => [name, undefined]),
    ),
    OPENCODE_CONFIG_CONTENT: JSON.stringify(userConfig),
  };
  const profile = harnessProfile({
    kind: "harness",
    name: "opencode",
    platform: "opencode",
    bin: BIN ?? "",
    args: ["run"],
    timeoutMs: 120_000,
  });
  const result = await withEnv(env, () =>
    runAgent(profile, {
      cwd: work,
      stdio: "captured",
      timeoutMs: 120_000,
      env: { OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_FREE_MODELS: "1" },
      dispatch: { prompt: "probe", modelWork: true },
    }),
  );
  return { result, work, marker };
}

if (!BIN || process.platform === "win32") {
  test.skip("OpenCode 1 CLI compatibility (set AKM_TEST_OPENCODE1_BIN to run; not run on Windows)", () => {});
} else {
  describe("OpenCode 1 model work", () => {
    beforeAll(() => {
      _setOpencodeVersionProbeForTests(undefined);
    });

    test("the named binary is OpenCode 1", () => {
      expect(isOpencode2(BIN)).toBe(false);
    });

    test("sends akm's one-line system prompt, no skill listing and no title request", async () => {
      const model = fakeModel();
      const { result } = await runModelWork(model);

      expect(result.ok).toBe(true);
      expect(result.stdout).toContain("PROBE_OK");
      expect(model.requests).toHaveLength(1);
      expect(model.requests[0]?.system).toStartWith("Do the task in the message. Reply with exactly what it asks for.");
      expect(model.requests[0]?.system).not.toContain("You are opencode");
      expect(model.requests[0]?.system).not.toContain("FIXTURE_SKILL_LISTED");
      expect(model.requests[0]?.user).toContain("probe");
    }, 120_000);

    test("only the reading tools are offered, and a call to a tool the agent denies is refused and runs nothing", async () => {
      for (const callTool of ["bash", "review_note"]) {
        const model = fakeModel(
          callTool,
          callTool === "bash" ? '{"command":"touch bash-ran","description":"x"}' : "{}",
        );
        const { result, work, marker } = await runModelWork(model, ["review_note"]);

        expect(result.ok).toBe(true);
        expect([...(model.requests[0]?.tools ?? [])].sort()).toEqual(["glob", "grep", "read"]);
        expect(model.requests[1]?.toolResults.join("\n")).toContain("unavailable tool");
        expect(fs.existsSync(marker)).toBe(false);
        expect(fs.existsSync(path.join(work, "bash-ran"))).toBe(false);
      }
    }, 240_000);

    test("the akm plugin's three reading tools stay, and the two that write go", async () => {
      const model = fakeModel();
      const names = ["akm_search", "akm_show", "akm_curate", "akm_remember", "akm_feedback"];
      const { result } = await runModelWork(model, names);

      expect(result.ok).toBe(true);
      expect([...(model.requests[0]?.tools ?? [])].sort()).toEqual([
        "akm_curate",
        "akm_search",
        "akm_show",
        "glob",
        "grep",
        "read",
      ]);
    }, 120_000);
  });
}
