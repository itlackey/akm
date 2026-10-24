// Integration: opens real SQLite databases and runs the real embedded OpenCode
// against a loopback model (no network).
//
// OpenCode session history is read by the database's layout: an OpenCode 2
// file through the embedded OpenCode (`@opencode/sdk`), an OpenCode 1-only file
// through read-only SQLite. Unsupported and corrupt files are reported, never
// presented as empty. OpenCode 1 fixtures are built in-test from SQL shaped
// like the real DDL (observed from OpenCode 1.18.34); OpenCode 2 files are
// written by the embedded OpenCode itself.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { OpenCode } from "@opencode/sdk";
import { getDataDir } from "../../src/core/paths";
import { _resetWarnOnceForTests, _setWarnSinkForTests } from "../../src/core/warn";
import { OpenCodeProvider } from "../../src/integrations/harnesses/opencode/session-log";
import { opencodeMessageEvents } from "../../src/integrations/harnesses/opencode/session-log-v2";
import {
  _setOpencodeHostFactoryForTests,
  closeOpencodeSdk,
} from "../../src/integrations/harnesses/opencode-sdk/sdk-runner";
import { openDatabase } from "../../src/storage/database";
import { type FakeModelServer, startFakeModel } from "../_helpers/fake-model-server";
import { overrideSeam } from "../_helpers/seams";

const V1_DDL = `
CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, title TEXT NOT NULL, directory TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL);
CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
`;

const tempDirs: string[] = [];
let warnings: string[] = [];
let model: FakeModelServer;

function makeBase(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-opencode-store-"));
  tempDirs.push(dir);
  return dir;
}

beforeAll(() => {
  model = startFakeModel();
});

afterAll(() => model.stop());

beforeEach(() => {
  warnings = [];
  _resetWarnOnceForTests();
  overrideSeam(_setWarnSinkForTests, (level, args) => {
    if (level === "warn") warnings.push(args.map(String).join(" "));
  });
  overrideSeam(_setOpencodeHostFactoryForTests, (options) => OpenCode.create({ ...options, models: { fetch: false } }));
});

afterEach(async () => {
  await closeOpencodeSdk();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

type Db = ReturnType<typeof openDatabase>;

function v1Session(db: Db, id: string, directory: string, created: number, texts: Array<[string, string]>): void {
  db.run("INSERT INTO session VALUES (?, 'p', ?, ?, ?, ?)", id, `v1 ${id}`, directory, created, created + 100);
  texts.forEach(([role, text], i) => {
    const mid = `msg_${id}_${i}`;
    db.run(
      "INSERT INTO message VALUES (?, ?, ?, ?, ?)",
      mid,
      id,
      created + i,
      created + i,
      JSON.stringify({ role, time: { created: created + i } }),
    );
    db.run(
      "INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)",
      `prt_${mid}`,
      mid,
      id,
      created + i,
      created + i,
      JSON.stringify({ type: "text", text }),
    );
  });
}

function build(base: string, ddl: string, fill: (db: Db) => void): string {
  const dbPath = path.join(base, "opencode.db");
  const db = openDatabase(dbPath, { create: true });
  db.exec(ddl);
  fill(db);
  db.close();
  return dbPath;
}

/**
 * An OpenCode 2 database at `<base>/opencode.db`, written by the embedded
 * OpenCode: a session that ran a shell command, a model-work session, and a
 * child of the first. Returns the first session's id.
 */
async function openCode2Store(base: string): Promise<string> {
  const work = makeBase();
  const host = await OpenCode.create({
    models: { fetch: false },
    database: { path: path.join(base, "opencode.db") },
    config: {
      directory: makeBase(),
      project: false,
      claude: false,
      content: JSON.stringify({
        model: "fake/fake-model",
        provider: {
          fake: {
            npm: "@ai-sdk/openai-compatible",
            options: { baseURL: model.url, apiKey: "k" },
            models: { "fake-model": {} },
          },
        },
      }),
    },
  } as never);
  try {
    const session = (await host.sessions.create({ title: "the work", location: { directory: work } } as never)) as {
      id: string;
    };
    await host.sessions.prompt({ sessionID: session.id, text: "MODE:shell remember it" } as never);
    await host.sessions.wait({ sessionID: session.id } as never);
    await host.sessions.create({
      title: "akm model work",
      metadata: { akm: "model-work" },
      location: { directory: work },
    } as never);
    await host.sessions.create({ title: "a subagent", parentID: session.id, location: { directory: work } } as never);
    return session.id;
  } finally {
    await host.close();
  }
}

describe("OpenCode 1 store (read-only SQLite)", () => {
  test("lists and reads an OpenCode 1-only file", async () => {
    const base = makeBase();
    build(base, V1_DDL, (db) =>
      v1Session(db, "ses_v1", "/work/a", 2000, [
        ["user", "hi"],
        ["assistant", "hello"],
      ]),
    );
    const provider = new OpenCodeProvider();
    const [summary] = await provider.listSessions({ location: base });
    expect(summary).toMatchObject({ sessionId: "ses_v1", projectHint: "/work/a", title: "v1 ses_v1" });
    const data = await provider.readSession(summary as never);
    expect(data.events.map((e) => [e.role, e.text])).toEqual([
      ["user", "hi"],
      ["assistant", "hello"],
    ]);
    expect(warnings).toEqual([]);
  });
});

describe("OpenCode 2 store (embedded OpenCode)", () => {
  test("lists top-level sessions without akm's model work, and reads one with its tool calls", async () => {
    const base = makeBase();
    const id = await openCode2Store(base);
    const provider = new OpenCodeProvider();
    const sessions = await provider.listSessions({ location: base });
    expect(sessions.map((s) => [s.sessionId, s.title])).toEqual([[id, "the work"]]);
    expect(sessions[0]?.filePath).toBe(path.join(base, "opencode.db"));

    const data = await provider.readSession(sessions[0] as never);
    const texts = data.events.map((e) => [e.role, e.text]);
    expect(texts[0]).toEqual(["user", "MODE:shell remember it"]);
    expect(texts).toContainEqual(["assistant", "[tool:shell] echo HELLO"]);
    expect(texts.some(([role, text]) => role === "tool" && text?.startsWith("[tool_result] HELLO"))).toBe(true);
    expect(data.ref).toMatchObject({ sessionId: id, title: "the work" });
    expect(warnings).toEqual([]);
  });

  test("a planning listing reads a private copy and leaves nothing behind", async () => {
    const base = makeBase();
    const id = await openCode2Store(base);
    const before = fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith("akm-opencode-sessions-"));
    const sessions = await new OpenCodeProvider().listSessions({ location: base, isolatedSnapshot: true });
    expect(sessions.map((s) => s.sessionId)).toEqual([id]);
    expect(fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith("akm-opencode-sessions-"))).toEqual(before);
  });

  test("without a location, akm's own OpenCode database is read too", async () => {
    fs.mkdirSync(getDataDir(), { recursive: true });
    const id = await openCode2Store(getDataDir());
    try {
      const sessions = await new OpenCodeProvider().listSessions();
      expect(sessions.map((s) => s.sessionId)).toContain(id);
    } finally {
      await closeOpencodeSdk();
      for (const suffix of ["", "-wal", "-shm"])
        fs.rmSync(path.join(getDataDir(), `opencode.db${suffix}`), { force: true });
    }
  });

  test("messages map to events: text, tool calls and their results, in order", () => {
    const { events, inlineRefs } = opencodeMessageEvents(
      [
        { type: "user", time: { created: 1001 }, text: "remember the vpn thing", files: [] },
        {
          type: "assistant",
          time: { created: 1002 },
          content: [
            { type: "reasoning", text: "thinking" },
            { type: "text", text: "Saving that." },
            {
              type: "tool",
              name: "shell",
              time: { created: 1003, completed: 1004 },
              state: {
                status: "completed",
                input: { command: 'akm remember "vpn needs the corp cert"' },
                content: [{ type: "text", text: "saved" }],
              },
            },
            {
              type: "tool",
              name: "read",
              time: { created: 1005 },
              state: { status: "running", input: { path: "a.ts" } },
            },
            {
              type: "tool",
              name: "write",
              time: { created: 1006, completed: 1007 },
              state: { status: "error", input: { path: "b.ts" }, error: { type: "tool.failed", message: "denied" } },
            },
          ],
        },
        { type: "idle", time: { created: 1008 }, outcome: "succeeded" },
        "not a message",
      ],
      "opencode",
      "ses_x",
      "/db",
    );
    expect(events.map((e) => [e.role, e.text])).toEqual([
      ["user", "remember the vpn thing"],
      ["assistant", "Saving that."],
      ["assistant", '[tool:shell] akm remember "vpn needs the corp cert"'],
      ["tool", "[tool_result] saved"],
      ["assistant", '[tool:read] {"path":"a.ts"}'],
      ["assistant", '[tool:write] {"path":"b.ts"}'],
      ["tool", "[tool_result] denied"],
    ]);
    expect(inlineRefs).toEqual([{ kind: "remember", text: "vpn needs the corp cert", ts: 1003 }]);
  });
});

describe("missing versus incompatible history", () => {
  test("no database file is silently empty", async () => {
    expect(await new OpenCodeProvider().listSessions({ location: makeBase() })).toEqual([]);
    expect(warnings).toEqual([]);
  });

  test("an unknown schema is reported, not presented as an empty list", async () => {
    const base = makeBase();
    build(base, "CREATE TABLE unrelated (x TEXT);", () => {});
    expect(await new OpenCodeProvider().listSessions({ location: base })).toEqual([]);
    expect(warnings.some((w) => w.includes("not an empty history"))).toBe(true);
  });

  test("a corrupt file is reported", async () => {
    const base = makeBase();
    fs.writeFileSync(path.join(base, "opencode.db"), "this is not a sqlite database".repeat(50));
    expect(await new OpenCodeProvider().listSessions({ location: base })).toEqual([]);
    expect(warnings.some((w) => w.includes("not an empty history"))).toBe(true);
  });
});
