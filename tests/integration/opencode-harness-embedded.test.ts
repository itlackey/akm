// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Integration: runs the real embedded OpenCode, which opens its own SQLite
// database, against a fake model served on 127.0.0.1. The opencode harness on
// OpenCode 2: no OpenCode binary and no external network. The user's config,
// default model and logins reach the run; their database is read, never written
// with akm's sessions, and left as it was; and model work is confined.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { OpenCode } from "@opencode/sdk";
import { harnessProfile } from "../../src/integrations/agent/profiles";
import {
  _setOpencodeHostFactoryForTests,
  closeOpencodeSdk,
} from "../../src/integrations/harnesses/opencode/embedded/host";
import { runOpencodeHarness } from "../../src/integrations/harnesses/opencode/embedded/run";
import { createSdkHost } from "../../src/integrations/harnesses/opencode/embedded/sdk-host";
import { akmOpencodeDatabasePath } from "../../src/integrations/harnesses/opencode/roots";
import { openDatabase } from "../../src/storage/database";
import { type FakeModelServer, startFakeModel } from "../_helpers/fake-model-server";
import { makeSandboxDir, type SandboxedDir, withEnv, withEnvSync } from "../_helpers/sandbox";
import { overrideSeam } from "../_helpers/seams";

const profile = harnessProfile({
  kind: "harness",
  name: "opencode",
  platform: "opencode",
  bin: "opencode",
  args: ["run"],
  timeoutMs: null,
});

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

/** The user's OpenCode database after they logged in with the pinned OpenCode: a key stored for the fake provider. */
async function theirDatabase(name: string): Promise<{ data: string; userDb: string }> {
  const data = path.join(sandbox.dir, name);
  const userDb = path.join(data, "opencode", "opencode.db");
  fs.mkdirSync(path.dirname(userDb), { recursive: true });
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
  return { data, userDb };
}

/** Edit the user's database as another OpenCode release would have left it. */
function edit(file: string, change: (db: ReturnType<typeof openDatabase>) => void): void {
  const db = openDatabase(file);
  try {
    change(db);
  } finally {
    db.close();
  }
}

/** The file's bytes, mode and migration ledger. */
function fileState(file: string): { sha256: string; mode: number; ledger: string[] } {
  const sha256 = createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  const mode = fs.statSync(file).mode & 0o777;
  const db = openDatabase(file, { readonly: true, create: false });
  try {
    const ledger = db.prepare<{ id: string }>("SELECT id FROM migration ORDER BY id").all();
    return { sha256, mode, ledger: ledger.map((row) => row.id) };
  } finally {
    db.close();
  }
}

const run = (config: string, prompt: string, dispatch: Record<string, unknown> = {}, env?: Record<string, string>) =>
  withEnv({ OPENCODE_CONFIG_DIR: config }, () =>
    runOpencodeHarness(profile, {
      cwd: work,
      timeoutMs: 60_000,
      ...(env ? { env } : {}),
      dispatch: { ...dispatch, prompt },
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

  test("signs in with the logins in their database, and leaves it as it was", async () => {
    const { data, userDb } = await theirDatabase("xdg-data-logins");
    const state = fileState(userDb);
    // A cold start: akm has no OpenCode database of its own yet.
    expect(fs.existsSync(withEnvSync({ XDG_DATA_HOME: data }, akmOpencodeDatabasePath))).toBe(false);

    const before = model.requests.length;
    const result = await withEnv({ XDG_DATA_HOME: data }, () => run(userConfig(), "MODE:answer signed in"));
    expect(result.ok).toBe(true);
    expect(model.requests.slice(before).find((r) => r.mode === "answer")?.authorization).toBe("Bearer sk-their-login");
    await closeOpencodeSdk();
    expect(fileState(userDb)).toEqual(state);

    // A warm start: akm's database holds the earlier copy, and the user's login has changed since.
    edit(userDb, (db) =>
      db.run("UPDATE credential SET value = ?", JSON.stringify({ type: "key", key: "sk-their-new-login" })),
    );
    const changed = fileState(userDb);
    const again = model.requests.length;
    const second = await withEnv({ XDG_DATA_HOME: data }, () => run(userConfig(), "MODE:answer signed in again"));
    expect(second.ok).toBe(true);
    expect(model.requests.slice(again).find((r) => r.mode === "answer")?.authorization).toBe(
      "Bearer sk-their-new-login",
    );
    await closeOpencodeSdk();
    expect(fileState(userDb)).toEqual(changed);
  });

  test("signs in with the logins of a database a newer OpenCode wrote, and leaves it as it was", async () => {
    const { data, userDb } = await theirDatabase("xdg-data-newer");
    edit(userDb, (db) =>
      db.run("INSERT INTO migration (id, time_completed) VALUES (?, ?)", "29991231000000_from_a_newer_opencode", 1),
    );
    const state = fileState(userDb);

    const before = model.requests.length;
    const result = await withEnv({ XDG_DATA_HOME: data }, () => run(userConfig(), "MODE:answer newer database"));
    expect(result.ok).toBe(true);
    expect(model.requests.slice(before).find((r) => r.mode === "answer")?.authorization).toBe("Bearer sk-their-login");
    await closeOpencodeSdk();
    expect(fileState(userDb)).toEqual(state);
  });

  test("signs in with the logins of a database an older OpenCode wrote, and leaves it as it was", async () => {
    const { data, userDb } = await theirDatabase("xdg-data-older");
    // As OpenCode 2.0.26 leaves it: without the embedded OpenCode's newest migration.
    edit(userDb, (db) => {
      db.run("DELETE FROM migration WHERE id = ?", "20261010180456_project_time_archived");
      db.exec("ALTER TABLE project DROP COLUMN time_archived");
    });
    const state = fileState(userDb);

    const before = model.requests.length;
    const result = await withEnv({ XDG_DATA_HOME: data }, () => run(userConfig(), "MODE:answer older database"));
    expect(result.ok).toBe(true);
    expect(model.requests.slice(before).find((r) => r.mode === "answer")?.authorization).toBe("Bearer sk-their-login");
    await closeOpencodeSdk();
    expect(fileState(userDb)).toEqual(state);
  });

  test("with no stored logins, runs without them and leaves the file as it was", async () => {
    const { data, userDb } = await theirDatabase("xdg-data-no-logins");
    edit(userDb, (db) => db.exec("DELETE FROM credential"));
    const state = fileState(userDb);

    const before = model.requests.length;
    const result = await withEnv({ XDG_DATA_HOME: data }, () => run(userConfig(), "MODE:answer no logins"));
    expect(result.ok).toBe(true);
    expect(model.requests.slice(before).find((r) => r.mode === "answer")?.authorization).toBeUndefined();
    await closeOpencodeSdk();
    expect(fileState(userDb)).toEqual(state);
  });

  test("passes the run's environment to the commands it runs, and nothing the harness's allowlist leaves out", async () => {
    const result = await withEnv({ AKM_AMBIENT: "ambient" }, () =>
      run(userConfig({ apiKey: "user-key" }), "MODE:env go", {}, { AKM_PROBE: "from-akm" }),
    );
    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("PROBE=from-akm AMBIENT= HOME=");
    expect(result.stdout).not.toContain("ambient");
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
