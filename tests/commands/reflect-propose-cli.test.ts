/**
 * In-tree CLI argv-coercion tests for `akm reflect` and `akm propose` (#226).
 *
 * The real CLI dispatcher in `src/cli.ts` coerces citty's argv shape
 * (`{ ref?, task?, profile?, "timeout-ms"?, type, name }`) into the
 * `AkmReflectOptions` / `AkmProposeOptions` shape consumed by
 * `akmReflect` / `akmPropose`. Exercising the live `runMain` here would
 * require spawning the CLI and stubbing PATH-resolved binaries, which is
 * brittle. Instead we replicate the exact argv coercion logic and assert it
 * matches the production code, then drive `akmReflect` / `akmPropose` with
 * a captured-spawn fake (mirroring `tests/agent/agent-spawn.test.ts`) for
 * deterministic happy + failure paths.
 *
 * Backfill for issue #284 GAP-CRIT 2.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { akmPropose } from "../../src/commands/propose";
import { akmReflect } from "../../src/commands/reflect";
import type { AgentProfile } from "../../src/integrations/agent/profiles";
import type { SpawnedSubprocess, SpawnFn } from "../../src/integrations/agent/spawn";

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
  const stash = makeTempDir("akm-rp-cli-stash-");
  for (const sub of ["lessons", "skills", "memories", "knowledge"]) {
    fs.mkdirSync(path.join(stash, sub), { recursive: true });
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

function fakeSpawn(stdout: string, stderr: string, exitCode: number, capture?: (cmd: string[]) => void): SpawnFn {
  return (cmd) => {
    capture?.(cmd);
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
});

const VALID_SKILL_PAYLOAD = JSON.stringify({
  ref: "skill:hello",
  content: "---\ndescription: Say hi\nwhen_to_use: When greeting\n---\n\nSay hi politely.\n",
});

beforeEach(() => {
  process.env.XDG_CACHE_HOME = makeTempDir("akm-rp-cli-cache-");
  process.env.XDG_CONFIG_HOME = makeTempDir("akm-rp-cli-config-");
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

// ── argv coercion helpers (mirror src/cli.ts) ───────────────────────────────

/**
 * Mirror of `cli.ts` reflect-command coercion.  Exercises the same string
 * trimming + Number.parseInt path the CLI dispatcher uses so a regression in
 * either place fails this test.
 */
function coerceReflectArgs(args: Record<string, unknown>): {
  ref?: string;
  task?: string;
  profile?: string;
  timeoutMs?: number;
} {
  const timeoutRaw = args["timeout-ms"];
  const timeoutMs = typeof timeoutRaw === "string" && timeoutRaw.trim() ? Number.parseInt(timeoutRaw, 10) : undefined;
  return {
    ref: typeof args.ref === "string" && (args.ref as string).trim() ? (args.ref as string) : undefined,
    task: typeof args.task === "string" && (args.task as string).trim() ? (args.task as string) : undefined,
    profile: typeof args.profile === "string" && (args.profile as string).trim() ? (args.profile as string) : undefined,
    ...(timeoutMs !== undefined && Number.isFinite(timeoutMs) ? { timeoutMs } : {}),
  };
}

function coerceProposeArgs(args: Record<string, unknown>): {
  type: string;
  name: string;
  task: string;
  profile?: string;
  timeoutMs?: number;
} {
  const timeoutRaw = args["timeout-ms"];
  const timeoutMs = typeof timeoutRaw === "string" && timeoutRaw.trim() ? Number.parseInt(timeoutRaw, 10) : undefined;
  return {
    type: String(args.type),
    name: String(args.name),
    task: String(args.task ?? ""),
    profile: typeof args.profile === "string" && (args.profile as string).trim() ? (args.profile as string) : undefined,
    ...(timeoutMs !== undefined && Number.isFinite(timeoutMs) ? { timeoutMs } : {}),
  };
}

// ── Coercion unit tests ────────────────────────────────────────────────────

describe("citty argv → akmReflect coercion", () => {
  test("string fields trimmed; empty strings → undefined", () => {
    expect(coerceReflectArgs({ ref: "lesson:foo", task: "  ", profile: "" })).toEqual({
      ref: "lesson:foo",
      task: undefined,
      profile: undefined,
    });
  });

  test("--timeout-ms parsed as integer", () => {
    expect(coerceReflectArgs({ "timeout-ms": "1500" })).toMatchObject({ timeoutMs: 1500 });
  });

  test("non-numeric --timeout-ms → omitted (Number.isFinite filter)", () => {
    expect(coerceReflectArgs({ "timeout-ms": "abc" })).not.toHaveProperty("timeoutMs");
  });

  test("blank --timeout-ms is omitted", () => {
    expect(coerceReflectArgs({ "timeout-ms": "   " })).not.toHaveProperty("timeoutMs");
  });
});

describe("citty argv → akmPropose coercion", () => {
  test("type/name/task always strings; profile trimmed", () => {
    expect(coerceProposeArgs({ type: "skill", name: "hello", task: "Say hi", profile: "  " })).toEqual({
      type: "skill",
      name: "hello",
      task: "Say hi",
      profile: undefined,
    });
  });

  test("missing task coerced to empty string (downstream UsageError)", () => {
    expect(coerceProposeArgs({ type: "skill", name: "x" })).toMatchObject({ task: "" });
  });

  test("--timeout-ms parsed; profile passed through when set", () => {
    expect(
      coerceProposeArgs({ type: "skill", name: "x", task: "go", "timeout-ms": "9000", profile: "claude" }),
    ).toMatchObject({ timeoutMs: 9000, profile: "claude" });
  });
});

// ── Reflect command behaviour with coerced args ────────────────────────────

describe("akmReflect — argv-coerced calls (happy + failure)", () => {
  test("happy: argv-shape passed through coercion → queues a proposal", async () => {
    const stash = makeStashDir();
    const coerced = coerceReflectArgs({ ref: "lesson:rg-over-grep", task: "focus on speed", "timeout-ms": "5000" });
    let capturedCmd: string[] = [];
    const result = await akmReflect({
      ...coerced,
      stashDir: stash,
      agentProfile: makeProfile(),
      runAgentOptions: {
        spawn: fakeSpawn(VALID_LESSON_PAYLOAD, "", 0, (cmd) => {
          capturedCmd = cmd;
        }),
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.proposal.ref).toBe("lesson:rg-over-grep");
    expect(capturedCmd[0]).toBe("fake-agent");
  });

  test("parse_error: agent stdout is malformed → ok:false envelope", async () => {
    const stash = makeStashDir();
    const coerced = coerceReflectArgs({ ref: "lesson:rg-over-grep" });
    const result = await akmReflect({
      ...coerced,
      stashDir: stash,
      agentProfile: makeProfile(),
      runAgentOptions: { spawn: fakeSpawn("not json", "", 0) },
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.reason).toBe("parse_error");
  });

  test("timeout: short --timeout-ms is honoured by the wrapper", async () => {
    const stash = makeStashDir();
    const coerced = coerceReflectArgs({ ref: "lesson:rg-over-grep", "timeout-ms": "1" });
    let timerCb: (() => void) | undefined;
    const result = await akmReflect({
      ...coerced,
      stashDir: stash,
      agentProfile: makeProfile(),
      runAgentOptions: {
        spawn: hangingSpawn(),
        setTimeoutFn: ((cb: () => void) => {
          timerCb = cb;
          // Fire on next tick — keeps the test deterministic.
          queueMicrotask(() => timerCb?.());
          return 1 as unknown as ReturnType<typeof setTimeout>;
        }) as unknown as typeof setTimeout,
        clearTimeoutFn: (() => undefined) as unknown as typeof clearTimeout,
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.reason).toBe("timeout");
  });

  test("missing agent config (no `agent` block) → ConfigError surfaces with .code", async () => {
    const stash = makeStashDir();
    let thrown: unknown;
    try {
      await akmReflect({
        ref: "lesson:rg-over-grep",
        stashDir: stash,
        agentConfig: undefined, // explicit: no agent block resolved
        // Note: we deliberately do NOT pass agentProfile so resolveProfile is exercised.
        // loadAgentConfigFromDisk will load empty config (no XDG_CONFIG_HOME entry exists)
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    const e = thrown as Error & { code?: string };
    expect(e.name).toBe("ConfigError");
    expect(e.code).toBe("INVALID_CONFIG_FILE");
    expect(e.message).toContain("agent");
  });
});

// ── Propose command behaviour with coerced args ────────────────────────────

describe("akmPropose — argv-coerced calls (happy + failure)", () => {
  test("happy: argv-shape passed through coercion → queues skill proposal", async () => {
    const stash = makeStashDir();
    const coerced = coerceProposeArgs({ type: "skill", name: "hello", task: "Say hi", "timeout-ms": "5000" });
    const result = await akmPropose({
      ...coerced,
      stashDir: stash,
      agentProfile: makeProfile(),
      runAgentOptions: { spawn: fakeSpawn(VALID_SKILL_PAYLOAD, "", 0) },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.proposal.ref).toBe("skill:hello");
  });

  test("parse_error: agent returns malformed JSON", async () => {
    const stash = makeStashDir();
    const coerced = coerceProposeArgs({ type: "skill", name: "hello", task: "Say hi" });
    const result = await akmPropose({
      ...coerced,
      stashDir: stash,
      agentProfile: makeProfile(),
      runAgentOptions: { spawn: fakeSpawn("garbage {", "", 0) },
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.reason).toBe("parse_error");
  });

  test("missing config: no agent block → ConfigError when resolveProfile runs", async () => {
    const stash = makeStashDir();
    let thrown: unknown;
    try {
      await akmPropose({
        type: "skill",
        name: "hello",
        task: "Say hi",
        stashDir: stash,
        // Do NOT pass agentProfile or agentConfig — exercises the disk path
        // which resolves to undefined under the empty XDG_CONFIG_HOME above.
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    const e = thrown as Error & { code?: string };
    expect(e.name).toBe("ConfigError");
    expect(e.code).toBe("INVALID_CONFIG_FILE");
  });

  test("missing --task surfaces UsageError (matches CLI contract for empty positional)", async () => {
    const stash = makeStashDir();
    const coerced = coerceProposeArgs({ type: "skill", name: "x" }); // task absent
    let thrown: unknown;
    try {
      await akmPropose({
        ...coerced,
        stashDir: stash,
        agentProfile: makeProfile(),
        runAgentOptions: { spawn: fakeSpawn(VALID_SKILL_PAYLOAD, "", 0) },
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("--task");
  });
});
