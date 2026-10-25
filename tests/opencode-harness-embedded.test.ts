// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// The opencode harness on OpenCode 2 against the real embedded OpenCode and a
// loopback fake model: no binary, no network. The user's config, default model
// and logins reach the run; their database is read, never written with akm's
// sessions; and model work is confined.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { OpenCode } from "@opencode/sdk";
import type { AgentProfile } from "../src/integrations/agent/profiles";
import {
  _setOpencodeHostFactoryForTests,
  closeOpencodeSdk,
} from "../src/integrations/harnesses/opencode/embedded/host";
import { akmOpencodeDatabasePath } from "../src/integrations/harnesses/opencode/embedded/host-spec";
import { runOpencodeHarness } from "../src/integrations/harnesses/opencode/embedded/run";
import { createSdkHost } from "../src/integrations/harnesses/opencode/embedded/sdk-host";
import { openDatabase } from "../src/storage/database";
import { type FakeModelServer, startFakeModel } from "./_helpers/fake-model-server";
import { makeSandboxDir, type SandboxedDir, withEnv } from "./_helpers/sandbox";
import { overrideSeam } from "./_helpers/seams";

const profile: AgentProfile = {
  name: "opencode",
  platform: "opencode",
  bin: "opencode",
  args: ["run"],
  stdio: "captured",
  envPassthrough: [],
  parseOutput: "text",
};

let model: FakeModelServer;
let sandbox: SandboxedDir;
let work: string;

beforeAll(() => {
  model = startFakeModel();
  sandbox = makeSandboxDir("akm-opencode-harness");
  work = path.join(sandbox.dir, "work");
  fs.mkdirSync(work);
});

afterAll(async () => {
  await closeOpencodeSdk();
  // The suite's data directory is shared with the files that run after this one.
  for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(`${akmOpencodeDatabasePath()}${suffix}`, { force: true });
  model.stop();
  sandbox.cleanup();
});

// The user's OpenCode, kept off the network: no model catalog fetch.
beforeEach(() =>
  overrideSeam(_setOpencodeHostFactoryForTests, (spec) => createSdkHost({ ...spec, fetchModels: false })),
);

let n = 0;
/** The user's config directory with a provider on the fake model, selected by default. */
function userConfig(options: Record<string, unknown> = {}, select = true): string {
  const dir = path.join(sandbox.dir, `config-${++n}`);
  fs.mkdirSync(dir);
  fs.writeFileSync(
    path.join(dir, "opencode.json"),
    JSON.stringify({
      ...(select ? { model: "userfake/fake-model" } : {}),
      provider: {
        userfake: {
          npm: "@ai-sdk/openai-compatible",
          options: { baseURL: model.url, ...options },
          models: { "fake-model": {} },
        },
      },
    }),
  );
  return dir;
}

const run = (config: string, prompt: string, dispatch: Record<string, unknown> = {}, env?: Record<string, string>) =>
  withEnv({ OPENCODE_CONFIG_DIR: config }, () =>
    runOpencodeHarness(profile, prompt, {
      cwd: work,
      timeoutMs: 60_000,
      ...(env ? { env } : {}),
      dispatch: { prompt: "", ...dispatch },
    }),
  );

describe("a run on the user's OpenCode 2", () => {
  test("uses their config's provider and default model when akm names none", async () => {
    const before = model.requests.length;
    const result = await run(userConfig({ apiKey: "user-key" }), "MODE:answer from the default model");
    expect(result.ok).toBe(true);
    expect(result.stdout).toMatch(/^ANSWER-\d+$/);
    expect(model.requests.slice(before).find((r) => r.mode === "answer")?.authorization).toBe("Bearer user-key");
  });

  test("runs the model akm names, as provider/model", async () => {
    const config = userConfig({ apiKey: "user-key" }, false);
    const result = await run(config, "MODE:answer named model", { model: "userfake/fake-model" });
    expect(result.ok).toBe(true);
    expect(result.stdout).toMatch(/^ANSWER-\d+$/);
  });

  test("keeps its session in akm's database, not theirs", async () => {
    const data = path.join(sandbox.dir, "xdg-data");
    const userDb = path.join(data, "opencode", "opencode.db");
    fs.mkdirSync(path.dirname(userDb), { recursive: true });
    const seed = await OpenCode.create({
      database: { path: userDb },
      models: { fetch: false },
      config: { directory: userConfig(), project: false, claude: false },
    } as never);
    await seed.close();
    const sessionsIn = (file: string): number => {
      const db = openDatabase(file, { readonly: true, create: false });
      try {
        return db.prepare<{ n: number }>("SELECT count(*) AS n FROM session_v2").get()?.n ?? 0;
      } finally {
        db.close();
      }
    };
    const result = await withEnv({ XDG_DATA_HOME: data }, () =>
      run(userConfig({ apiKey: "user-key" }), "MODE:answer where do I live"),
    );
    expect(result.ok).toBe(true);
    expect(sessionsIn(userDb)).toBe(0);
    expect(sessionsIn(akmOpencodeDatabasePath())).toBeGreaterThan(0);
  });

  test("signs in with the logins in their database", async () => {
    const data = path.join(sandbox.dir, "xdg-data-logins");
    const userDb = path.join(data, "opencode", "opencode.db");
    fs.mkdirSync(path.dirname(userDb), { recursive: true });
    // Their OpenCode stored a key for the provider when they logged in.
    const theirs = await OpenCode.create({
      database: { path: userDb },
      models: { fetch: false },
      config: { directory: userConfig(), project: false, claude: false },
    } as never);
    await theirs.credential.create({
      integrationID: "userfake",
      label: "default",
      value: { type: "key", key: "sk-their-login" },
    } as never);
    await theirs.close();

    const before = model.requests.length;
    const result = await withEnv({ XDG_DATA_HOME: data }, () => run(userConfig(), "MODE:answer signed in"));
    expect(result.ok).toBe(true);
    expect(model.requests.slice(before).find((r) => r.mode === "answer")?.authorization).toBe("Bearer sk-their-login");
  });

  test("passes the run's environment to the commands it runs", async () => {
    const result = await run(userConfig({ apiKey: "user-key" }), "MODE:env go", {}, { AKM_PROBE: "from-akm" });
    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("PROBE=from-akm");
  });
});

describe("model work on the user's OpenCode 2", () => {
  test("gets OpenCode's read-only tools and akm's, and cannot change anything", async () => {
    const bundle = path.join(process.env.HOME ?? "", "akm");
    fs.mkdirSync(bundle, { recursive: true });
    try {
      const result = await run(userConfig({ apiKey: "user-key" }), "MODE:akm go", { modelWork: true });
      expect(result.ok).toBe(true);
      const offered = model.requests.filter((r) => r.mode === "akm")[0]?.tools ?? [];
      expect(offered).toEqual(expect.arrayContaining(["read", "grep", "glob", "akm_search", "akm_show", "akm_curate"]));
      for (const tool of ["edit", "write", "shell", "execute", "subagent"]) expect(offered).not.toContain(tool);
    } finally {
      fs.rmSync(bundle, { recursive: true, force: true });
    }
  });

  test("cannot write", async () => {
    const result = await run(userConfig({ apiKey: "user-key" }), "MODE:write go", { modelWork: true });
    expect(result.stdout).toContain("No tool named");
  });
});
