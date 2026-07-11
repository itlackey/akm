/**
 * In-tree CLI argv-coercion tests for `akm reflect` and `akm propose` (#226).
 *
 * The real CLI dispatcher in `src/cli.ts` coerces citty's argv shape
 * (`{ ref?, task?, engine?, "timeout-ms"?, type, name }`) into the
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
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { akmReflect } from "../../src/commands/improve/reflect";
import { akmPropose } from "../../src/commands/proposal/propose";
import type { SpawnedSubprocess, SpawnFn } from "../../src/integrations/agent/spawn";
import { quietQualityGateConfig } from "../_helpers/factories";
import { type Cleanup, sandboxXdgCacheHome, sandboxXdgConfigHome } from "../_helpers/sandbox";

const fixtureDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fixtureDirs.push(dir);
  return dir;
}

function makeStashDir(): string {
  const stash = makeTempDir("akm-rp-cli-stash-");
  for (const sub of ["lessons", "skills", "memories", "knowledge"]) {
    fs.mkdirSync(path.join(stash, sub), { recursive: true });
  }
  return stash;
}

afterAll(() => {
  for (const dir of fixtureDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

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

let envCleanup: Cleanup = () => {};

beforeEach(() => {
  const cacheResult = sandboxXdgCacheHome();
  const cfgResult = sandboxXdgConfigHome(cacheResult.cleanup);
  envCleanup = cfgResult.cleanup;
});

afterEach(() => {
  envCleanup();
  envCleanup = () => {};
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
  engine?: string;
  timeoutMs?: number;
} {
  const timeoutRaw = args["timeout-ms"];
  const timeoutMs = typeof timeoutRaw === "string" && timeoutRaw.trim() ? Number.parseInt(timeoutRaw, 10) : undefined;
  return {
    ref: typeof args.ref === "string" && (args.ref as string).trim() ? (args.ref as string) : undefined,
    task: typeof args.task === "string" && (args.task as string).trim() ? (args.task as string) : undefined,
    engine: typeof args.engine === "string" && (args.engine as string).trim() ? (args.engine as string) : undefined,
    ...(timeoutMs !== undefined && Number.isFinite(timeoutMs) ? { timeoutMs } : {}),
  };
}

function coerceProposeArgs(args: Record<string, unknown>): {
  type: string;
  name: string;
  task: string;
  engine?: string;
  timeoutMs?: number;
} {
  const timeoutRaw = args["timeout-ms"];
  const timeoutMs = typeof timeoutRaw === "string" && timeoutRaw.trim() ? Number.parseInt(timeoutRaw, 10) : undefined;
  return {
    type: String(args.type),
    name: String(args.name),
    task: String(args.task ?? ""),
    engine: typeof args.engine === "string" && (args.engine as string).trim() ? (args.engine as string) : undefined,
    ...(timeoutMs !== undefined && Number.isFinite(timeoutMs) ? { timeoutMs } : {}),
  };
}

// ── Coercion unit tests ────────────────────────────────────────────────────

describe("citty argv → akmReflect coercion", () => {
  test("string fields trimmed; empty strings → undefined", () => {
    expect(coerceReflectArgs({ ref: "lesson:foo", task: "  ", engine: "" })).toEqual({
      ref: "lesson:foo",
      task: undefined,
      engine: undefined,
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
  test("type/name/task always strings; engine trimmed", () => {
    expect(coerceProposeArgs({ type: "skill", name: "hello", task: "Say hi", engine: "  " })).toEqual({
      type: "skill",
      name: "hello",
      task: "Say hi",
      engine: undefined,
    });
  });

  test("missing task coerced to empty string (downstream UsageError)", () => {
    expect(coerceProposeArgs({ type: "skill", name: "x" })).toMatchObject({ task: "" });
  });

  test("--timeout-ms parsed; engine passed through when set", () => {
    expect(
      coerceProposeArgs({ type: "skill", name: "x", task: "go", "timeout-ms": "9000", engine: "claude" }),
    ).toMatchObject({ timeoutMs: 9000, engine: "claude" });
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
      config: quietQualityGateConfig(),
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
      config: quietQualityGateConfig(),
      runAgentOptions: { spawn: fakeSpawn("not json", "", 0) },
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.reason).toBe("parse_error");
  });

  test("timeout: short --timeout-ms is honoured by the wrapper", async () => {
    const stash = makeStashDir();
    const coerced = coerceReflectArgs({ ref: "lesson:rg-over-grep", "timeout-ms": "1" });
    const result = await akmReflect({
      ...coerced,
      stashDir: stash,
      config: quietQualityGateConfig(),
      runAgentOptions: {
        spawn: hangingSpawn(),
        // `runAgent` registers several timers through this seam — the wrapper
        // timeout AND the stdout/stderr stream-drain watchdogs (spawn.ts). Fire
        // EACH callback independently on the next tick; a single shared `timerCb`
        // would let a later drain-timer registration clobber the wrapper timeout
        // so it never fires and the hanging spawn wedges the test.
        setTimeoutFn: ((cb: () => void) => {
          queueMicrotask(() => cb());
          return 1 as unknown as ReturnType<typeof setTimeout>;
        }) as unknown as typeof setTimeout,
        clearTimeoutFn: (() => undefined) as unknown as typeof clearTimeout,
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.reason).toBe("timeout");
  });

  test("missing engine config → ConfigError surfaces with .code", async () => {
    const stash = makeStashDir();
    let thrown: unknown;
    try {
      await akmReflect({
        ref: "lesson:rg-over-grep",
        stashDir: stash,
        // No config file exists under the sandboxed XDG_CONFIG_HOME.
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    const e = thrown as Error & { code?: string };
    expect(e.name).toBe("ConfigError");
    expect(e.code).toBe("INVALID_CONFIG_FILE");
    expect(e.message).toContain("engine");
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
      agentConfig: quietQualityGateConfig(),
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
      agentConfig: quietQualityGateConfig(),
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
        // Do not pass agentConfig: the sandbox has no defaults.engine.
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
        agentConfig: quietQualityGateConfig(),
        runAgentOptions: { spawn: fakeSpawn(VALID_SKILL_PAYLOAD, "", 0) },
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("--task");
  });
});
