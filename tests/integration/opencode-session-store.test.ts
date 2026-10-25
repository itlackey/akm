// Integration: opens real SQLite databases (and, to write the OpenCode 2 fixture,
// the real embedded OpenCode against a loopback model; no network).
//
// OpenCode session history is read from the database's tables with SQLite alone,
// by the file's layout: the OpenCode 2 tables or the OpenCode 1 ones. Nothing
// starts OpenCode on a file being read. Unsupported and corrupt files are
// reported, never presented as empty. OpenCode 2 files are written by the
// embedded OpenCode itself; the OpenCode 1 layout is covered in
// tests/session-logs-providers.test.ts.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { OpenCode } from "@opencode/sdk";
import { hashSessionContent } from "../../src/commands/improve/extract";
import { getDataDir } from "../../src/core/paths";
import { _resetWarnOnceForTests, _setWarnSinkForTests } from "../../src/core/warn";
import { OpenCodeProvider } from "../../src/integrations/harnesses/opencode/session-log";
import { opencodeMessageEvents } from "../../src/integrations/harnesses/opencode/session-log-v2";
import type { SessionData } from "../../src/integrations/session-logs/types";
import { openDatabase } from "../../src/storage/database";
import { type FakeModelServer, startFakeModel } from "../_helpers/fake-model-server";
import { overrideSeam } from "../_helpers/seams";

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
});

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
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

const FAKE_PROVIDER_CONFIG = (): string =>
  JSON.stringify({
    model: "fake/fake-model",
    provider: {
      fake: {
        npm: "@ai-sdk/openai-compatible",
        options: { baseURL: model.url, apiKey: "k" },
        // A declared window lets the model's "compact" mode make OpenCode compact the conversation.
        models: { "fake-model": { limit: { context: 40000, output: 4000 } } },
      },
    },
  });

function openFixtureHost(base: string) {
  return OpenCode.create({
    models: { fetch: false },
    database: { path: path.join(base, "opencode.db") },
    config: { directory: makeBase(), project: false, claude: false, content: FAKE_PROVIDER_CONFIG() },
  } as never);
}

interface OpenCode2Fixture {
  /** The "the work" session, which ran a shell command. */
  readonly first: string;
  /** Every top-level session that is not akm's model work. */
  readonly ids: string[];
}

/**
 * An OpenCode 2 database at `<base>/opencode.db`, written by the embedded
 * OpenCode: sessions that ran a shell command, were refused a write, were
 * compacted mid-turn, were cut at the output limit and ran a shell message of
 * their own, then a model-work session and a child of the first, which are not
 * history.
 */
async function openCode2Store(base: string): Promise<OpenCode2Fixture> {
  const work = makeBase();
  const host = await openFixtureHost(base);
  try {
    const ids: string[] = [];
    const turn = async (title: string, text: string, extra: Record<string, unknown> = {}): Promise<string> => {
      const session = (await host.sessions.create({ title, location: { directory: work }, ...extra } as never)) as {
        id: string;
      };
      await host.sessions.prompt({ sessionID: session.id, text } as never);
      await host.sessions.wait({ sessionID: session.id } as never);
      ids.push(session.id);
      return session.id;
    };
    const first = await turn("the work", "MODE:shell remember it");
    await turn("refused", "MODE:write go", {
      permissions: [{ action: "edit", resource: "*", effect: "deny" }],
    });
    await turn("compacted", "MODE:compact go");
    await turn("cut off", "MODE:length go");
    const direct = await turn("direct shell", "MODE:answer hello");
    await host.sessions.shell({ sessionID: direct, command: "echo direct" } as never);
    await host.sessions.wait({ sessionID: direct } as never);
    await host.sessions.create({
      title: "akm model work",
      metadata: { akm: "model-work" },
      location: { directory: work },
    } as never);
    await host.sessions.create({ title: "a subagent", parentID: first, location: { directory: work } } as never);
    return { first, ids };
  } finally {
    await host.close();
  }
}

/** The events OpenCode's own decoding of a session's messages gives, from a copy of the database (what history read before). */
async function decodedByOpenCode(copy: string, sessionId: string): Promise<SessionData> {
  const host = await openFixtureHost(copy);
  try {
    const messages: unknown[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = (await host.message.list({
        sessionID: sessionId,
        limit: 200,
        ...(cursor ? { cursor } : { order: "asc" }),
      } as never)) as { data: unknown[]; cursor?: { next?: string | null } };
      messages.push(...page.data);
      if (!page.cursor?.next || page.data.length === 0) break;
      cursor = page.cursor.next;
    }
    const filePath = path.join(copy, "opencode.db");
    const { events, inlineRefs } = opencodeMessageEvents(messages, "opencode", sessionId, filePath);
    return { ref: { harness: "opencode", sessionId, filePath }, events, inlineRefs };
  } finally {
    await host.close();
  }
}

const fileBytes = (file: string): string => (fs.existsSync(file) ? fs.readFileSync(file).toString("base64") : "");

describe("OpenCode 2 store (read with SQLite alone)", () => {
  test("lists top-level sessions without akm's model work, and reads one with its tool calls", async () => {
    const base = makeBase();
    const { first, ids } = await openCode2Store(base);
    const provider = new OpenCodeProvider();
    const sessions = await provider.listSessions({ location: base });
    expect(sessions.map((s) => s.sessionId).sort()).toEqual([...ids].sort());
    expect(sessions.find((s) => s.sessionId === first)).toMatchObject({
      title: "the work",
      filePath: path.join(base, "opencode.db"),
    });

    const data = await provider.readSession(sessions.find((s) => s.sessionId === first) as never);
    const texts = data.events.map((e) => [e.role, e.text]);
    expect(texts[0]).toEqual(["user", "MODE:shell remember it"]);
    expect(texts).toContainEqual(["assistant", "[tool:shell] echo HELLO"]);
    expect(texts.some(([role, text]) => role === "tool" && text?.startsWith("[tool_result] HELLO"))).toBe(true);
    expect(data.ref).toMatchObject({ sessionId: first, title: "the work" });
    expect(warnings).toEqual([]);
  });

  test("every session has the content hash OpenCode's own decoding of its messages gave", async () => {
    // The hash is the skip authority for "already extracted": a reader that changed it would extract every session again.
    const base = makeBase();
    const { ids } = await openCode2Store(base);
    const copy = makeBase();
    for (const name of ["opencode.db", "opencode.db-wal", "opencode.db-shm"]) {
      if (fs.existsSync(path.join(base, name))) fs.copyFileSync(path.join(base, name), path.join(copy, name));
    }
    const store = openDatabase(path.join(base, "opencode.db"), { readonly: true, create: false });
    const types = store.prepare<{ type: string }>("SELECT DISTINCT type FROM session_message").all();
    store.close();
    expect(types.map((row) => row.type)).toEqual(
      expect.arrayContaining(["user", "assistant", "shell", "compaction", "idle"]),
    );
    const provider = new OpenCodeProvider();
    const sessions = await provider.listSessions({ location: base });
    expect(sessions).toHaveLength(ids.length);
    for (const session of sessions) {
      const raw = await provider.readSession(session as never);
      const decoded = await decodedByOpenCode(copy, session.sessionId);
      expect(raw.events.length).toBeGreaterThan(0);
      expect(hashSessionContent(raw)).toBe(hashSessionContent(decoded));
    }
  });

  test("reading leaves the database as it was", async () => {
    const base = makeBase();
    await openCode2Store(base);
    const db = path.join(base, "opencode.db");
    const before = [fileBytes(db), fileBytes(`${db}-wal`)];
    const provider = new OpenCodeProvider();
    for (const session of await provider.listSessions({ location: base })) await provider.readSession(session as never);
    await provider.listSessions({ location: base, isolatedSnapshot: true });
    expect([fileBytes(db), fileBytes(`${db}-wal`)]).toEqual(before);
  });

  test("a planning listing reads a private copy and lists the same sessions", async () => {
    const base = makeBase();
    const { ids } = await openCode2Store(base);
    const sessions = await new OpenCodeProvider().listSessions({ location: base, isolatedSnapshot: true });
    expect(sessions.map((s) => s.sessionId).sort()).toEqual([...ids].sort());
  });

  test("without a location, akm's own OpenCode database is read too", async () => {
    fs.mkdirSync(getDataDir(), { recursive: true });
    const { first } = await openCode2Store(getDataDir());
    try {
      const sessions = await new OpenCodeProvider().listSessions();
      expect(sessions.map((s) => s.sessionId)).toContain(first);
    } finally {
      for (const suffix of ["", "-wal", "-shm"])
        fs.rmSync(path.join(getDataDir(), `opencode.db${suffix}`), { force: true });
    }
  });

  test("a session that is not in the file, or a file with no session tables, fails to read", async () => {
    const base = makeBase();
    const { first } = await openCode2Store(base);
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
