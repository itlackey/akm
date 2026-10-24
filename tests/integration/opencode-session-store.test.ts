// Integration: opens real SQLite databases (clause: opens a real database; the
// gated cases also spawn a real `opencode` binary).
//
// OpenCode session history is read from the stored schema, never from the
// installed binary's version: a V1 file (session/message/part), a V2 file
// (session_v2/session_message), a natively upgraded file holding both, WAL
// content, and unsupported/corrupt files that must be reported, not look empty.
// Fixtures are built in-test from SQL scripts shaped like the real DDL
// (observed from OpenCode 1.18.34, 2.0.26 and 2.1.4).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _resetWarnOnceForTests, _setWarnSinkForTests } from "../../src/core/warn";
import { OpenCodeProvider } from "../../src/integrations/harnesses/opencode/session-log";
import { openDatabase } from "../../src/storage/database";

const V1_DDL = `
CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, title TEXT NOT NULL, directory TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL);
CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
`;

const V2_DDL = `
CREATE TABLE session_v2 (id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, fork_session_id TEXT, directory TEXT NOT NULL, title TEXT, agent TEXT, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL);
CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, seq INTEGER NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
`;

const tempDirs: string[] = [];
let warnings: string[] = [];

function makeBase(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-opencode-store-"));
  tempDirs.push(dir);
  return dir;
}

beforeEach(() => {
  warnings = [];
  _resetWarnOnceForTests();
  _setWarnSinkForTests((level, args) => {
    if (level === "warn") warnings.push(args.map(String).join(" "));
  });
});

afterEach(() => {
  _setWarnSinkForTests();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

type Db = ReturnType<typeof openDatabase>;

function firstSession(provider: OpenCodeProvider, location: string) {
  const summary = provider.listSessions({ location })[0];
  if (!summary) throw new Error("fixture lists no session");
  return summary;
}

function v1Session(
  db: Db,
  id: string,
  directory: string,
  created: number,
  texts: Array<[string, string]>,
  parent: string | null = null,
): void {
  db.run(
    "INSERT INTO session (id, project_id, parent_id, title, directory, time_created, time_updated) VALUES (?, 'p', ?, ?, ?, ?, ?)",
    id,
    parent,
    `v1 ${id}`,
    directory,
    created,
    created + 100,
  );
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

function v2Message(db: Db, session: string, seq: number, type: string, data: Record<string, unknown>): void {
  db.run(
    "INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?, ?)",
    `msg_${session}_${seq}`,
    session,
    type,
    seq,
    1000 + seq,
    1000 + seq,
    JSON.stringify(data),
  );
}

function v2Session(
  db: Db,
  id: string,
  directory: string,
  updated = 5000,
  extra: { parent?: string; agent?: string } = {},
): void {
  db.run(
    "INSERT INTO session_v2 (id, project_id, parent_id, directory, agent, time_created, time_updated) VALUES (?, 'p', ?, ?, ?, 1000, ?)",
    id,
    extra.parent ?? null,
    directory,
    extra.agent ?? null,
    updated,
  );
}

function build(base: string, ddl: string, fill: (db: Db) => void): string {
  const dbPath = path.join(base, "opencode.db");
  const db = openDatabase(dbPath, { create: true });
  db.exec(ddl);
  fill(db);
  db.close();
  return dbPath;
}

describe("OpenCode V1 store", () => {
  test("lists and reads a V1-only file", () => {
    const base = makeBase();
    build(base, V1_DDL, (db) =>
      v1Session(db, "ses_v1", "/work/a", 2000, [
        ["user", "hi"],
        ["assistant", "hello"],
      ]),
    );
    const provider = new OpenCodeProvider();
    expect(provider.inspectStore(base)).toEqual({ kind: "ok", v1: true, v2: false });
    const summary = firstSession(provider, base);
    expect(summary).toMatchObject({ sessionId: "ses_v1", projectHint: "/work/a", title: "v1 ses_v1" });
    expect(provider.readSession(summary).events.map((e) => [e.role, e.text])).toEqual([
      ["user", "hi"],
      ["assistant", "hello"],
    ]);
    expect(warnings).toEqual([]);
  });
});

describe("sessions that are not the user's", () => {
  test("a subagent's child session and akm's own model work are not listed (V2)", () => {
    const base = makeBase();
    build(base, V2_DDL, (db) => {
      v2Session(db, "ses_user", "/work/b", 5000, { agent: "build" });
      v2Session(db, "ses_child", "/work/b", 5001, { parent: "ses_user" });
      v2Session(db, "ses_mw", "/tmp/mw", 5002, { agent: "akm-model-work" });
    });
    expect(new OpenCodeProvider().listSessions({ location: base }).map((s) => s.sessionId)).toEqual(["ses_user"]);
  });

  test("a subagent's child session is not listed (V1)", () => {
    const base = makeBase();
    build(base, V1_DDL, (db) => {
      v1Session(db, "ses_user", "/work/a", 2000, [["user", "hi"]]);
      v1Session(db, "ses_child", "/work/a", 2001, [["user", "You are a subagent"]], "ses_user");
    });
    expect(new OpenCodeProvider().listSessions({ location: base }).map((s) => s.sessionId)).toEqual(["ses_user"]);
  });
});

describe("the akm plugin's tools in a V2 session", () => {
  test("remember and feedback calls count as saved; search, show and curate calls are left out", () => {
    const base = makeBase();
    build(base, V2_DDL, (db) => {
      v2Session(db, "ses_p", "/work/p");
      v2Message(db, "ses_p", 1, "user", { text: "fix the deploy", time: { created: 1001 } });
      const tool = (id: string, name: string, input: Record<string, unknown>) => ({
        type: "tool",
        id,
        name,
        state: { status: "completed", input, content: [{ type: "text", text: `{"ok":true,"from":"${name}"}` }] },
        time: { created: 1002 },
      });
      v2Message(db, "ses_p", 2, "assistant", {
        time: { created: 1002 },
        content: [
          tool("t1", "akm_search", { query: "deploy" }),
          tool("t2", "akm_show", { ref: "skills/deploy" }),
          tool("t3", "akm_curate", { task: "deploy" }),
          tool("t4", "akm_remember", { content: "Deploys need the VPN" }),
          tool("t5", "akm_feedback", { ref: "skills/deploy", sentiment: "negative", note: "missed the VPN step" }),
        ],
      });
    });
    const provider = new OpenCodeProvider();
    const read = provider.readSession(firstSession(provider, base));
    expect(read.inlineRefs).toEqual([
      { kind: "remember", text: "Deploys need the VPN", ts: 1002 },
      { kind: "feedback", ref: "skills/deploy", text: "missed the VPN step", ts: 1002 },
    ]);
    const text = read.events.map((e) => e.text).join("\n");
    for (const name of ["akm_search", "akm_show", "akm_curate"]) expect(text).not.toContain(name);
    expect(text).toContain("[tool:akm_remember]");
  });
});

describe("OPENCODE_DB", () => {
  test("names the store file under the data dir, as it does for opencode", () => {
    const base = makeBase();
    const dbPath = build(base, V2_DDL, (db) => v2Session(db, "ses_named", "/work/n"));
    fs.renameSync(dbPath, path.join(base, "custom.db"));
    const previous = process.env.OPENCODE_DB;
    process.env.OPENCODE_DB = "custom.db";
    try {
      expect(new OpenCodeProvider().listSessions({ location: base }).map((s) => s.sessionId)).toEqual(["ses_named"]);
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_DB;
      else process.env.OPENCODE_DB = previous;
    }
  });
});

describe("OpenCode V2 store", () => {
  test("rebuilds ordered messages, tool calls and results by seq", () => {
    const base = makeBase();
    build(base, V2_DDL, (db) => {
      v2Session(db, "ses_v2", "/work/b");
      // Inserted out of seq order on purpose.
      v2Message(db, "ses_v2", 2, "assistant", {
        time: { created: 1002 },
        agent: "build",
        content: [
          { type: "reasoning", text: "thinking" },
          { type: "text", text: "Saving that." },
          {
            type: "tool",
            id: "call_1",
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
            id: "call_2",
            name: "read",
            time: { created: 1005 },
            state: { status: "running", input: { path: "a.ts" }, metadata: {} },
          },
          {
            type: "tool",
            id: "call_3",
            name: "write",
            time: { created: 1006, completed: 1007 },
            state: { status: "error", input: { path: "b.ts" }, error: { type: "tool.failed", message: "denied" } },
          },
        ],
      });
      v2Message(db, "ses_v2", 1, "user", { time: { created: 1001 }, text: "remember the vpn thing", files: [] });
      v2Message(db, "ses_v2", 3, "idle", { time: { created: 1008 }, outcome: "succeeded" });
      db.run("INSERT INTO session_message VALUES ('bad', 'ses_v2', 'user', 9, 1, 1, '{not json')");
    });
    const provider = new OpenCodeProvider();
    expect(provider.inspectStore(base)).toEqual({ kind: "ok", v1: false, v2: true });
    const summary = firstSession(provider, base);
    expect(summary).toMatchObject({ sessionId: "ses_v2", projectHint: "/work/b" });
    const data = provider.readSession(summary);
    expect(data.events.map((e) => [e.role, e.text])).toEqual([
      ["user", "remember the vpn thing"],
      ["assistant", "Saving that."],
      ["assistant", '[tool:shell] akm remember "vpn needs the corp cert"'],
      ["tool", "[tool_result] saved"],
      ["assistant", '[tool:read] {"path":"a.ts"}'],
      ["assistant", '[tool:write] {"path":"b.ts"}'],
      ["tool", "[tool_result] denied"],
    ]);
    expect(data.inlineRefs).toEqual([{ kind: "remember", text: "vpn needs the corp cert", ts: 1003 }]);
    // One unreadable message degrades with a warning; it does not abort the session.
    expect(warnings.some((w) => w.includes("skipped unreadable message bad"))).toBe(true);
  });

  test("reads WAL content that is not yet checkpointed", () => {
    const base = makeBase();
    const dbPath = path.join(base, "opencode.db");
    const writer = openDatabase(dbPath, { create: true });
    try {
      writer.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0");
      writer.exec(V2_DDL);
      v2Session(writer, "ses_wal", "/work/w");
      v2Message(writer, "ses_wal", 1, "user", { time: { created: 1001 }, text: "only in the wal" });
      expect(fs.statSync(`${dbPath}-wal`).size).toBeGreaterThan(0);
      const provider = new OpenCodeProvider();
      const summary = firstSession(provider, base);
      expect(provider.readSession(summary).events.map((e) => e.text)).toEqual(["only in the wal"]);
    } finally {
      writer.close();
    }
  });
});

describe("natively upgraded store (V1 and V2 tables in one file)", () => {
  test("merges by session id, V2 wins, V1-only history stays readable", () => {
    const base = makeBase();
    build(base, V1_DDL + V2_DDL, (db) => {
      // Copied by the upgrade: same id in both, messages present in V2.
      v1Session(db, "ses_copied", "/work/c", 2000, [["user", "old text"]]);
      v2Session(db, "ses_copied", "/work/c", 2100);
      v2Message(db, "ses_copied", 0, "user", { time: { created: 2000 }, text: "migrated text" });
      // Not copied (or copied without messages): only the V1 rows hold the history.
      v1Session(db, "ses_retained", "/work/d", 1000, [["user", "retained v1 text"]]);
      v2Session(db, "ses_empty_copy", "/work/e", 1500);
      v1Session(db, "ses_empty_copy", "/work/e", 1400, [["user", "v1 side of empty copy"]]);
      // Created natively on V2.
      v2Session(db, "ses_new", "/work/f", 9000);
      v2Message(db, "ses_new", 0, "user", { time: { created: 8000 }, text: "new on v2" });
    });
    const provider = new OpenCodeProvider();
    expect(provider.inspectStore(base)).toEqual({ kind: "ok", v1: true, v2: true });
    const sessions = provider.listSessions({ location: base });
    expect(sessions.map((s) => s.sessionId)).toEqual(["ses_new", "ses_copied", "ses_empty_copy", "ses_retained"]);
    const text = (id: string) =>
      provider.readSession(sessions.find((s) => s.sessionId === id) as never).events.map((e) => e.text);
    expect(text("ses_copied")).toEqual(["migrated text"]);
    expect(text("ses_retained")).toEqual(["retained v1 text"]);
    expect(text("ses_empty_copy")).toEqual(["v1 side of empty copy"]);
    expect(text("ses_new")).toEqual(["new on v2"]);
    expect(warnings).toEqual([]);
  });

  test("a broken V2 half degrades with a warning and still lists V1 sessions", () => {
    const base = makeBase();
    build(base, V1_DDL + "CREATE TABLE session_v2 (id TEXT); CREATE TABLE session_message (id TEXT);", (db) =>
      v1Session(db, "ses_ok", "/work/g", 1000, [["user", "still here"]]),
    );
    const sessions = new OpenCodeProvider().listSessions({ location: base });
    expect(sessions.map((s) => s.sessionId)).toEqual(["ses_ok"]);
    expect(warnings.some((w) => w.includes("OpenCode 2 session tables cannot be queried"))).toBe(true);
  });
});

describe("missing versus incompatible history", () => {
  test("no database file is silently empty", () => {
    const base = makeBase();
    const provider = new OpenCodeProvider();
    expect(provider.inspectStore(base)).toEqual({ kind: "missing" });
    expect(provider.listSessions({ location: base })).toEqual([]);
    expect(warnings).toEqual([]);
  });

  test("an unknown schema is reported, not presented as an empty list", () => {
    const base = makeBase();
    build(base, "CREATE TABLE unrelated (x TEXT);", () => {});
    const provider = new OpenCodeProvider();
    expect(provider.inspectStore(base)).toEqual({ kind: "unsupported", tables: ["unrelated"] });
    expect(provider.listSessions({ location: base })).toEqual([]);
    expect(warnings.some((w) => w.includes("not an empty history"))).toBe(true);
  });

  test("a corrupt file is reported as unreadable", () => {
    const base = makeBase();
    fs.writeFileSync(path.join(base, "opencode.db"), "this is not a sqlite database".repeat(50));
    const provider = new OpenCodeProvider();
    expect(provider.inspectStore(base).kind).toBe("unreadable");
    expect(provider.listSessions({ location: base })).toEqual([]);
    expect(warnings.some((w) => w.includes("not an empty history"))).toBe(true);
  });
});

// Real binaries, gated: set AKM_OPENCODE_V1_BIN / AKM_OPENCODE_V2_BIN. The prompt
// names a model no provider serves, so it fails without reaching any model (with no
// model named, OpenCode falls back to its hosted free model), but the session and
// its messages are still stored.
function realBinaryStore(bin: string | undefined, extraArgs: string[]) {
  const home = makeBase();
  const env = {
    PATH: process.env.PATH ?? "",
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    XDG_STATE_HOME: path.join(home, ".local", "state"),
  };
  spawnSync(bin as string, ["run", "--model", "no-such-provider/no-such-model", ...extraArgs, "hello from akm"], {
    cwd: home,
    env,
    timeout: 90_000,
  });
  return path.join(home, ".local", "share", "opencode");
}

describe("real OpenCode binaries", () => {
  const v1 = process.env.AKM_OPENCODE_V1_BIN;
  const v2 = process.env.AKM_OPENCODE_V2_BIN;

  test.skipIf(!v1)(
    "history written by OpenCode 1 is read through the V1 layout",
    () => {
      const dir = realBinaryStore(v1, []);
      const provider = new OpenCodeProvider();
      expect(provider.inspectStore(dir)).toMatchObject({ kind: "ok", v1: true, v2: false });
      const summary = firstSession(provider, dir);
      expect(provider.readSession(summary).events[0]?.text).toContain("hello from akm");
    },
    120_000,
  );

  test.skipIf(!v2)(
    "history written by OpenCode 2 is read through the V2 layout",
    () => {
      const dir = realBinaryStore(v2, ["--standalone"]);
      const provider = new OpenCodeProvider();
      expect(provider.inspectStore(dir)).toMatchObject({ kind: "ok", v1: false, v2: true });
      const summary = firstSession(provider, dir);
      expect(provider.readSession(summary).events[0]?.text).toContain("hello from akm");
    },
    120_000,
  );
});
