// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// The opencode harness: one entry, two transports chosen at dispatch by the major
// of the installed binary. OpenCode 1 runs its CLI; OpenCode 2 runs embedded, in
// the user's OpenCode (scripted host: tests/_helpers/fake-opencode-host.ts).

import { beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { resetConfigCache } from "../src/core/config/config";
import { getCacheDir } from "../src/core/paths";
import { buildExecution, currentLayer, resolveExecution } from "../src/integrations/agent/execution";
import { type RunExecutionOptions, runExecution } from "../src/integrations/agent/runner-dispatch";
import type { AgentRunResult, RunAgentOptions } from "../src/integrations/agent/spawn";
import { installFakeOpencodeHost } from "./_helpers/fake-opencode-host";
import { fakeOpencodeMajor } from "./_helpers/opencode-version";
import { makeSandboxDir, withEnv, writeSandboxConfig } from "./_helpers/sandbox";

const writeConfig = (harness: Record<string, unknown> = {}): void => {
  writeSandboxConfig({ harnesses: { opencode: harness } });
  resetConfigCache();
};
beforeEach(() => writeConfig());

interface RequestOptions {
  readonly layers?: ReturnType<typeof currentLayer>[];
  readonly modelWork?: boolean;
  readonly persona?: Parameters<typeof resolveExecution>[0]["persona"];
}

/** A request to the opencode harness, built the way a command's would be. */
function request({ layers = [], modelWork = false, persona }: RequestOptions = {}) {
  const config = JSON.parse(
    fs.readFileSync(path.join(process.env.XDG_CONFIG_HOME ?? "", "akm", "config.json"), "utf8"),
  );
  const resolved = resolveExecution({
    content: "do the work",
    config,
    layers,
    modelWork,
    ...(persona ? { persona } : {}),
  });
  return buildExecution(resolved.request, resolved.runner);
}

const spawned: Array<{ argv: string; cwd?: string; stdin?: string }> = [];
const cliSeam: RunExecutionOptions = {
  runAgent: async (profile, opts: RunAgentOptions): Promise<AgentRunResult> => {
    spawned.push({ argv: profile.bin, ...(opts.cwd ? { cwd: opts.cwd } : {}), stdin: opts.dispatch?.prompt });
    return { ok: true, exitCode: 0, stdout: "from the CLI", stderr: "", durationMs: 1 };
  },
};

describe("transport by the installed major", () => {
  beforeEach(() => {
    spawned.length = 0;
  });

  test("OpenCode 2 runs embedded, on the opencode host", async () => {
    fakeOpencodeMajor(2);
    const { calls, specs } = installFakeOpencodeHost({ reply: () => "from the embedded OpenCode" });
    const result = await runExecution(request());
    expect(result).toMatchObject({ ok: true, stdout: "from the embedded OpenCode" });
    expect(specs.map((spec) => spec.kind)).toEqual(["opencode"]);
    expect(calls[0]).toMatchObject({ kind: "opencode", prompt: "do the work", metadata: { akm: "agent" } });
  });

  test("OpenCode 1 runs its CLI", async () => {
    fakeOpencodeMajor(1);
    const { calls } = installFakeOpencodeHost({ reply: () => "must not be used" });
    expect(await runExecution(request(), cliSeam)).toMatchObject({ stdout: "from the CLI" });
    expect(calls).toHaveLength(0);
  });

  test("a binary whose version cannot be read runs its CLI, as given", async () => {
    fakeOpencodeMajor(() => undefined);
    const { calls } = installFakeOpencodeHost({ reply: () => "must not be used" });
    expect(await runExecution(request(), cliSeam)).toMatchObject({ stdout: "from the CLI" });
    expect(calls).toHaveLength(0);
  });

  test("an interactive launch of OpenCode 2 hands the terminal to its CLI", async () => {
    fakeOpencodeMajor(2);
    const { calls } = installFakeOpencodeHost({ reply: () => "must not be used" });
    const interactive = request();
    const result = await runExecution(
      { ...interactive, options: { ...interactive.options, stdio: "interactive" } },
      { runAgent: cliSeam.runAgent },
    );
    expect(result.stdout).toBe("from the CLI");
    expect(calls).toHaveLength(0);
  });
});

describe("a request on the embedded OpenCode", () => {
  beforeEach(() => fakeOpencodeMajor(2));

  test("names no model when akm names none, so the user's default decides", async () => {
    const { calls } = installFakeOpencodeHost({ reply: () => "ok" });
    await runExecution(request());
    expect(calls[0]?.model).toBeUndefined();
  });

  test("names the model akm resolved, as provider and id", async () => {
    writeConfig({ models: { fast: "lab/small", balanced: "lab/mid" } });
    const { calls } = installFakeOpencodeHost({ reply: () => "ok" });
    await runExecution(request({ layers: [currentLayer({ model: "balanced" })] }));
    expect(calls[0]?.model).toEqual({ providerID: "lab", id: "mid" });
  });

  test("keeps the persona in the prompt, with the settings it cannot translate reported", async () => {
    const { calls } = installFakeOpencodeHost({ reply: () => "ok" });
    const built = request({
      persona: { content: "BE BRIEF", source: { ref: "agents/brief" } } as never,
      layers: [currentLayer({ inference: { temperature: 0.1 } })],
    });
    await runExecution(built);
    expect(calls[0]?.prompt).toContain("BE BRIEF");
    expect(calls[0]?.system).toBeUndefined();
    expect(built.notices.map((notice) => notice.field)).toContain("inference.temperature");
  });

  test("carries the run's environment and working directory", async () => {
    const { calls } = installFakeOpencodeHost({ reply: () => "ok" });
    const built = request();
    await runExecution({
      ...built,
      options: { ...built.options, cwd: "/work/here", env: { AKM_EVENT_SOURCE: "task" } },
    });
    expect(calls[0]).toMatchObject({ directory: "/work/here", environment: { AKM_EVENT_SOURCE: "task" } });
  });

  test("is not given the runtime's request settings or key", async () => {
    const { calls } = installFakeOpencodeHost({ reply: () => "ok" });
    await runExecution(request());
    expect(calls[0]?.requestHeaders.authorization).toBeUndefined();
    expect(Object.keys(calls[0]?.requestBody ?? {}).sort()).toEqual(["max_completion_tokens", "model", "stream"]);
  });
});

describe("a request on the embedded OpenCode that is cut short", () => {
  test("names the harness in the failure", async () => {
    fakeOpencodeMajor(2);
    installFakeOpencodeHost({ reply: () => new Promise(() => {}) });
    const built = request();
    const result = await runExecution({ ...built, options: { ...built.options, timeoutMs: 20 } });
    expect(result.reason).toBe("timeout");
    expect(result.error).toStartWith('the opencode harness "opencode" timed out after 20ms');
  });
});

describe("model work on the embedded OpenCode", () => {
  beforeEach(() => fakeOpencodeMajor(2));

  test("is confined and runs in one fixed directory, where no scratch directory is made", async () => {
    const { calls } = installFakeOpencodeHost({ reply: () => "an answer" });
    const scratchBefore = fs
      .readdirSync(require("node:os").tmpdir())
      .filter((name) => name.startsWith("akm-model-work-"));
    const first = await runExecution(request({ modelWork: true }));
    const second = await runExecution(request({ modelWork: true }));
    expect(first).toMatchObject({ ok: true, stdout: "an answer" });
    expect(second.ok).toBe(true);
    expect(calls[0]).toMatchObject({ metadata: { akm: "model-work" } });
    expect(calls[0]?.permissions).toEqual(
      ["edit", "shell", "execute", "subagent"].map((action) => ({ action, resource: "*", effect: "deny" })),
    );
    const fixed = path.join(getCacheDir(), "opencode", "model-work");
    expect(calls.map((call) => call.directory)).toEqual([fixed, fixed]);
    expect(fs.readdirSync(require("node:os").tmpdir()).filter((name) => name.startsWith("akm-model-work-"))).toEqual(
      scratchBefore,
    );
  });

  test("loads akm's read tools", async () => {
    const { tools } = installFakeOpencodeHost({ reply: () => "ok" });
    await runExecution(request({ modelWork: true }));
    expect(tools.opencode).toEqual(["akm_curate", "akm_search", "akm_show"]);
  });

  test("OpenCode 1 runs it in a scratch directory, unrestricted, with one warning", async () => {
    fakeOpencodeMajor(1);
    const seen: string[] = [];
    await runExecution(request({ modelWork: true }), {
      runAgent: async (_profile, opts) => {
        seen.push(opts.cwd ?? "");
        return { ok: true, exitCode: 0, stdout: "an answer", stderr: "", durationMs: 1 };
      },
    });
    expect(path.basename(seen[0] ?? "")).toStartWith("akm-model-work-");
  });
});

describe("the opencode host", () => {
  beforeEach(() => fakeOpencodeMajor(2));

  test("is the user's OpenCode: not isolated, its catalog fetched, nothing of akm's config overlaid", async () => {
    const { specs } = installFakeOpencodeHost({ reply: () => "ok" });
    await runExecution(request());
    expect(specs[0]).toMatchObject({ kind: "opencode", isolated: false, fetchModels: true });
    expect(specs[0]?.content).toBeUndefined();
  });

  test("reads logins from the user's database when there is one, and never makes one", async () => {
    const data = makeSandboxDir("akm-user-opencode");
    try {
      await withEnv({ XDG_DATA_HOME: data.dir }, async () => {
        const { specs } = installFakeOpencodeHost({ reply: () => "ok" });
        await runExecution(request());
        expect(specs[0]?.credentialsFrom).toBeUndefined();
        expect(fs.existsSync(path.join(data.dir, "opencode"))).toBe(false);

        await (await import("../src/integrations/harnesses/opencode/embedded/host")).closeOpencodeSdk();
        fs.mkdirSync(path.join(data.dir, "opencode"));
        fs.writeFileSync(path.join(data.dir, "opencode", "opencode.db"), "");
        await runExecution(request());
        expect(specs[1]?.credentialsFrom).toBe(path.join(data.dir, "opencode", "opencode.db"));
      });
    } finally {
      data.cleanup();
    }
  });

  test("follows OPENCODE_CONFIG_DIR, which the embedded OpenCode does not read itself", async () => {
    const { specs } = installFakeOpencodeHost({ reply: () => "ok" });
    await withEnv({ OPENCODE_CONFIG_DIR: "/somewhere/else" }, () => runExecution(request()));
    expect(specs[0]?.configDirectory).toBe("/somewhere/else");
  });
});
