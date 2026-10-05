// Tests for the per-session API on the SessionLogHarness providers:
//   - listSessions({sinceMs, location}) → SessionSummary[]
//   - readSession(ref) → SessionData (with normalized events + inline ref mentions)
//   - extractInlineRefMentions() helper used by both providers
//
// Each test scaffolds a temp directory mirroring the real platform layout.
// Claude uses ~/.claude/projects/<project>/<id>.jsonl; Codex uses
// $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<timestamp>-<id>.jsonl; OpenCode
// coverage uses the sole supported opencode.db layout.
// No system home is touched.

import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ClaudeCodeProvider } from "../src/integrations/harnesses/claude/session-log";
import { CodexProvider } from "../src/integrations/harnesses/codex/session-log";
import { OpenCodeProvider } from "../src/integrations/harnesses/opencode/session-log";
import { extractInlineRefMentions } from "../src/integrations/session-logs/inline-refs";
import { openDatabase } from "../src/storage/database";
import { codexMessage, writeCodexRollout } from "./_helpers/codex-rollout";
import { withEnvSync } from "./_helpers/sandbox";

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
    expect(aSummary?.harness).toBe("claude");
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

  test("excludes subagent transcripts, which are not sessions (#829)", () => {
    const root = makeTempDir("akm-claude-subagents-list-");
    const project = path.join(root, "-home-user-project-a");
    writeClaudeSessionJsonl(path.join(project, "session-aaa.jsonl"), [
      { type: "user", timestamp: "2026-05-26T10:00:00.000Z", message: { role: "user", content: "parent work" } },
    ]);
    writeClaudeSessionJsonl(path.join(project, "session-aaa", "subagents", "agent-abc123.jsonl"), [
      { type: "user", timestamp: "2026-05-26T10:01:00.000Z", message: { role: "user", content: "delegated work" } },
    ]);
    // Workflow-spawned subagents nest one level deeper under `subagents/`.
    writeClaudeSessionJsonl(
      path.join(project, "session-aaa", "subagents", "workflows", "wf_123", "agent-def456.jsonl"),
      [{ type: "user", timestamp: "2026-05-26T10:02:00.000Z", message: { role: "user", content: "nested work" } }],
    );

    const provider = new ClaudeCodeProvider();
    const sessions = provider.listSessions({ location: root });
    expect(sessions.map((s) => s.sessionId)).toEqual(["session-aaa"]);
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

    expect(data.ref.harness).toBe("claude");
    expect(data.ref.title).toBe("Debugging deploy");
    expect(data.events.length).toBeGreaterThanOrEqual(3);
    expect(data.events.every((e) => e.harness === "claude")).toBe(true);
    // Inline-ref extraction sees the tool_use input flattened as `[tool:Bash] {...}`
    expect(data.inlineRefs).toHaveLength(1);
    expect(data.inlineRefs[0]).toMatchObject({ kind: "remember", text: "deploy needs VPN" });
  });

  test("folds subagent transcripts into the parent session (#829)", () => {
    const root = makeTempDir("akm-claude-subagents-read-");
    const project = path.join(root, "proj");
    writeClaudeSessionJsonl(path.join(project, "session-1.jsonl"), [
      {
        type: "user",
        timestamp: "2026-05-26T10:00:00.000Z",
        message: { role: "user", content: "Delegate the audit." },
      },
      {
        type: "assistant",
        timestamp: "2026-05-26T10:30:00.000Z",
        message: { role: "assistant", content: "The audit is done." },
      },
    ]);
    const subagentPath = path.join(project, "session-1", "subagents", "agent-abc123.jsonl");
    writeClaudeSessionJsonl(subagentPath, [
      {
        type: "assistant",
        timestamp: "2026-05-26T10:10:00.000Z",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", name: "Bash", input: { command: `akm remember "audits need a clean tree"` } }],
        },
      },
    ]);
    fs.writeFileSync(
      path.join(project, "session-1", "subagents", "agent-abc123.meta.json"),
      JSON.stringify({ agentType: "general-purpose", description: "Audit the release branches", spawnDepth: 1 }),
    );

    const provider = new ClaudeCodeProvider();
    const summary = provider.listSessions({ location: root })[0];
    if (!summary) throw new Error("test fixture missing session summary");
    const data = provider.readSession(summary);

    // Subagent work lands under the parent's identity, merged in timestamp order.
    expect(data.events).toHaveLength(3);
    expect(data.events.map((e) => e.ts)).toEqual([
      Date.parse("2026-05-26T10:00:00.000Z"),
      Date.parse("2026-05-26T10:10:00.000Z"),
      Date.parse("2026-05-26T10:30:00.000Z"),
    ]);
    expect(data.events.every((e) => e.sessionId === "session-1")).toBe(true);
    // Sidecar `agentType`/`description` ride along as provenance on the text,
    // and the event still points at the subagent transcript it came from.
    expect(data.events[1]?.text).toStartWith("[subagent:general-purpose] Audit the release branches\n");
    expect(data.events[1]?.filePath).toBe(subagentPath);
    expect(data.events[0]?.text).toBe("Delegate the audit.");
    // Inline invocations made by the subagent are harvested too.
    expect(data.inlineRefs).toHaveLength(1);
    expect(data.inlineRefs[0]).toMatchObject({ kind: "remember", text: "audits need a clean tree" });
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

// ── CodexProvider ───────────────────────────────────────────────────────────

const threadId = (n: number): string => `00000000-0000-7000-8000-${String(n).padStart(12, "0")}`;

/** Set a file's mtime, which Codex leaves at its session's last record. */
function touch(file: string, iso: string): void {
  const seconds = Date.parse(iso) / 1000;
  fs.utimesSync(file, seconds, seconds);
}

/** One `response_item` record of a given payload. */
const item = (payload: Record<string, unknown>) => ({ type: "response_item", payload });

describe("CodexProvider.listSessions", () => {
  test("lists a person's sessions from the date tree, newest first, `codex exec` runs included", () => {
    const root = makeTempDir("akm-codex-list-");
    const exec = writeCodexRollout(
      root,
      { id: threadId(1), source: "exec", cwd: "/home/user/project-b", startedAt: "2026-08-01T10:00:00.000Z" },
      [codexMessage("user", "scripted run")],
    );
    const vscode = writeCodexRollout(
      root,
      { id: threadId(2), source: "vscode", cwd: "/home/user/project-a", startedAt: "2026-09-03T10:00:00.000Z" },
      [codexMessage("user", "hello")],
    );
    touch(exec, "2026-08-01T10:30:00.000Z");
    touch(vscode, "2026-09-03T11:00:00.000Z");

    const sessions = new CodexProvider().listSessions({ location: root });
    expect(sessions).toEqual([
      {
        harness: "codex",
        sessionId: threadId(2),
        filePath: vscode,
        projectHint: "/home/user/project-a",
        startedAt: Date.parse("2026-09-03T10:00:00.000Z"),
        endedAt: Date.parse("2026-09-03T11:00:00.000Z"),
      },
      {
        harness: "codex",
        sessionId: threadId(1),
        filePath: exec,
        projectHint: "/home/user/project-b",
        startedAt: Date.parse("2026-08-01T10:00:00.000Z"),
        endedAt: Date.parse("2026-08-01T10:30:00.000Z"),
      },
    ]);
  });

  test("leaves out subagent, guardian and internal rollouts, which are not sessions", () => {
    const root = makeTempDir("akm-codex-agents-");
    const spawned = {
      thread_spawn: {
        parent_thread_id: threadId(1),
        depth: 1,
        agent_path: null,
        agent_nickname: "Ada",
        agent_role: null,
      },
    };
    writeCodexRollout(root, { id: threadId(1), source: "vscode" }, [codexMessage("user", "real work")]);
    writeCodexRollout(root, { id: threadId(2), source: { subagent: spawned } }, [codexMessage("user", "delegated")]);
    writeCodexRollout(root, { id: threadId(3), source: { subagent: { other: "guardian" } } }, [
      codexMessage("user", "x"),
    ]);
    writeCodexRollout(root, { id: threadId(4), source: { internal: "memory_consolidation" } }, []);
    // A custom client or an MCP caller is still a person's session.
    writeCodexRollout(root, { id: threadId(5), source: { custom: "my-client" } }, []);
    writeCodexRollout(root, { id: threadId(6), source: "mcp" }, []);

    const sessions = new CodexProvider().listSessions({ location: root });
    expect(sessions.map((s) => s.sessionId).sort()).toEqual([threadId(1), threadId(5), threadId(6)]);
  });

  test("lists a rollout whose first line is not a session_meta record, with file times and no project", () => {
    const root = makeTempDir("akm-codex-nometa-");
    const dir = path.join(root, "2026", "08", "01");
    fs.mkdirSync(dir, { recursive: true });
    const odd = path.join(dir, `rollout-2026-08-01T10-00-00-${threadId(1)}.jsonl`);
    fs.writeFileSync(odd, '{"id":"cut short\n');
    // Only rollout-*.jsonl files are sessions.
    fs.writeFileSync(path.join(dir, "notes.jsonl"), "{}\n");
    fs.writeFileSync(path.join(dir, `rollout-2026-08-01T10-00-00-${threadId(2)}.json`), "{}\n");

    const sessions = new CodexProvider().listSessions({ location: root });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ sessionId: threadId(1), filePath: odd });
    expect(sessions[0]?.projectHint).toBeUndefined();
    expect(sessions[0]?.startedAt).toBeNumber();
  });

  test("resolves its root from CODEX_HOME, per call", () => {
    const codexHome = makeTempDir("akm-codex-home-");
    writeCodexRollout(path.join(codexHome, "sessions"), { id: threadId(1) });
    const provider = new CodexProvider();

    withEnvSync({ CODEX_HOME: codexHome }, () => {
      expect(provider.isAvailable()).toBe(true);
      expect(provider.listSessions().map((s) => s.sessionId)).toEqual([threadId(1)]);
    });
    // A home with no sessions/ directory has no sessions; bun's os.homedir()
    // cannot be redirected in-process, so the ~/.codex default is not exercised.
    withEnvSync({ CODEX_HOME: path.join(codexHome, "missing") }, () => {
      expect(provider.isAvailable()).toBe(false);
      expect(provider.listSessions()).toEqual([]);
    });
  });
});

describe("CodexProvider.readSession", () => {
  test("reads the conversation as user and assistant events, without Codex's own instructions and context", () => {
    const root = makeTempDir("akm-codex-read-");
    const file = writeCodexRollout(root, { id: threadId(1), source: "vscode", cwd: "/home/user/project-a" }, [
      { type: "event_msg", payload: { type: "task_started", turn_id: "t1" } },
      codexMessage("developer", "<permissions>Sandbox mode is workspace-write.</permissions>"),
      codexMessage(
        "user",
        "# AGENTS.md instructions for /home/user/project-a\n\n<INSTRUCTIONS>\nUse bun.\n</INSTRUCTIONS>",
      ),
      codexMessage("user", "<environment_context>\n  <cwd>/home/user/project-a</cwd>\n</environment_context>"),
      codexMessage("user", "<recommended_plugins>\nTry the deploy plugin.\n</recommended_plugins>"),
      { type: "turn_context", payload: { turn_id: "t1", cwd: "/home/user/project-a", model: "test-model" } },
      // Injected context and the person's words can share one message.
      codexMessage(
        "user",
        "<environment_context>\n  <shell>bash</shell>\n</environment_context>",
        "Why does the deploy hang?",
      ),
      item({ type: "reasoning", summary: [], content: null, encrypted_content: "opaque" }),
      codexMessage("assistant", "It waits on the VPN. Which window do you deploy in?"),
      // A block in a tag Codex is not known to inject is the person's reply.
      codexMessage("user", "<answer>Friday evenings.</answer>"),
      { type: "event_msg", payload: { type: "token_count", info: null } },
      codexMessage("assistant", "Connect first, then rerun it."),
    ]);

    const provider = new CodexProvider();
    const summary = provider.listSessions({ location: root })[0];
    if (!summary) throw new Error("test fixture missing session summary");
    const data = provider.readSession(summary);

    expect(data.events.map((e) => [e.role, e.text])).toEqual([
      ["user", "Why does the deploy hang?"],
      ["assistant", "It waits on the VPN. Which window do you deploy in?"],
      ["user", "<answer>Friday evenings.</answer>"],
      ["assistant", "Connect first, then rerun it."],
    ]);
    expect(data.events.every((e) => e.harness === "codex" && e.sessionId === threadId(1) && e.filePath === file)).toBe(
      true,
    );
    // Records are stamped a minute apart from the session start.
    expect(data.events.map((e) => e.ts)).toEqual([
      Date.parse("2026-08-01T10:07:00.000Z"),
      Date.parse("2026-08-01T10:09:00.000Z"),
      Date.parse("2026-08-01T10:10:00.000Z"),
      Date.parse("2026-08-01T10:12:00.000Z"),
    ]);
    expect(data.ref).toEqual({
      harness: "codex",
      sessionId: threadId(1),
      filePath: file,
      projectHint: "/home/user/project-a",
      startedAt: Date.parse("2026-08-01T10:00:00.000Z"),
      endedAt: Date.parse("2026-08-01T10:12:00.000Z"),
    });
    expect(data.inlineRefs).toEqual([]);
  });

  test("flattens tool calls and their results like the Claude reader, and finds inline akm invocations", () => {
    const root = makeTempDir("akm-codex-tools-");
    writeCodexRollout(root, { id: threadId(1) }, [
      codexMessage("user", "Save what you learn."),
      item({
        type: "function_call",
        name: "shell",
        call_id: "c1",
        arguments: JSON.stringify({ command: ["bash", "-lc", 'akm remember "deploys need the VPN"'], workdir: "/tmp" }),
      }),
      item({ type: "function_call_output", call_id: "c1", output: "exit 0" }),
      item({ type: "function_call", name: "exec_command", call_id: "c2", arguments: '{"cmd":"git status --short"}' }),
      item({
        type: "function_call_output",
        call_id: "c2",
        output: [
          { type: "input_text", text: "M README.md" },
          { type: "input_image", image_url: "data:image/png;base64,AAAA" },
        ],
      }),
      item({ type: "custom_tool_call", name: "apply_patch", call_id: "c3", input: "*** Begin Patch\n*** End Patch" }),
      item({
        type: "custom_tool_call_output",
        call_id: "c3",
        output: [{ type: "input_text", text: "Success. Updated the files." }],
      }),
      item({
        type: "local_shell_call",
        call_id: "c4",
        status: "completed",
        action: { type: "exec", command: ["ls", "-la"] },
      }),
      item({ type: "function_call_output", call_id: "c4", output: "" }),
      item({ type: "function_call", name: "update_plan", call_id: "c5", arguments: '{"plan":[]}' }),
    ]);

    const provider = new CodexProvider();
    const summary = provider.listSessions({ location: root })[0];
    if (!summary) throw new Error("test fixture missing session summary");
    const data = provider.readSession(summary);

    // An empty result is dropped; a non-shell call keeps its raw arguments.
    expect(data.events.map((e) => [e.role, e.text])).toEqual([
      ["user", "Save what you learn."],
      ["assistant", '[tool:shell] bash -lc akm remember "deploys need the VPN"'],
      ["tool", "[tool_result] exit 0"],
      ["assistant", "[tool:exec_command] git status --short"],
      ["tool", "[tool_result] M README.md"],
      ["assistant", "[tool:apply_patch] *** Begin Patch\n*** End Patch"],
      ["tool", "[tool_result] Success. Updated the files."],
      ["assistant", "[tool:shell] ls -la"],
      ["assistant", '[tool:update_plan] {"plan":[]}'],
    ]);
    expect(data.inlineRefs).toEqual([
      { kind: "remember", text: "deploys need the VPN", ts: Date.parse("2026-08-01T10:02:00.000Z") },
    ]);
  });

  test("an empty or aborted session reads as no events", () => {
    const root = makeTempDir("akm-codex-empty-");
    // Opened and closed with no input, and interrupted before the model answered.
    const empty = writeCodexRollout(root, { id: threadId(1), cwd: "/home/user/project-a" });
    const aborted = writeCodexRollout(root, { id: threadId(2), cwd: "/home/user/project-b" }, [
      { type: "event_msg", payload: { type: "task_started", turn_id: "t1" } },
      codexMessage("developer", "<turn_aborted>The user interrupted the previous turn on purpose.</turn_aborted>"),
      { type: "event_msg", payload: { type: "turn_aborted", turn_id: "t1", reason: "interrupted" } },
    ]);

    const provider = new CodexProvider();
    for (const [file, cwd] of [
      [empty, "/home/user/project-a"],
      [aborted, "/home/user/project-b"],
    ] as const) {
      const summary = provider.listSessions({ location: root }).find((s) => s.filePath === file);
      if (!summary) throw new Error("test fixture missing session summary");
      const data = provider.readSession(summary);
      expect(data.events).toEqual([]);
      expect(data.inlineRefs).toEqual([]);
      expect(data.ref.projectHint).toBe(cwd);
      expect(data.ref.startedAt).toBe(Date.parse("2026-08-01T10:00:00.000Z"));
      expect(data.ref.endedAt).toBe(fs.statSync(file).mtimeMs);
    }
  });

  test("skips a malformed, truncated or non-record line and keeps reading", () => {
    const root = makeTempDir("akm-codex-malformed-");
    writeCodexRollout(root, { id: threadId(1) }, [
      codexMessage("user", "before the damage"),
      "this is not json",
      '{"timestamp":"2026-08-01T10:03:00.000Z","type":"response_item","payload":{"type":"message","role":"assist',
      "null",
      "42",
      '"text"',
      "[]",
      JSON.stringify(item({ type: "message", role: "user" })),
      JSON.stringify({ type: "response_item", payload: "not an object" }),
      JSON.stringify({ type: "response_item", payload: null }),
      "",
      codexMessage("assistant", "after the damage"),
    ]);

    const provider = new CodexProvider();
    const summary = provider.listSessions({ location: root })[0];
    if (!summary) throw new Error("test fixture missing session summary");
    const data = provider.readSession(summary);
    expect(data.events.map((e) => e.text)).toEqual(["before the damage", "after the damage"]);
  });
});

// ── OpenCodeProvider ────────────────────────────────────────────────────────

// ── OpenCodeProvider — SQLite (`opencode.db`) layout ─────────────────────────

interface OpenCodeDbMessage {
  id: string;
  role: "user" | "assistant";
  created: number;
  texts: string[];
}
interface OpenCodeDbSession {
  id: string;
  title: string;
  directory: string;
  created: number;
  updated: number;
  messages: OpenCodeDbMessage[];
}

/**
 * Write an `opencode.db` mirroring the columns the provider reads (current
 * Drizzle-managed opencode layout: session/message/part, message text in
 * `part` rows with `type: "text"`).
 */
function writeOpenCodeDb(base: string, sessions: OpenCodeDbSession[]): string {
  const dbPath = path.join(base, "opencode.db");
  const db = openDatabase(dbPath, { create: true });
  db.exec(
    "CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, title TEXT, directory TEXT, time_created INTEGER, time_updated INTEGER);",
  );
  db.exec("CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);");
  db.exec(
    "CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);",
  );
  for (const s of sessions) {
    db.run(
      "INSERT INTO session (id, project_id, title, directory, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?)",
      s.id,
      "proj",
      s.title,
      s.directory,
      s.created,
      s.updated,
    );
    let partCounter = 0;
    for (const m of s.messages) {
      db.run(
        "INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)",
        m.id,
        s.id,
        m.created,
        JSON.stringify({ role: m.role, time: { created: m.created } }),
      );
      for (const text of m.texts) {
        db.run(
          "INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)",
          `prt_${m.id}_${partCounter++}`,
          m.id,
          s.id,
          m.created,
          JSON.stringify({ type: "text", text }),
        );
      }
    }
  }
  db.close();
  return dbPath;
}

describe("OpenCodeProvider.listSessions (opencode.db)", () => {
  test("is unavailable when only the parent directory exists", () => {
    const base = makeTempDir("akm-opencode-availability-");
    const dbPath = path.join(base, "opencode.db");
    class TempOpenCodeProvider extends OpenCodeProvider {
      protected override availabilityRoot(): string {
        return dbPath;
      }
    }
    const provider = new TempOpenCodeProvider();

    fs.mkdirSync(base, { recursive: true });
    expect(provider.isAvailable()).toBe(false);
    fs.writeFileSync(dbPath, "");
    expect(provider.isAvailable()).toBe(true);
  });

  test("lists sessions from the SQLite store, newest first", () => {
    const base = makeTempDir("akm-opencode-db-list-");
    writeOpenCodeDb(base, [
      {
        id: "ses_one",
        title: "First",
        directory: "/home/user/a",
        created: 1700000000000,
        updated: 1700001000000,
        messages: [],
      },
      {
        id: "ses_two",
        title: "Second",
        directory: "/home/user/b",
        created: 1700002000000,
        updated: 1700003000000,
        messages: [],
      },
    ]);

    const sessions = new OpenCodeProvider().listSessions({ location: base });
    expect(sessions.map((s) => s.sessionId)).toEqual(["ses_two", "ses_one"]);
    expect(sessions.find((s) => s.sessionId === "ses_one")).toMatchObject({
      harness: "opencode",
      title: "First",
      projectHint: "/home/user/a",
      startedAt: 1700000000000,
      endedAt: 1700001000000,
      filePath: path.join(base, "opencode.db"),
    });
  });

  test("uses the sole opencode.db session store", () => {
    const base = makeTempDir("akm-opencode-db-only-");
    writeOpenCodeDb(base, [
      { id: "ses_db", title: "db", directory: "/d", created: 1700000000000, updated: 1700001000000, messages: [] },
    ]);

    const sessions = new OpenCodeProvider().listSessions({ location: base });
    expect(sessions.map((s) => s.sessionId)).toEqual(["ses_db"]);
  });

  test("filters by sinceMs using session.time_updated", () => {
    const base = makeTempDir("akm-opencode-db-since-");
    writeOpenCodeDb(base, [
      {
        id: "ses_recent",
        title: "r",
        directory: "/d",
        created: 1700000000000,
        updated: new Date("2026-06-01").getTime(),
        messages: [],
      },
      {
        id: "ses_old",
        title: "o",
        directory: "/d",
        created: 0,
        updated: new Date("2026-01-01").getTime(),
        messages: [],
      },
    ]);

    const sessions = new OpenCodeProvider().listSessions({ location: base, sinceMs: new Date("2026-05-01").getTime() });
    expect(sessions.map((s) => s.sessionId)).toEqual(["ses_recent"]);
  });

  test("returns [] when the DB lacks the expected schema", () => {
    const base = makeTempDir("akm-opencode-db-badschema-");
    const db = openDatabase(path.join(base, "opencode.db"), { create: true });
    db.exec("CREATE TABLE unrelated (x TEXT);");
    db.close();
    expect(new OpenCodeProvider().listSessions({ location: base })).toEqual([]);
  });
});

describe("OpenCodeProvider.readSession (opencode.db)", () => {
  test("reads messages, joins text parts, and extracts inline refs", () => {
    const base = makeTempDir("akm-opencode-db-read-");
    writeOpenCodeDb(base, [
      {
        id: "ses_full",
        title: "Real session",
        directory: "/home/user/proj",
        created: 1700000000000,
        updated: 1700010000000,
        messages: [
          { id: "msg_a", role: "user", created: 1700000100000, texts: [`Let me run akm remember "auth uses JWT now"`] },
          { id: "msg_b", role: "assistant", created: 1700000200000, texts: ["Done.", "Suggested a fix."] },
        ],
      },
    ]);

    const provider = new OpenCodeProvider();
    const summary = provider.listSessions({ location: base })[0];
    if (!summary) throw new Error("test fixture missing session summary");
    const data = provider.readSession(summary);

    expect(data.ref.harness).toBe("opencode");
    expect(data.ref.title).toBe("Real session");
    expect(data.events).toHaveLength(2);
    expect(data.events[0]?.role).toBe("user");
    expect(data.events[0]?.text).toContain("auth uses JWT");
    expect(data.events[1]?.text).toBe("Done.\nSuggested a fix.");
    expect(data.inlineRefs).toHaveLength(1);
    expect(data.inlineRefs[0]).toMatchObject({ kind: "remember", text: "auth uses JWT now" });
  });

  test("skips messages with no text parts", () => {
    const base = makeTempDir("akm-opencode-db-notext-");
    writeOpenCodeDb(base, [
      {
        id: "ses_empty",
        title: "x",
        directory: "/d",
        created: 1700000000000,
        updated: 1700000000000,
        messages: [{ id: "msg_a", role: "assistant", created: 1700000100000, texts: [] }],
      },
    ]);

    const provider = new OpenCodeProvider();
    const summary = provider.listSessions({ location: base })[0];
    if (!summary) throw new Error("test fixture missing session summary");
    const data = provider.readSession(summary);
    expect(data.events).toEqual([]);
    expect(data.inlineRefs).toEqual([]);
  });
});
