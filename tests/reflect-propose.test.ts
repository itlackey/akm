/**
 * Mock-CLI tests for `akm reflect` and `akm propose` (#226).
 *
 * These exercise the proposal-producer pipeline end-to-end without spawning
 * a real agent CLI. We inject a fake {@link SpawnFn} (the same seam locked
 * by `tests/architecture/agent-spawn-seam.test.ts`) so failure-reason
 * branches are deterministic.
 *
 * Coverage:
 *   • Happy path → proposal materialised in the queue.
 *   • Each {@link AgentFailureReason} → no proposal, ok:false envelope.
 *   • `reflect_invoked` / `propose_invoked` events emitted at command entry
 *     even when the agent fails.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { akmPropose } from "../src/commands/propose";
import { akmReflect } from "../src/commands/reflect";
import { appendEvent, readEvents } from "../src/core/events";
import { listProposals } from "../src/core/proposals";
import type { AgentProfile } from "../src/integrations/agent/profiles";
import type { SpawnedSubprocess, SpawnFn } from "../src/integrations/agent/spawn";

// ── Setup ──────────────────────────────────────────────────────────────────

const tempDirs: string[] = [];
const savedEnv = {
  AKM_STASH_DIR: process.env.AKM_STASH_DIR,
  XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
};

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeStashDir(): string {
  const stash = makeTempDir("akm-reflect-stash-");
  for (const dir of ["lessons", "skills", "memories", "knowledge"]) {
    fs.mkdirSync(path.join(stash, dir), { recursive: true });
  }
  return stash;
}

function makeProfile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    name: "fake-agent",
    bin: "fake-agent",
    args: [],
    stdio: "captured",
    envPassthrough: ["PATH"],
    parseOutput: "text",
    ...overrides,
  };
}

function asReadableStream(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function fakeSpawn(stdout: string, stderr: string, exitCode: number): SpawnFn {
  return () => {
    const proc: SpawnedSubprocess = {
      exitCode,
      exited: Promise.resolve(exitCode),
      stdout: asReadableStream(stdout),
      stderr: asReadableStream(stderr),
      stdin: null,
      kill: () => undefined,
    };
    return proc;
  };
}

function fakeSpawnWithCapture(
  stdout: string,
  stderr: string,
  exitCode: number,
  capture: (cmd: string[]) => void,
): SpawnFn {
  return (cmd) => {
    capture(cmd);
    return fakeSpawn(stdout, stderr, exitCode)(cmd, {});
  };
}

function spawnFailedSpawn(): SpawnFn {
  return () => {
    throw new Error("spawn ENOENT fake-agent");
  };
}

function hangingSpawn(): SpawnFn {
  return () => {
    let resolveExit: ((code: number) => void) | undefined;
    const exited = new Promise<number>((r) => {
      resolveExit = r;
    });
    const proc: SpawnedSubprocess = {
      exitCode: null,
      exited,
      stdout: asReadableStream(""),
      stderr: asReadableStream(""),
      stdin: null,
      kill: () => resolveExit?.(143),
    };
    return proc;
  };
}

const VALID_LESSON_PAYLOAD = JSON.stringify({
  ref: "lesson:rg-over-grep",
  content:
    "---\ndescription: Use ripgrep before grep\nwhen_to_use: Searching large repos for patterns\n---\n\nPrefer rg.\n",
  frontmatter: { description: "Use ripgrep before grep", when_to_use: "Searching large repos for patterns" },
});

const VALID_SKILL_PAYLOAD = JSON.stringify({
  ref: "skill:hello",
  content: "---\ndescription: Say hi\nwhen_to_use: When greeting\n---\n\nSay hi politely.\n",
});

beforeEach(() => {
  process.env.XDG_CACHE_HOME = makeTempDir("akm-reflect-cache-");
  process.env.XDG_CONFIG_HOME = makeTempDir("akm-reflect-config-");
});

afterEach(() => {
  if (savedEnv.AKM_STASH_DIR === undefined) delete process.env.AKM_STASH_DIR;
  else process.env.AKM_STASH_DIR = savedEnv.AKM_STASH_DIR;
  if (savedEnv.XDG_CACHE_HOME === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = savedEnv.XDG_CACHE_HOME;
  if (savedEnv.XDG_CONFIG_HOME === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = savedEnv.XDG_CONFIG_HOME;
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── reflect ─────────────────────────────────────────────────────────────────

describe("akm reflect", () => {
  test("happy path: produces a queued proposal with source=reflect", async () => {
    const stash = makeStashDir();
    const result = await akmReflect({
      ref: "lesson:rg-over-grep",
      stashDir: stash,
      agentProfile: makeProfile(),
      runAgentOptions: { spawn: fakeSpawn(VALID_LESSON_PAYLOAD, "", 0) },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.proposal.source).toBe("reflect");
    expect(result.proposal.ref).toBe("lesson:rg-over-grep");
    expect(result.proposal.payload.content).toContain("Prefer rg");

    const proposals = listProposals(stash);
    expect(proposals.length).toBe(1);
    expect(proposals[0]?.id).toBe(result.proposal.id);

    const events = readEvents({ type: "reflect_invoked" });
    expect(events.events.length).toBe(1);
    expect(events.events[0]?.ref).toBe("lesson:rg-over-grep");
  });

  test("emits reflect_invoked even when the agent fails", async () => {
    const stash = makeStashDir();
    const result = await akmReflect({
      ref: "lesson:bad",
      stashDir: stash,
      agentProfile: makeProfile(),
      runAgentOptions: { spawn: fakeSpawn("", "boom", 7) },
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.reason).toBe("non_zero_exit");
    expect(result.exitCode).toBe(7);
    expect(listProposals(stash).length).toBe(0);

    const events = readEvents({ type: "reflect_invoked" });
    expect(events.events.length).toBe(1);
  });

  test("spawn_failed → no proposal, structured envelope", async () => {
    const stash = makeStashDir();
    const result = await akmReflect({
      ref: "lesson:any",
      stashDir: stash,
      agentProfile: makeProfile(),
      runAgentOptions: { spawn: spawnFailedSpawn() },
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.reason).toBe("spawn_failed");
    expect(listProposals(stash).length).toBe(0);
  });

  test("parse_error → agent stdout is not a valid proposal payload", async () => {
    const stash = makeStashDir();
    const result = await akmReflect({
      ref: "lesson:any",
      stashDir: stash,
      agentProfile: makeProfile(),
      runAgentOptions: { spawn: fakeSpawn("not a json object", "", 0) },
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.reason).toBe("parse_error");
    expect(listProposals(stash).length).toBe(0);
  });

  test("timeout → no proposal, reason=timeout", async () => {
    const stash = makeStashDir();
    const fakeTimers: Array<{ id: number; cb: () => void }> = [];
    let nextId = 1;
    const setTimeoutFn = ((cb: () => void) => {
      const id = nextId++;
      fakeTimers.push({ id, cb });
      // Auto-fire on the next microtask so the test stays simple even though
      // `akmReflect` does an awaited `indexer.lookup()` call before reaching
      // `runAgent`. Since we are the only setTimeout caller in the wrapper
      // (runAgent's hard timeout), this is unambiguous.
      queueMicrotask(() => {
        const stillThere = fakeTimers.find((t) => t.id === id);
        if (stillThere) stillThere.cb();
      });
      return id;
    }) as unknown as typeof setTimeout;
    const clearTimeoutFn = ((id: number) => {
      const idx = fakeTimers.findIndex((t) => t.id === id);
      if (idx >= 0) fakeTimers.splice(idx, 1);
    }) as unknown as typeof clearTimeout;

    const result = await akmReflect({
      ref: "lesson:any",
      stashDir: stash,
      agentProfile: makeProfile(),
      timeoutMs: 5,
      runAgentOptions: { spawn: hangingSpawn(), setTimeoutFn, clearTimeoutFn },
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.reason).toBe("timeout");
    expect(listProposals(stash).length).toBe(0);
  });

  test("ref omitted: still queues a proposal when the agent supplies one", async () => {
    const stash = makeStashDir();
    appendEvent({
      eventType: "feedback",
      ref: "lesson:rg-over-grep",
      metadata: { signal: "negative", note: "too vague" },
    });
    appendEvent({ eventType: "feedback", ref: "skill:hello", metadata: { signal: "positive", note: "nice greeting" } });
    let prompt = "";
    const result = await akmReflect({
      stashDir: stash,
      task: "Focus on the highest-value recent signal",
      agentProfile: makeProfile(),
      runAgentOptions: {
        spawn: fakeSpawnWithCapture(VALID_LESSON_PAYLOAD, "", 0, (cmd) => {
          prompt = cmd.at(-1) ?? "";
        }),
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(listProposals(stash).length).toBe(1);
    expect(prompt).toContain("No target ref was supplied.");
    expect(prompt).toContain("lesson:rg-over-grep [negative] too vague");
    expect(prompt).toContain("skill:hello [positive] nice greeting");
    expect(prompt).toContain("Task / focus: Focus on the highest-value recent signal");

    const events = readEvents({ type: "reflect_invoked" });
    expect(events.events.length).toBe(1);
    // No ref on the event — we did not pass one in.
    expect(events.events[0]?.ref).toBeUndefined();
    expect(events.events[0]?.metadata?.task).toBe("Focus on the highest-value recent signal");
  });
});

// ── propose ────────────────────────────────────────────────────────────────

describe("akm propose", () => {
  test("happy path: produces a queued proposal with source=propose", async () => {
    const stash = makeStashDir();
    const result = await akmPropose({
      type: "skill",
      name: "hello",
      task: "Say hi politely",
      stashDir: stash,
      agentProfile: makeProfile(),
      runAgentOptions: { spawn: fakeSpawn(VALID_SKILL_PAYLOAD, "", 0) },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.proposal.source).toBe("propose");
    expect(result.proposal.ref).toBe("skill:hello");

    const proposals = listProposals(stash);
    expect(proposals.length).toBe(1);

    const events = readEvents({ type: "propose_invoked" });
    expect(events.events.length).toBe(1);
    expect(events.events[0]?.ref).toBe("skill:hello");
  });

  test("rejects unknown type with UsageError", async () => {
    const stash = makeStashDir();
    let thrown: unknown;
    try {
      await akmPropose({
        type: "nonsense-type",
        name: "anything",
        task: "do a thing",
        stashDir: stash,
        agentProfile: makeProfile(),
        runAgentOptions: { spawn: fakeSpawn(VALID_SKILL_PAYLOAD, "", 0) },
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("unknown asset type");
  });

  test("rejects missing task with UsageError", async () => {
    const stash = makeStashDir();
    let thrown: unknown;
    try {
      await akmPropose({
        type: "skill",
        name: "x",
        task: "",
        stashDir: stash,
        agentProfile: makeProfile(),
        runAgentOptions: { spawn: fakeSpawn(VALID_SKILL_PAYLOAD, "", 0) },
      });
    } catch (err) {
      thrown = err;
    }
    expect((thrown as Error).message).toContain("--task is required");
  });

  test("non_zero_exit: structured failure, no proposal, propose_invoked still emitted", async () => {
    const stash = makeStashDir();
    const result = await akmPropose({
      type: "skill",
      name: "hello",
      task: "Say hi",
      stashDir: stash,
      agentProfile: makeProfile(),
      runAgentOptions: { spawn: fakeSpawn("", "agent failed", 3) },
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.reason).toBe("non_zero_exit");
    expect(result.exitCode).toBe(3);
    expect(listProposals(stash).length).toBe(0);

    const events = readEvents({ type: "propose_invoked" });
    expect(events.events.length).toBe(1);
  });

  test("parse_error: agent returned malformed payload", async () => {
    const stash = makeStashDir();
    const result = await akmPropose({
      type: "skill",
      name: "hello",
      task: "Say hi",
      stashDir: stash,
      agentProfile: makeProfile(),
      runAgentOptions: { spawn: fakeSpawn('{"ref": "skill:hello"}', "", 0) }, // missing content
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.reason).toBe("parse_error");
    expect(listProposals(stash).length).toBe(0);
  });

  test("parse_error: rejects agent refs whose type does not match the requested type", async () => {
    const stash = makeStashDir();
    const mismatchedPayload = JSON.stringify({
      ref: "lesson:hello",
      content: "---\ndescription: Say hi\nwhen_to_use: When greeting\n---\n\nSay hi politely.\n",
    });
    const result = await akmPropose({
      type: "skill",
      name: "hello",
      task: "Say hi",
      stashDir: stash,
      agentProfile: makeProfile(),
      runAgentOptions: { spawn: fakeSpawn(mismatchedPayload, "", 0) },
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.reason).toBe("parse_error");
    expect(result.error).toContain("expected skill");
    expect(listProposals(stash).length).toBe(0);
  });

  test("spawn_failed: structured failure, no proposal", async () => {
    const stash = makeStashDir();
    const result = await akmPropose({
      type: "skill",
      name: "hello",
      task: "Say hi",
      stashDir: stash,
      agentProfile: makeProfile(),
      runAgentOptions: { spawn: spawnFailedSpawn() },
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.reason).toBe("spawn_failed");
    expect(listProposals(stash).length).toBe(0);
  });

  test("never writes to live stash content (only proposal queue)", async () => {
    const stash = makeStashDir();
    const result = await akmPropose({
      type: "skill",
      name: "hello",
      task: "Say hi politely",
      stashDir: stash,
      agentProfile: makeProfile(),
      runAgentOptions: { spawn: fakeSpawn(VALID_SKILL_PAYLOAD, "", 0) },
    });
    expect(result.ok).toBe(true);
    // The skill file should NOT be materialised — only the proposal entry.
    const skillsDir = path.join(stash, "skills");
    const entries = fs.readdirSync(skillsDir);
    expect(entries.filter((e) => e !== ".akm")).toEqual([]);
    // Proposal queue has exactly one entry.
    const proposalsRoot = path.join(stash, ".akm", "proposals");
    expect(fs.existsSync(proposalsRoot)).toBe(true);
  });
});
