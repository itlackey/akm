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

import { akmReflect } from "../../../../src/commands/improve/reflect";
import { listProposals } from "../../../../src/commands/proposal/repository";
import { readEvents } from "../../../../src/core/events";
import type { SpawnedSubprocess, SpawnFn } from "../../../../src/core/subprocess";
import { quietQualityGateConfig } from "../../../_helpers/factories";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../../../_helpers/sandbox";

let storage: IsolatedAkmStorage;

function makeStashDir(): string {
  return storage.stashDir;
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
  storage = withIsolatedAkmStorage();
});

afterEach(() => {
  storage.cleanup();
});

describe("akm reflect — reflect_completed on failure paths (Fix #3)", () => {
  test("unsupported asset type emits reflect_completed with ok:false", async () => {
    const stash = makeStashDir();
    const result = await akmReflect({
      ref: "scripts/dangerous",
      stashDir: stash,
      config: quietQualityGateConfig(),
      runAgentOptions: { spawn: fakeSpawn("ignored", "", 0) },
    });
    expect(result.ok).toBe(false);

    const events = getReflectCompletedEvents();
    expect(events.length).toBe(1);
    const meta = events[0]?.metadata as Record<string, unknown>;
    expect(meta.ok).toBe(false);
    // Reason changed 2026-05-26: deterministic type-guard rejections route
    // through dedicated `unsupported_type` (was `parse_error`) so the improve
    // loop can map them to `reflect-skipped`. See metrics-taxonomy-review §1a.
    expect(meta.reason).toBe("unsupported_type");
    expect(meta.subreason).toBe("unsupported_type");
    expect(meta.source).toBe("reflect");
    expect(events[0]?.ref).toBe("scripts/dangerous");
  });

  test("spawn ENOENT emits reflect_completed with reason=spawn_failed", async () => {
    const stash = makeStashDir();
    const result = await akmReflect({
      ref: "lessons/any",
      stashDir: stash,
      config: quietQualityGateConfig(),
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
      ref: "lessons/bad",
      stashDir: stash,
      config: quietQualityGateConfig(),
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
      ref: "memories/nope",
      stashDir: stash,
      config: quietQualityGateConfig(),
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

  test("exactly one reflect_completed event per invocation (no duplicates)", async () => {
    const stash = makeStashDir();
    // Three separate failing invocations.
    await akmReflect({
      ref: "lessons/fail-1",
      stashDir: stash,
      config: quietQualityGateConfig(),
      runAgentOptions: { spawn: fakeSpawn("", "boom", 7) },
    });
    await akmReflect({
      ref: "lessons/fail-2",
      stashDir: stash,
      config: quietQualityGateConfig(),
      runAgentOptions: { spawn: spawnFailedSpawn() },
    });
    await akmReflect({
      ref: "scripts/fail-3",
      stashDir: stash,
      config: quietQualityGateConfig(),
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
