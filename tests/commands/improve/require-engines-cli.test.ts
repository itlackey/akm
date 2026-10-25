// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm improve --require-engines` (#957): abort before any indexing, lock, or
 * log side effect when the active strategy's plan already knows a process is
 * unavailable, instead of the default degrade-and-report-in-skippedProcesses
 * behavior. Drives the real `improveCommand` in-process via `runCliCapture`
 * (see tests/_helpers/cli.ts) — no real database is opened and no process is
 * spawned, so this belongs under `tests/`, not `tests/integration/`.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import type { akmImprove } from "../../../src/commands/improve/improve";
import {
  _setAkmImproveForTests,
  assertRequiredEnginesReachable,
  requiredEngineProbeTimeoutMs,
} from "../../../src/commands/improve/improve-cli";
import type { ResolvedImprovePlan } from "../../../src/commands/improve/improve-strategies";
import { runCliCapture } from "../../_helpers/cli";
import { makeSandboxDir, makeStashDir, type SandboxedDir, withEnv, writeSandboxConfig } from "../../_helpers/sandbox";

const disposers: SandboxedDir[] = [];

function freshEnv(stashDir: string): Record<string, string> {
  const home = makeSandboxDir("akm-require-engines-home");
  const cfg = makeSandboxDir("akm-require-engines-cfg");
  const cache = makeSandboxDir("akm-require-engines-cache");
  const data = makeSandboxDir("akm-require-engines-data");
  const state = makeSandboxDir("akm-require-engines-state");
  disposers.push(home, cfg, cache, data, state);
  return {
    AKM_BUNDLE_DIR: stashDir,
    HOME: home.dir,
    XDG_CONFIG_HOME: cfg.dir,
    XDG_CACHE_HOME: cache.dir,
    XDG_DATA_HOME: data.dir,
    XDG_STATE_HOME: state.dir,
  };
}

// A config with no connection or harness at all: the default strategy's deterministic triage needs none,
// so the plan resolves, and every process that does need one is unavailable.
function writeNothingConfiguredConfig(): void {
  writeSandboxConfig({
    configVersion: "0.9.0",
    semanticSearchMode: "off",
  });
}

afterEach(() => {
  _setAkmImproveForTests();
  for (const d of disposers.splice(0)) d.cleanup();
});

describe("akm improve --require-engines", () => {
  test("aborts with exit 78 before akmImprove runs, naming each process that has no connection or harness", async () => {
    const stash = makeStashDir();
    disposers.push(stash);
    const fakeAkmImprove = mock(async () => {
      throw new Error("akmImprove must not run when --require-engines aborts first");
    });
    _setAkmImproveForTests(fakeAkmImprove as unknown as typeof akmImprove);

    const result = await withEnv(freshEnv(stash.dir), async () => {
      writeNothingConfiguredConfig();
      return runCliCapture(["improve", "--dry-run", "--require-engines"]);
    });

    expect(result.code).toBe(78);
    expect(result.stderr).toContain("--require-engines");
    expect(result.stderr).toContain("reflect");
    expect(result.stderr).toContain("improve.processes.reflect.connection");
    expect(result.stderr).toContain("akm setup");
    expect(fakeAkmImprove).not.toHaveBeenCalled();
  });

  test("without the flag, the run proceeds and the result carries skippedProcesses", async () => {
    const stash = makeStashDir();
    disposers.push(stash);

    const result = await withEnv(freshEnv(stash.dir), async () => {
      writeNothingConfiguredConfig();
      return runCliCapture(["improve", "--dry-run"]);
    });

    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      ok: boolean;
      skippedProcesses?: Array<{ process: string; configKey: string; reason: string }>;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.skippedProcesses).toContainEqual(
      expect.objectContaining({
        process: "reflect",
        configKey: "improve.processes.reflect.connection",
        reason: expect.stringContaining("akm setup"),
      }),
    );
  });
});

/** Minimal `ResolvedImprovePlan` fixture: only the fields `collectRequiredEngineTargets` reads. */
function connectionRunner(name: string, endpoint: string, model: string, extra: Record<string, unknown> = {}) {
  return { kind: "connection", name, endpoint, model, request: {}, timeoutMs: null, ...extra };
}

function planWithTargets(
  processes: Record<string, { endpoint: string; model: string; engine: string }>,
): ResolvedImprovePlan {
  return {
    processes: Object.fromEntries(
      Object.entries(processes).map(([process, { endpoint, model, engine }]) => [
        process,
        { enabled: true, config: {}, runner: connectionRunner(engine, endpoint, model) },
      ]),
    ),
    triageJudgment: null,
  } as unknown as ResolvedImprovePlan;
}

describe("assertRequiredEnginesReachable — R17 engineProbe", () => {
  test("returns one outcome per target, with numeric latency, when every probe is reachable", async () => {
    const plan = planWithTargets({
      reflect: { endpoint: "https://a.example.test/v1", model: "model-a", engine: "engineA" },
      distill: { endpoint: "https://b.example.test/v1", model: "model-b", engine: "engineB" },
    });
    const probeReachable = mock(async () => ({ reachable: true }));

    const outcomes = await assertRequiredEnginesReachable(plan, probeReachable);

    expect(probeReachable).toHaveBeenCalledTimes(2);
    expect(outcomes).toHaveLength(2);
    expect(new Set(outcomes.map((o) => o.endpoint)).size).toBe(2);
    for (const outcome of outcomes) {
      expect(outcome.reachable).toBe(true);
      expect(Number.isFinite(outcome.latencyMs)).toBe(true);
      expect(outcome.latencyMs).toBeGreaterThanOrEqual(0);
    }
    expect(outcomes.map((o) => o.process).sort()).toEqual(["distill", "reflect"]);
  });

  test("the probe carries the connection's credential, read as a dispatch reads it", async () => {
    const plan = {
      processes: {
        reflect: {
          enabled: true,
          config: {},
          runner: connectionRunner("keyed", "https://keyed.example.test/v1", "keyed-model", {
            apiKey: "$AKM_PROBE_KEY_TEST",
          }),
        },
      },
    } as unknown as ResolvedImprovePlan;
    const seen: (string | undefined)[] = [];
    const probeReachable = mock(async (connection: { apiKey?: string }) => {
      seen.push(connection.apiKey);
      return { reachable: true };
    });
    process.env.AKM_PROBE_KEY_TEST = "probe-secret";
    try {
      await assertRequiredEnginesReachable(plan, probeReachable);
    } finally {
      delete process.env.AKM_PROBE_KEY_TEST;
    }
    expect(seen).toEqual(["probe-secret"]);
  });

  test("dedupes the network probe by endpoint+model, but still returns one outcome per target", async () => {
    const plan: ResolvedImprovePlan = {
      processes: {
        reflect: {
          enabled: true,
          config: {},
          runner: connectionRunner("shared", "https://shared.example.test/v1", "shared-model"),
        },
      },
      triageJudgment: connectionRunner("shared", "https://shared.example.test/v1", "shared-model"),
    } as unknown as ResolvedImprovePlan;
    const probeReachable = mock(async () => ({ reachable: true }));

    const outcomes = await assertRequiredEnginesReachable(plan, probeReachable);

    expect(probeReachable).toHaveBeenCalledTimes(1);
    expect(outcomes).toHaveLength(2);
    expect(outcomes.map((o) => o.process).sort()).toEqual(["reflect", "triage.judgment"]);
    expect(outcomes[0]?.latencyMs).toBe(outcomes[1]?.latencyMs);
  });

  test("a harness is checked by its binary, a connection by a short completion", async () => {
    const plan = {
      processes: {
        reflect: {
          enabled: true,
          config: {},
          runner: { kind: "harness", name: "cc", platform: "claude", bin: "claude", args: [], timeoutMs: null },
        },
        distill: {
          enabled: true,
          config: {},
          runner: connectionRunner("lab", "https://lab.example.test/v1", "lab-model"),
        },
      },
      triageJudgment: null,
    } as unknown as ResolvedImprovePlan;
    const probeReachable = mock(async () => ({ reachable: true }));
    const onPath = new Set(["claude"]);
    const which = (bin: string) => (onPath.has(bin) ? `/usr/bin/${bin}` : undefined);

    const outcomes = await assertRequiredEnginesReachable(plan, probeReachable, which);

    // Only the connection is probed over the network.
    expect(probeReachable).toHaveBeenCalledTimes(1);
    expect(outcomes).toEqual([
      expect.objectContaining({ process: "reflect", engine: "cc", endpoint: "claude", reachable: true }),
      expect.objectContaining({
        process: "distill",
        engine: "lab",
        endpoint: "https://lab.example.test/v1",
        reachable: true,
      }),
    ]);

    onPath.delete("claude");
    await expect(assertRequiredEnginesReachable(plan, probeReachable, which)).rejects.toThrow(
      /reflect \(engine "cc", claude\): claude is not on PATH/,
    );
  });

  test("still throws ConfigError when a target is unreachable (unchanged abort behavior)", async () => {
    const plan = planWithTargets({
      reflect: { endpoint: "https://dead.example.test/v1", model: "model-a", engine: "engineA" },
    });
    const probeReachable = mock(async () => ({ reachable: false, error: "boom" }));

    await expect(assertRequiredEnginesReachable(plan, probeReachable)).rejects.toThrow(
      /completion path is not reachable/,
    );
  });

  test("the default probe waits as long as the connection's own timeout, so a busy endpoint is reachable", async () => {
    // A local server busy with another job queues the probe behind it; a fixed
    // 3s bound skipped every scheduled improve run on 2026-09-27 against a
    // reachable endpoint.
    const server = Bun.serve({
      port: 0,
      async fetch() {
        await Bun.sleep(3_500);
        return Response.json({ choices: [{ message: { role: "assistant", content: "ok" } }] });
      },
    });
    try {
      const endpoint = `http://127.0.0.1:${server.port}/v1/chat/completions`;
      const plan = {
        processes: {
          reflect: {
            enabled: true,
            config: {},
            runner: connectionRunner("busy", endpoint, "busy-model", { timeoutMs: 10_000 }),
          },
        },
        triageJudgment: null,
      } as unknown as ResolvedImprovePlan;

      const outcomes = await assertRequiredEnginesReachable(plan);

      expect(outcomes).toHaveLength(1);
      expect(outcomes[0]?.reachable).toBe(true);
      expect(outcomes[0]?.latencyMs).toBeGreaterThanOrEqual(3_000);
    } finally {
      server.stop(true);
    }
  }, 20_000);

  test("the probe bound is the connection's own timeout, at most two minutes", () => {
    const connection = (timeoutMs?: number | null) =>
      ({
        endpoint: "https://x.example.test/v1",
        model: "m",
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      }) as never;
    expect(requiredEngineProbeTimeoutMs(connection(10_000))).toBe(10_000);
    expect(requiredEngineProbeTimeoutMs(connection(900_000))).toBe(120_000);
    expect(requiredEngineProbeTimeoutMs(connection(null))).toBe(120_000);
    expect(requiredEngineProbeTimeoutMs(connection())).toBe(120_000);
  });

  test("returns an empty array when there are no required-engine targets", async () => {
    const plan: ResolvedImprovePlan = { processes: {}, triageJudgment: null } as unknown as ResolvedImprovePlan;
    const probeReachable = mock(async () => ({ reachable: true }));

    const outcomes = await assertRequiredEnginesReachable(plan, probeReachable);

    expect(outcomes).toEqual([]);
    expect(probeReachable).not.toHaveBeenCalled();
  });
});
