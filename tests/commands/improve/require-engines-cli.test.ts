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
import { _setAkmImproveForTests, assertRequiredEnginesReachable } from "../../../src/commands/improve/improve-cli";
import type { ResolvedImprovePlan } from "../../../src/commands/improve/improve-strategies";
import { runCliCapture } from "../../_helpers/cli";
import { makeSandboxDir, makeStashDir, type SandboxedDir, withEnv, writeSandboxConfig } from "../../_helpers/sandbox";

const disposers: SandboxedDir[] = [];

function freshEnv(stashDir: string): Record<string, string> {
  return {
    AKM_BUNDLE_DIR: stashDir,
    HOME: makeSandboxDir("akm-require-engines-home").dir,
    XDG_CONFIG_HOME: makeSandboxDir("akm-require-engines-cfg").dir,
    XDG_CACHE_HOME: makeSandboxDir("akm-require-engines-cache").dir,
    XDG_DATA_HOME: makeSandboxDir("akm-require-engines-data").dir,
    XDG_STATE_HOME: makeSandboxDir("akm-require-engines-state").dir,
  };
}

// A config where the default strategy's "reflect" process is pinned to an
// engine whose credential is not (and, deliberately, will never be) in the
// process environment, while `defaults.llmEngine` ("ready") remains fully
// available — so `resolveImprovePlan` disables just "reflect" instead of
// hitting the separate ALL-disabled ConfigError.
function writePartiallyUnavailableConfig(): void {
  writeSandboxConfig({
    configVersion: "0.9.0",
    semanticSearchMode: "off",
    engines: {
      ready: { kind: "llm", endpoint: "https://example.test/v1/chat/completions", model: "ready-model" },
      private: {
        kind: "llm",
        endpoint: "https://example.test/v1/chat/completions",
        model: "private-model",
        apiKey: "$MISSING_957_CLI_TOKEN",
      },
    },
    defaults: { llmEngine: "ready" },
    improve: {
      strategies: {
        default: { processes: { reflect: { engine: "private" } } },
      },
    },
  });
}

afterEach(() => {
  _setAkmImproveForTests();
  for (const d of disposers.splice(0)) d.cleanup();
});

describe("akm improve --require-engines", () => {
  test("aborts with exit 78 before akmImprove runs, naming the unresolved reference per process", async () => {
    const stash = makeStashDir();
    disposers.push(stash);
    const fakeAkmImprove = mock(async () => {
      throw new Error("akmImprove must not run when --require-engines aborts first");
    });
    _setAkmImproveForTests(fakeAkmImprove as unknown as typeof akmImprove);

    const result = await withEnv(freshEnv(stash.dir), async () => {
      writePartiallyUnavailableConfig();
      return runCliCapture(["improve", "--dry-run", "--require-engines"]);
    });

    expect(result.code).toBe(78);
    expect(result.stderr).toContain("--require-engines");
    expect(result.stderr).toContain("reflect");
    expect(result.stderr).toContain("private");
    expect(result.stderr).toContain("$MISSING_957_CLI_TOKEN");
    expect(result.stderr).toContain("is not set in this environment");
    expect(fakeAkmImprove).not.toHaveBeenCalled();
  });

  test("without the flag, the run proceeds and the result carries skippedProcesses", async () => {
    const stash = makeStashDir();
    disposers.push(stash);

    const result = await withEnv(freshEnv(stash.dir), async () => {
      writePartiallyUnavailableConfig();
      return runCliCapture(["improve", "--dry-run"]);
    });

    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      ok: boolean;
      skippedProcesses?: Array<{ process: string; configKey: string; reason: string }>;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.skippedProcesses).toEqual([
      expect.objectContaining({
        process: "reflect",
        configKey: "improve.strategies.default.processes.reflect.engine",
        reason: expect.stringContaining('engine "private"'),
      }),
    ]);
  });
});

/** Minimal `ResolvedImprovePlan` fixture: only the fields `collectRequiredEngineTargets` reads. */
function planWithTargets(
  processes: Record<string, { endpoint: string; model: string; engine: string }>,
): ResolvedImprovePlan {
  return {
    processes: Object.fromEntries(
      Object.entries(processes).map(([process, { endpoint, model, engine }]) => [
        process,
        { enabled: true, config: {}, runner: { kind: "llm", engine, connection: { endpoint, model } } },
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

  test("dedupes the network probe by endpoint+model, but still returns one outcome per target", async () => {
    const plan: ResolvedImprovePlan = {
      processes: {
        reflect: {
          enabled: true,
          config: {},
          runner: {
            kind: "llm",
            engine: "shared",
            connection: { endpoint: "https://shared.example.test/v1", model: "shared-model" },
          },
        },
      },
      triageJudgment: {
        kind: "llm",
        engine: "shared",
        connection: { endpoint: "https://shared.example.test/v1", model: "shared-model" },
      },
    } as unknown as ResolvedImprovePlan;
    const probeReachable = mock(async () => ({ reachable: true }));

    const outcomes = await assertRequiredEnginesReachable(plan, probeReachable);

    expect(probeReachable).toHaveBeenCalledTimes(1);
    expect(outcomes).toHaveLength(2);
    expect(outcomes.map((o) => o.process).sort()).toEqual(["reflect", "triage.judgment"]);
    expect(outcomes[0]?.latencyMs).toBe(outcomes[1]?.latencyMs);
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

  test("returns an empty array when there are no required-engine targets", async () => {
    const plan: ResolvedImprovePlan = { processes: {}, triageJudgment: null } as unknown as ResolvedImprovePlan;
    const probeReachable = mock(async () => ({ reachable: true }));

    const outcomes = await assertRequiredEnginesReachable(plan, probeReachable);

    expect(outcomes).toEqual([]);
    expect(probeReachable).not.toHaveBeenCalled();
  });
});
