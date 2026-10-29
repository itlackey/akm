// Integration: opens real SQLite databases (and, to write the OpenCode 2 fixture,
// runs the real OpenCode binary through akm's own runtime against a loopback model;
// no network once the binary is cached).
//
// OpenCode session history is read from the database's tables with SQLite alone,
// by the file's layout: the OpenCode 2 tables or the OpenCode 1 ones. Nothing
// starts OpenCode on a file being read. Unsupported and corrupt files are
// reported, never presented as empty. OpenCode 2 files are written by OpenCode
// itself, through akm's runtime; the OpenCode 1 layout is covered in
// tests/session-logs-providers.test.ts.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hashSessionContent } from "../../src/commands/improve/extract";
import { _resetWarnOnceForTests, _setWarnSinkForTests } from "../../src/core/warn";
import { runtimeProfile } from "../../src/integrations/agent/profiles";
import type { ConnectionRunner } from "../../src/integrations/agent/runner";
import { buildChildEnv, runBuiltCommand } from "../../src/integrations/agent/spawn";
import { opencodeBuilder } from "../../src/integrations/harnesses/opencode/agent-builder";
import { akmOpencodeDatabasePath, akmRuntimeDir } from "../../src/integrations/harnesses/opencode/roots";
import { opencodeRuntime } from "../../src/integrations/harnesses/opencode/runtime";
import { runtimeBinaryPath } from "../../src/integrations/harnesses/opencode/runtime/binary";
import { runtimeConfig, runtimeEnv } from "../../src/integrations/harnesses/opencode/runtime/command";
import { OpenCodeProvider } from "../../src/integrations/harnesses/opencode/session-log";
import { opencodeMessageEvents } from "../../src/integrations/harnesses/opencode/session-log-v2";
import { openDatabase } from "../../src/storage/database";
import { type FakeModelServer, startFakeModel } from "../_helpers/fake-model-server";
import { useRealOpencodeRuntime } from "../_helpers/fake-opencode-runtime";
import { fetchSharedOpencode, linkSharedOpencode } from "../_helpers/opencode-binary";
import { withEnv } from "../_helpers/sandbox";
import { overrideSeam } from "../_helpers/seams";

const unavailable = await fetchSharedOpencode();
if (unavailable) console.warn(`[opencode-session-store] skipped: the OpenCode binary is not available: ${unavailable}`);

const tempDirs: string[] = [];
let warnings: string[] = [];
let model: FakeModelServer;
/** The OpenCode 2 database akm's runtime wrote, and the sessions in it. */
let fixture: OpenCode2Fixture | undefined;

function makeBase(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-opencode-store-"));
  tempDirs.push(dir);
  return dir;
}

beforeAll(async () => {
  if (unavailable !== undefined) return;
  model = startFakeModel();
  fixture = await writeOpenCode2Store();
}, 120_000);

afterAll(() => {
  model?.stop();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  warnings = [];
  _resetWarnOnceForTests();
  overrideSeam(_setWarnSinkForTests, (level, args) => {
    if (level === "warn") warnings.push(args.map(String).join(" "));
  });
});

type Db = ReturnType<typeof openDatabase>;

function build(base: string, ddl: string, fill: (db: Db) => void): string {
  const dbPath = path.join(base, "opencode.db");
  const db = openDatabase(dbPath, { create: true });
  db.exec(ddl);
  fill(db);
  db.close();
  return dbPath;
}

interface OpenCode2Fixture {
  /** The directory holding the runtime's `opencode.db`. */
  readonly directory: string;
  /** The "the work" session, which ran a shell command. */
  readonly first: string;
  /** Every top-level session that is not akm's model work. */
  readonly ids: string[];
}

/**
 * An OpenCode 2 database written by OpenCode itself, through akm's runtime: sessions that ran a shell command, wrote a
 * file, were compacted mid-turn, were cut at the output limit and named an agent, one that started a subagent, then a
 * model-work session, run the way the opencode harness runs model work on a user's OpenCode 2. The model-work session
 * and the subagent's are not history.
 */
async function writeOpenCode2Store(): Promise<OpenCode2Fixture> {
  const root = makeBase();
  const work = path.join(root, "work");
  fs.mkdirSync(work, { recursive: true });
  const cache = path.join(root, "cache");
  linkSharedOpencode(cache);
  const profile = runtimeProfile({ name: "lab" } as ConnectionRunner);
  // A declared window lets the model's "compact" mode make OpenCode compact the conversation.
  const connection = {
    endpoint: model.url,
    model: "fake-model",
    contextLength: 40_000,
    request: { max_tokens: 4_000 },
  };
  return withEnv(
    { AKM_DATA_DIR: path.join(root, "data"), AKM_CACHE_DIR: cache, AKM_STATE_DIR: path.join(root, "state") },
    async () => {
      useRealOpencodeRuntime();
      const directory = path.dirname(akmOpencodeDatabasePath());
      const ids: string[] = [];
      const turn = async (mode: string, dispatch: { agent?: string } = {}): Promise<void> => {
        const result = await opencodeRuntime.run(
          profile,
          { cwd: work, timeoutMs: 90_000, dispatch: { prompt: `MODE:${mode} go`, ...dispatch } },
          connection,
        );
        if (!result.ok) throw new Error(`the fixture run MODE:${mode} failed: ${result.error}\n${result.stderr}`);
      };
      /** The sessions in the database, oldest first. */
      const sessions = () => {
        const db = openDatabase(path.join(directory, "opencode.db"), { readonly: true, create: false });
        try {
          return db
            .prepare<{ id: string; agent: string | null; parent_id: string | null }>(
              "SELECT id, agent, parent_id FROM session_v2 ORDER BY time_created",
            )
            .all();
        } finally {
          db.close();
        }
      };
      await turn("shell");
      const first = sessions()[0]?.id as string;
      await turn("write");
      await turn("compact");
      await turn("length");
      await turn("answer", { agent: "build" });
      await turn("subagent");
      // The opencode harness's model work, on the same binary and database: its read-only agent, over the runtime's provider.
      const locations = {
        binary: runtimeBinaryPath(),
        directory: akmRuntimeDir(),
        pluginDirectory: path.join(akmRuntimeDir(), "config", "akm-plugin"),
        akm: [],
      };
      const runtime = runtimeEnv(runtimeConfig(connection, locations.pluginDirectory, ""), locations);
      const modelWork = await withEnv(runtime, () =>
        opencodeBuilder.build(
          { bin: locations.binary, args: [] },
          { prompt: "MODE:answer go", model: "akm/fake-model", modelWork: true },
        ),
      );
      const result = await runBuiltCommand(
        "model work",
        { argv: modelWork.argv, env: { ...buildChildEnv({}), ...runtime, ...modelWork.env }, stdin: modelWork.stdin },
        { cwd: work, timeoutMs: 90_000 },
      );
      if (!result.ok) throw new Error(`the fixture's model work failed: ${result.error}\n${result.stderr}`);
      for (const session of sessions())
        if (session.agent !== "akm-model-work" && session.parent_id === null) ids.push(session.id);
      return { directory, first, ids };
    },
  );
}

/** The fixture's database files, copied to `base` (a database a reader can be pointed at and compared with). */
function copyFixtureTo(base: string): void {
  const source = (fixture as OpenCode2Fixture).directory;
  fs.mkdirSync(base, { recursive: true });
  for (const name of ["opencode.db", "opencode.db-wal", "opencode.db-shm"]) {
    if (fs.existsSync(path.join(source, name))) fs.copyFileSync(path.join(source, name), path.join(base, name));
  }
}

const fileBytes = (file: string): string => (fs.existsSync(file) ? fs.readFileSync(file).toString("base64") : "");

describe.skipIf(unavailable !== undefined)("OpenCode 2 store (read with SQLite alone)", () => {
  test("lists top-level sessions without akm's model work, and reads one with its tool calls", async () => {
    const { first, ids } = fixture as OpenCode2Fixture;
    const base = makeBase();
    copyFixtureTo(base);
    // The file holds the model-work session, one of another agent and a subagent's, so the listing below is not vacuous.
    const store = openDatabase(path.join(base, "opencode.db"), { readonly: true, create: false });
    const agents = store
      .prepare<{ agent: string }>("SELECT DISTINCT agent FROM session_v2 WHERE agent IS NOT NULL")
      .all();
    const children = store.prepare<{ id: string }>("SELECT id FROM session_v2 WHERE parent_id IS NOT NULL").all();
    store.close();
    expect(agents.map((row) => row.agent).sort()).toEqual(["akm-model-work", "build", "general"]);
    expect(children.length).toBeGreaterThan(0);
    const provider = new OpenCodeProvider();
    const sessions = await provider.listSessions({ location: base });
    expect(sessions.map((s) => s.sessionId).sort()).toEqual([...ids].sort());
    expect(sessions.find((s) => s.sessionId === first)).toMatchObject({
      title: "akm",
      filePath: path.join(base, "opencode.db"),
    });

    const data = await provider.readSession(sessions.find((s) => s.sessionId === first) as never);
    const texts = data.events.map((e) => [e.role, e.text]);
    expect(texts[0]).toEqual(["user", "MODE:shell go"]);
    expect(texts).toContainEqual(["assistant", "[tool:shell] echo HELLO"]);
    expect(texts.some(([role, text]) => role === "tool" && text?.startsWith("[tool_result] HELLO"))).toBe(true);
    expect(data.ref).toMatchObject({ sessionId: first, title: "akm" });
    expect(warnings).toEqual([]);
  });

  test("every session reads to events, and reading it again gives the same content hash", async () => {
    // The hash is the skip authority for "already extracted": a reader that changed it would extract every session again.
    const base = makeBase();
    copyFixtureTo(base);
    const store = openDatabase(path.join(base, "opencode.db"), { readonly: true, create: false });
    const types = store.prepare<{ type: string }>("SELECT DISTINCT type FROM session_message").all();
    store.close();
    expect(types.map((row) => row.type)).toEqual(expect.arrayContaining(["user", "assistant", "compaction", "idle"]));
    const provider = new OpenCodeProvider();
    const sessions = await provider.listSessions({ location: base });
    expect(sessions).toHaveLength((fixture as OpenCode2Fixture).ids.length);
    for (const session of sessions) {
      const once = await provider.readSession(session as never);
      const again = await provider.readSession(session as never);
      expect(once.events.length).toBeGreaterThan(0);
      expect(hashSessionContent(once)).toBe(hashSessionContent(again));
    }
  });

  test("reading leaves the database as it was", async () => {
    const base = makeBase();
    copyFixtureTo(base);
    const db = path.join(base, "opencode.db");
    const before = [fileBytes(db), fileBytes(`${db}-wal`)];
    const provider = new OpenCodeProvider();
    for (const session of await provider.listSessions({ location: base })) await provider.readSession(session as never);
    await provider.listSessions({ location: base, isolatedSnapshot: true });
    expect([fileBytes(db), fileBytes(`${db}-wal`)]).toEqual(before);
  });

  test("a planning listing reads a private copy and lists the same sessions", async () => {
    const base = makeBase();
    copyFixtureTo(base);
    const sessions = await new OpenCodeProvider().listSessions({ location: base, isolatedSnapshot: true });
    expect(sessions.map((s) => s.sessionId).sort()).toEqual([...(fixture as OpenCode2Fixture).ids].sort());
  });

  test("without a location, akm's own OpenCode database is read too", async () => {
    const { first } = fixture as OpenCode2Fixture;
    const own = path.dirname(akmOpencodeDatabasePath());
    copyFixtureTo(own);
    try {
      const sessions = await new OpenCodeProvider().listSessions();
      expect(sessions.map((s) => s.sessionId)).toContain(first);
    } finally {
      fs.rmSync(path.dirname(own), { recursive: true, force: true });
    }
  });

  test("a session that is not in the file, or a file with no session tables, fails to read", async () => {
    const base = makeBase();
    copyFixtureTo(base);
    const { first } = fixture as OpenCode2Fixture;
    const provider = new OpenCodeProvider();
    const ref = { harness: "opencode", sessionId: first, filePath: path.join(base, "opencode.db") };
    await expect(provider.readSession({ ...ref, sessionId: "ses_missing" })).rejects.toThrow("is not in the file");
    const other = makeBase();
    build(other, "CREATE TABLE unrelated (x TEXT);", () => {});
    await expect(provider.readSession({ ...ref, filePath: path.join(other, "opencode.db") })).rejects.toThrow(
      "no supported OpenCode 1 or OpenCode 2 session tables",
    );
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
