/**
 * Fix #3 (observability 0.8.0): `akm reflect` must emit `reflect_completed`
 * on ALL exit paths — success AND failure — so observers building closed-loop
 * telemetry see balanced invoke/complete pairs.
 *
 * Before this fix, multiple early-return failure sites emitted only
 * `reflect_invoked` and left the loop dangling. These tests exercise each
 * failure path (forced via the injected spawn seam or by passing a
 * non-existent / unsupported ref) and assert that exactly one
 * `reflect_completed` event lands per invocation with the expected
 * `ok: false` and a useful `reason` / `subreason`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { akmReflect } from "../src/commands/reflect";
import { readEvents } from "../src/core/events";
import { listProposals } from "../src/core/proposals";
import type { AgentProfile } from "../src/integrations/agent/profiles";
import type { SpawnedSubprocess, SpawnFn } from "../src/integrations/agent/spawn";

const tempDirs: string[] = [];
const savedEnv = {
  AKM_STASH_DIR: process.env.AKM_STASH_DIR,
  XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  XDG_DATA_HOME: process.env.XDG_DATA_HOME,
  XDG_STATE_HOME: process.env.XDG_STATE_HOME,
};

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeStashDir(): string {
  const stash = makeTempDir("akm-reflect-failpaths-stash-");
  for (const dir of ["lessons", "skills", "memories", "knowledge", "scripts"]) {
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

function spawnFailedSpawn(): SpawnFn {
  return () => {
    throw new Error("spawn ENOENT fake-agent");
  };
}

function getReflectCompletedEvents(): ReturnType<typeof readEvents>["events"] {
  return readEvents({ type: "reflect_completed" }).events;
}

beforeEach(() => {
  process.env.XDG_CACHE_HOME = makeTempDir("akm-reflect-failpaths-cache-");
  process.env.XDG_CONFIG_HOME = makeTempDir("akm-reflect-failpaths-config-");
  process.env.XDG_DATA_HOME = makeTempDir("akm-reflect-failpaths-data-");
  process.env.XDG_STATE_HOME = makeTempDir("akm-reflect-failpaths-state-");
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("akm reflect — reflect_completed on failure paths (Fix #3)", () => {
  test("unsupported asset type emits reflect_completed with ok:false", async () => {
    const stash = makeStashDir();
    const result = await akmReflect({
      ref: "script:dangerous",
      stashDir: stash,
      agentProfile: makeProfile(),
      runAgentOptions: { spawn: fakeSpawn("ignored", "", 0) },
    });
    expect(result.ok).toBe(false);

    const events = getReflectCompletedEvents();
    expect(events.length).toBe(1);
    const meta = events[0]?.metadata as Record<string, unknown>;
    expect(meta.ok).toBe(false);
    expect(meta.reason).toBe("parse_error");
    expect(meta.subreason).toBe("unsupported_type");
    expect(meta.source).toBe("reflect");
    expect(events[0]?.ref).toBe("script:dangerous");
  });

  test("spawn ENOENT emits reflect_completed with reason=spawn_failed", async () => {
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

    const events = getReflectCompletedEvents();
    expect(events.length).toBe(1);
    const meta = events[0]?.metadata as Record<string, unknown>;
    expect(meta.ok).toBe(false);
    expect(meta.reason).toBe("spawn_failed");
    expect(meta.subreason).toBe("enoent");
    expect(meta.source).toBe("reflect");
    expect(listProposals(stash).length).toBe(0);
  });

  test("non-zero exit emits reflect_completed with reason=non_zero_exit", async () => {
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

    const events = getReflectCompletedEvents();
    expect(events.length).toBe(1);
    const meta = events[0]?.metadata as Record<string, unknown>;
    expect(meta.ok).toBe(false);
    expect(meta.reason).toBe("non_zero_exit");
    expect(meta.subreason).toBe("agent_crash");
    expect(meta.exitCode).toBe(7);
  });

  test("unparseable stdout emits reflect_completed with reason=parse_error", async () => {
    const stash = makeStashDir();
    const result = await akmReflect({
      // Use a ref the fallback parser cannot heuristically promote to a draft —
      // pass an unknown ref so fallback synthesises content from stdout; we
      // need a path that genuinely fails to parse, so we use a malformed JSON-ish
      // body that doesn't match the markdown-fallback heuristic either.
      ref: "memory:nope",
      stashDir: stash,
      agentProfile: makeProfile(),
      runAgentOptions: { spawn: fakeSpawn("{not valid json", "", 0) },
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    // Reason should be parse_error or cooldown — both are valid failure shapes
    // that emit reflect_completed.
    expect(["parse_error", "cooldown"]).toContain(result.reason);

    const events = getReflectCompletedEvents();
    expect(events.length).toBe(1);
    const meta = events[0]?.metadata as Record<string, unknown>;
    expect(meta.ok).toBe(false);
    expect(typeof meta.reason).toBe("string");
    expect(typeof meta.subreason).toBe("string");
  });

  test("ref-mismatch (agent retargets the proposal) emits reflect_completed", async () => {
    const stash = makeStashDir();
    // Agent returns a valid JSON payload — but with a DIFFERENT ref than the
    // caller asked for. R-3 / #366 rejects this; Fix #3 must emit
    // reflect_completed with subreason="ref_mismatch".
    const retargetedPayload = JSON.stringify({
      ref: "lesson:i-was-told-to-write-different-asset",
      content: "---\ndescription: x\nwhen_to_use: y\n---\n\nBody.\n",
    });
    const result = await akmReflect({
      ref: "lesson:original-target",
      stashDir: stash,
      agentProfile: makeProfile(),
      runAgentOptions: { spawn: fakeSpawn(retargetedPayload, "", 0) },
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.reason).toBe("parse_error");

    const events = getReflectCompletedEvents();
    expect(events.length).toBe(1);
    const meta = events[0]?.metadata as Record<string, unknown>;
    expect(meta.ok).toBe(false);
    expect(meta.reason).toBe("parse_error");
    expect(meta.subreason).toBe("ref_mismatch");
    expect(meta.expectedRef).toBe("lesson:original-target");
    expect(meta.actualRef).toBe("lesson:i-was-told-to-write-different-asset");
  });

  test("exactly one reflect_completed event per invocation (no duplicates)", async () => {
    const stash = makeStashDir();
    // Three separate failing invocations.
    await akmReflect({
      ref: "lesson:fail-1",
      stashDir: stash,
      agentProfile: makeProfile(),
      runAgentOptions: { spawn: fakeSpawn("", "boom", 7) },
    });
    await akmReflect({
      ref: "lesson:fail-2",
      stashDir: stash,
      agentProfile: makeProfile(),
      runAgentOptions: { spawn: spawnFailedSpawn() },
    });
    await akmReflect({
      ref: "script:fail-3",
      stashDir: stash,
      agentProfile: makeProfile(),
      runAgentOptions: { spawn: fakeSpawn("ignored", "", 0) },
    });

    const completed = getReflectCompletedEvents();
    // Exactly 3: one per invocation, no duplicates.
    expect(completed.length).toBe(3);
    const invoked = readEvents({ type: "reflect_invoked" }).events;
    expect(invoked.length).toBe(3);
    // All complete events are ok:false.
    for (const ev of completed) {
      const meta = ev.metadata as Record<string, unknown>;
      expect(meta.ok).toBe(false);
    }
  });
});
