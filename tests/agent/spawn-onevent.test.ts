// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `RunAgentOptions.onEvent` — the additive observability seam (redesign
 * addendum R2, `workflow watch` batch). Contract:
 *
 *   - `spawn_start` fires once after a successful spawn, `spawn_exit` once
 *     after the child finishes — ids/status only (profile name, pid, exit
 *     code, status enum), never prompt/stdout/stderr content.
 *   - No events fire when the child was never spawned (synchronous spawn
 *     failure, pre-spawn abort).
 *   - A throwing callback is swallowed: observability never breaks dispatch.
 */

import { describe, expect, test } from "bun:test";
import type { AgentProfile } from "../../src/integrations/agent/profiles";
import type { SpawnedSubprocess, SpawnFn } from "../../src/integrations/agent/spawn";
import { runAgent } from "../../src/integrations/agent/spawn";

type SpawnEvent = { type: string; data?: Record<string, unknown> };

function makeProfile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    name: "test-agent",
    bin: "test-agent",
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

function fakeSpawn(config: { exitCode: number; pid?: number; throwSync?: Error; stdout?: string }): SpawnFn {
  return () => {
    if (config.throwSync) throw config.throwSync;
    const proc: SpawnedSubprocess = {
      exitCode: config.exitCode,
      exited: Promise.resolve(config.exitCode),
      stdout: asReadableStream(config.stdout ?? "secret agent output"),
      stderr: asReadableStream(""),
      stdin: null,
      ...(config.pid !== undefined ? { pid: config.pid } : {}),
      kill() {},
    };
    return proc;
  };
}

describe("runAgent onEvent seam", () => {
  test("fires spawn_start then spawn_exit with ids/status only on a clean exit", async () => {
    const events: SpawnEvent[] = [];
    const result = await runAgent(makeProfile(), "go", {
      spawn: fakeSpawn({ exitCode: 0, pid: 4242 }),
      onEvent: (evt) => events.push(evt),
    });

    expect(result.ok).toBe(true);
    expect(events.map((e) => e.type)).toEqual(["spawn_start", "spawn_exit"]);
    expect(events[0]?.data).toEqual({ profile: "test-agent", pid: 4242 });
    expect(events[1]?.data).toEqual({ profile: "test-agent", pid: 4242, exitCode: 0, status: "ok" });
    // Ids/status only — never the prompt or captured output content.
    for (const evt of events) {
      expect(JSON.stringify(evt)).not.toContain("secret agent output");
      expect(JSON.stringify(evt)).not.toContain("go");
    }
  });

  test("spawn_exit carries the non-zero exit status", async () => {
    const events: SpawnEvent[] = [];
    const result = await runAgent(makeProfile(), "go", {
      spawn: fakeSpawn({ exitCode: 7 }),
      onEvent: (evt) => events.push(evt),
    });

    expect(result.reason).toBe("non_zero_exit");
    expect(events.map((e) => e.type)).toEqual(["spawn_start", "spawn_exit"]);
    // Test fakes have no pid — the field is simply absent, never fabricated.
    expect(events[1]?.data).toEqual({ profile: "test-agent", exitCode: 7, status: "non_zero_exit" });
  });

  test("no events fire when the spawn itself fails synchronously", async () => {
    const events: SpawnEvent[] = [];
    const result = await runAgent(makeProfile(), "go", {
      spawn: fakeSpawn({ exitCode: 0, throwSync: new Error("ENOENT") }),
      onEvent: (evt) => events.push(evt),
    });

    expect(result.reason).toBe("spawn_failed");
    expect(events).toEqual([]);
  });

  test("no events fire on a pre-spawn abort (child never started)", async () => {
    const events: SpawnEvent[] = [];
    const controller = new AbortController();
    controller.abort();
    const result = await runAgent(makeProfile(), "go", {
      spawn: fakeSpawn({ exitCode: 0 }),
      signal: controller.signal,
      onEvent: (evt) => events.push(evt),
    });

    expect(result.reason).toBe("aborted");
    expect(events).toEqual([]);
  });

  test("a throwing onEvent callback never breaks the dispatch", async () => {
    const result = await runAgent(makeProfile(), "go", {
      spawn: fakeSpawn({ exitCode: 0 }),
      onEvent: () => {
        throw new Error("observer exploded");
      },
    });

    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
  });
});
