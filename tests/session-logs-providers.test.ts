// Tests for the per-session API on the SessionLogHarness providers:
//   - listSessions({sinceMs, location}) → SessionSummary[]
//   - readSession(ref) → SessionData (with normalized events + inline ref mentions)
//   - extractInlineRefMentions() helper used by both providers
//
// Each test scaffolds a temp directory mirroring the real platform layout
// (Claude Code: ~/.claude/projects/<project>/<id>.jsonl; opencode:
// <base>/storage/session/<projectId>/<id>.json + <base>/storage/message/<id>/*).
// No system home is touched.

import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ClaudeCodeProvider } from "../src/integrations/harnesses/claude/session-log";
import { OpenCodeProvider } from "../src/integrations/harnesses/opencode/session-log";
import { extractInlineRefMentions } from "../src/integrations/session-logs/inline-refs";

const tempDirs: string[] = [];
function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── inline-refs helper ──────────────────────────────────────────────────────

describe("extractInlineRefMentions", () => {
  test("returns empty array for short / missing text", () => {
    expect(extractInlineRefMentions("")).toEqual([]);
    expect(extractInlineRefMentions("short")).toEqual([]);
    expect(extractInlineRefMentions("a".repeat(20))).toEqual([]);
  });

  test('extracts `akm remember "body"` invocations', () => {
    const text = `Some prose first. Then ran: akm remember "VPN required before deploy" and moved on.`;
    const refs = extractInlineRefMentions(text);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ kind: "remember", text: "VPN required before deploy" });
  });

  test('extracts `akm feedback <ref> --note "..."` invocations', () => {
    const text = `Ran: akm feedback knowledge:auth-guide --positive --note "saved me time" — done.`;
    const refs = extractInlineRefMentions(text);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({
      kind: "feedback",
      ref: "knowledge:auth-guide",
      text: "saved me time",
    });
  });

  test("extracts both styles in one chunk and preserves ts when provided", () => {
    const text = `akm remember "remember this fact" then akm feedback skill:deploy --negative -n "the warning was wrong"`;
    const refs = extractInlineRefMentions(text, 1700000000000);
    expect(refs).toHaveLength(2);
    expect(refs.find((r) => r.kind === "remember")?.text).toBe("remember this fact");
    expect(refs.find((r) => r.kind === "feedback")?.ref).toBe("skill:deploy");
    expect(refs.every((r) => r.ts === 1700000000000)).toBe(true);
  });

  test("handles single-quoted invocations", () => {
    const text = `akm remember 'note with apostrophes' and akm feedback ref:foo --note 'single quoted note'`;
    const refs = extractInlineRefMentions(text);
    expect(refs).toHaveLength(2);
    expect(refs[0]?.kind).toBe("remember");
    expect(refs[1]?.kind).toBe("feedback");
  });

  test("does not match `akm remember` without an argument", () => {
    expect(extractInlineRefMentions("just ran akm remember by itself")).toEqual([]);
  });
});

// ── ClaudeCodeProvider ──────────────────────────────────────────────────────

function writeClaudeSessionJsonl(filePath: string, lines: object[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
}

describe("ClaudeCodeProvider.listSessions", () => {
  test("lists sessions across project subdirectories with correct metadata", () => {
    const root = makeTempDir("akm-claude-list-");
    const sessionA = path.join(root, "-home-user-project-a", "session-aaa.jsonl");
    const sessionB = path.join(root, "-home-user-project-b", "session-bbb.jsonl");
    writeClaudeSessionJsonl(sessionA, [
      { type: "custom-title", customTitle: "Refactor auth", sessionId: "session-aaa" },
      { type: "user", timestamp: "2026-05-26T10:00:00.000Z", message: { role: "user", content: "hello" } },
      { type: "assistant", timestamp: "2026-05-26T10:05:00.000Z", message: { role: "assistant", content: "hi" } },
    ]);
    writeClaudeSessionJsonl(sessionB, [
      { type: "user", timestamp: "2026-05-26T11:00:00.000Z", message: { role: "user", content: "another session" } },
    ]);

    const provider = new ClaudeCodeProvider();
    const sessions = provider.listSessions({ location: root });
    expect(sessions).toHaveLength(2);

    const aSummary = sessions.find((s) => s.sessionId === "session-aaa");
    expect(aSummary).toBeDefined();
    expect(aSummary?.harness).toBe("claude-code");
    expect(aSummary?.title).toBe("Refactor auth");
    expect(aSummary?.projectHint).toBe("-home-user-project-a");
    expect(aSummary?.startedAt).toBe(Date.parse("2026-05-26T10:00:00.000Z"));
    expect(aSummary?.endedAt).toBe(Date.parse("2026-05-26T10:05:00.000Z"));
  });

  test("filters by sinceMs (older sessions excluded)", () => {
    const root = makeTempDir("akm-claude-since-");
    const newSession = path.join(root, "proj", "new.jsonl");
    writeClaudeSessionJsonl(newSession, [
      { type: "user", timestamp: "2026-05-26T10:00:00.000Z", message: { role: "user", content: "x" } },
    ]);
    // Backdate file mtime to far past
    const oldSession = path.join(root, "proj", "old.jsonl");
    writeClaudeSessionJsonl(oldSession, [
      { type: "user", timestamp: "2020-01-01T00:00:00.000Z", message: { role: "user", content: "x" } },
    ]);
    const past = new Date("2019-01-01").getTime();
    fs.utimesSync(oldSession, past / 1000, past / 1000);

    const provider = new ClaudeCodeProvider();
    const sessions = provider.listSessions({ location: root, sinceMs: new Date("2026-05-01").getTime() });
    expect(sessions.map((s) => s.sessionId)).toEqual(["new"]);
  });

  test("returns sessions sorted by endedAt descending", () => {
    const root = makeTempDir("akm-claude-sort-");
    writeClaudeSessionJsonl(path.join(root, "p", "older.jsonl"), [
      { type: "user", timestamp: "2026-05-20T10:00:00.000Z", message: { role: "user", content: "x" } },
    ]);
    writeClaudeSessionJsonl(path.join(root, "p", "newer.jsonl"), [
      { type: "user", timestamp: "2026-05-26T10:00:00.000Z", message: { role: "user", content: "x" } },
    ]);
    const provider = new ClaudeCodeProvider();
    const sessions = provider.listSessions({ location: root });
    expect(sessions.map((s) => s.sessionId)).toEqual(["newer", "older"]);
  });
});

describe("ClaudeCodeProvider.readSession", () => {
  test("returns ordered events + extracted inline refs", () => {
    const root = makeTempDir("akm-claude-read-");
    const sessionPath = path.join(root, "proj", "session-1.jsonl");
    writeClaudeSessionJsonl(sessionPath, [
      { type: "custom-title", customTitle: "Debugging deploy" },
      {
        type: "user",
        timestamp: "2026-05-26T10:00:00.000Z",
        message: { role: "user", content: "Please run the deploy script." },
      },
      {
        type: "assistant",
        timestamp: "2026-05-26T10:01:00.000Z",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "Running it now." },
            { type: "tool_use", name: "Bash", input: { command: `akm remember "deploy needs VPN"` } },
          ],
        },
      },
      {
        type: "user",
        timestamp: "2026-05-26T10:02:00.000Z",
        message: {
          role: "user",
          content: [{ type: "tool_result", content: "exit 0" }],
        },
      },
    ]);

    const provider = new ClaudeCodeProvider();
    const summary = provider.listSessions({ location: root })[0];
    expect(summary).toBeDefined();
    if (!summary) throw new Error("test fixture missing session summary");
    const data = provider.readSession(summary);

    expect(data.ref.harness).toBe("claude-code");
    expect(data.ref.title).toBe("Debugging deploy");
    expect(data.events.length).toBeGreaterThanOrEqual(3);
    expect(data.events.every((e) => e.harness === "claude-code")).toBe(true);
    // Inline-ref extraction sees the tool_use input flattened as `[tool:Bash] {...}`
    expect(data.inlineRefs).toHaveLength(1);
    expect(data.inlineRefs[0]).toMatchObject({ kind: "remember", text: "deploy needs VPN" });
  });

  test("skips events without text content", () => {
    const root = makeTempDir("akm-claude-skip-");
    const sessionPath = path.join(root, "proj", "session-2.jsonl");
    writeClaudeSessionJsonl(sessionPath, [
      { type: "file-history-snapshot", uuid: "x" },
      { type: "attachment", uuid: "y" },
      { type: "user", timestamp: "2026-05-26T10:00:00.000Z", message: { role: "user", content: "real content here." } },
    ]);
    const provider = new ClaudeCodeProvider();
    const summary = provider.listSessions({ location: root })[0];
    if (!summary) throw new Error("test fixture missing session summary");
    const data = provider.readSession(summary);
    expect(data.events).toHaveLength(1);
    expect(data.events[0]?.text).toBe("real content here.");
  });
});

// ── OpenCodeProvider ────────────────────────────────────────────────────────

function writeOpenCodeSession(
  base: string,
  projectId: string,
  sessionId: string,
  meta: object,
  messages: object[],
): void {
  const sessionDir = path.join(base, "storage", "session", projectId);
  const msgDir = path.join(base, "storage", "message", sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.mkdirSync(msgDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, `${sessionId}.json`), JSON.stringify(meta));
  for (const msg of messages) {
    const msgRecord = msg as Record<string, unknown>;
    const id = (msgRecord.id as string) ?? `msg_${Math.random().toString(36).slice(2)}`;
    fs.writeFileSync(path.join(msgDir, `${id}.json`), JSON.stringify(msg));
  }
}

describe("OpenCodeProvider.listSessions", () => {
  test("lists sessions from storage/session/<projectId>/", () => {
    const base = makeTempDir("akm-opencode-list-");
    writeOpenCodeSession(
      base,
      "proj-aaa",
      "ses_one",
      {
        id: "ses_one",
        title: "First session",
        directory: "/home/user/proj-aaa",
        time: { created: 1700000000000, updated: 1700001000000 },
      },
      [],
    );
    writeOpenCodeSession(
      base,
      "proj-bbb",
      "ses_two",
      {
        id: "ses_two",
        title: "Second session",
        directory: "/home/user/proj-bbb",
        time: { created: 1700002000000, updated: 1700003000000 },
      },
      [],
    );

    const provider = new OpenCodeProvider();
    const sessions = provider.listSessions({ location: base });
    expect(sessions).toHaveLength(2);
    const one = sessions.find((s) => s.sessionId === "ses_one");
    expect(one).toMatchObject({
      harness: "opencode",
      title: "First session",
      projectHint: "/home/user/proj-aaa",
      startedAt: 1700000000000,
      endedAt: 1700001000000,
    });
  });

  test("returns empty array when storage/session does not exist", () => {
    const base = makeTempDir("akm-opencode-empty-");
    const provider = new OpenCodeProvider();
    expect(provider.listSessions({ location: base })).toEqual([]);
  });

  test("filters by sinceMs based on session file mtime", () => {
    const base = makeTempDir("akm-opencode-since-");
    writeOpenCodeSession(
      base,
      "p",
      "ses_recent",
      { id: "ses_recent", title: "x", time: { created: Date.now(), updated: Date.now() } },
      [],
    );
    writeOpenCodeSession(base, "p", "ses_old", { id: "ses_old", title: "x", time: { created: 0, updated: 0 } }, []);
    const oldPath = path.join(base, "storage", "session", "p", "ses_old.json");
    const past = new Date("2019-01-01").getTime() / 1000;
    fs.utimesSync(oldPath, past, past);

    const provider = new OpenCodeProvider();
    const sessions = provider.listSessions({ location: base, sinceMs: new Date("2026-05-01").getTime() });
    expect(sessions.map((s) => s.sessionId)).toEqual(["ses_recent"]);
  });
});

describe("OpenCodeProvider.readSession", () => {
  test("reads messages from storage/message/<sessionId>/ with summary content", () => {
    const base = makeTempDir("akm-opencode-read-");
    writeOpenCodeSession(
      base,
      "proj",
      "ses_full",
      {
        id: "ses_full",
        title: "Real session",
        directory: "/home/user/proj",
        time: { created: 1700000000000, updated: 1700010000000 },
      },
      [
        {
          id: "msg_a",
          sessionID: "ses_full",
          role: "user",
          time: { created: 1700000100000 },
          summary: { title: `Need to debug; will run akm remember "auth uses JWT now"` },
        },
        {
          id: "msg_b",
          sessionID: "ses_full",
          role: "assistant",
          time: { created: 1700000200000 },
          summary: { title: "Done. Suggested a fix." },
        },
      ],
    );

    const provider = new OpenCodeProvider();
    const summary = provider.listSessions({ location: base })[0];
    expect(summary).toBeDefined();
    if (!summary) throw new Error("test fixture missing session summary");
    const data = provider.readSession(summary);

    expect(data.ref.harness).toBe("opencode");
    expect(data.ref.title).toBe("Real session");
    expect(data.events).toHaveLength(2);
    // Events sorted ascending by ts so the inline ref appears in the first message
    expect(data.events[0]?.text).toContain("auth uses JWT");
    expect(data.inlineRefs).toHaveLength(1);
    expect(data.inlineRefs[0]).toMatchObject({ kind: "remember", text: "auth uses JWT now" });
  });

  test("returns empty events when message directory is missing", () => {
    const base = makeTempDir("akm-opencode-nomsg-");
    // Session metadata exists but no message dir
    const sessionDir = path.join(base, "storage", "session", "p");
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionDir, "ses_orphan.json"),
      JSON.stringify({ id: "ses_orphan", time: { created: 1700000000000, updated: 1700000000000 } }),
    );
    const provider = new OpenCodeProvider();
    const summary = provider.listSessions({ location: base })[0];
    expect(summary).toBeDefined();
    if (!summary) throw new Error("test fixture missing session summary");
    const data = provider.readSession(summary);
    expect(data.events).toEqual([]);
    expect(data.inlineRefs).toEqual([]);
  });
});
