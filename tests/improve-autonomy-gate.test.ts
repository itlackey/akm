// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { AUTONOMY_LANES, applyAutonomyGate, isAutonomyLaneAllowed } from "../src/commands/improve/autonomy-gate";
import { resolveImprovePlan } from "../src/commands/improve/improve-strategies";
import { improveLockPath, releaseImproveLock, tryAcquireImproveLock } from "../src/commands/improve/locks";
import { IMPROVE_AUTONOMY_CONFIG_KEY } from "../src/core/config/experimental";
import { TransientError } from "../src/core/errors";
import { akmIndex } from "../src/indexer/indexer";
import { runCliCapture } from "./_helpers/cli";
import { type Cleanup, type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "./_helpers/sandbox";

/**
 * D8 — the autonomy gate's decision layer.
 *
 * `akm improve` stays on; what is gated is the lanes that mutate assets without
 * review. The shipped `default` strategy enables several of those, so with the
 * opt-in absent the gate must downgrade the strategy rather than trust it.
 *
 * The property these pin is that a gated lane is never a SILENT no-op: every
 * downgrade is reported back to the caller so it can be turned into an event, a
 * doctor line, and a health advisory. A gate that quietly disabled work would
 * reproduce the exact failure that made a blanket experimental gate on
 * `akm improve` unacceptable.
 */

const AUTONOMOUS = { experimental: { improveAutonomy: true } };
const REVIEW_FIRST = {};

/** The shipped `default` strategy's autonomy-relevant shape. */
const DEFAULT_STRATEGY = {
  processes: {
    reflect: { enabled: true },
    distill: { enabled: true },
    consolidate: { enabled: true, allowedTypes: ["memory"] },
    memoryInference: { enabled: true },
    validation: { enabled: true },
    triage: { enabled: true, applyMode: "promote" as const, policy: "personal-stash" },
  },
  sync: { enabled: true, push: true },
};

/** The same strategy with the triage judgment tier on — the only gated triage promote (#1143). */
const JUDGED_STRATEGY = {
  ...DEFAULT_STRATEGY,
  processes: {
    ...DEFAULT_STRATEGY.processes,
    triage: { ...DEFAULT_STRATEGY.processes.triage, judgment: { enabled: true } },
  },
};

describe("applyAutonomyGate with autonomy OFF", () => {
  test("keeps review-only consolidate planning enabled and disables memoryInference", () => {
    const { config } = applyAutonomyGate(DEFAULT_STRATEGY, REVIEW_FIRST);

    expect(config.processes?.consolidate?.enabled).toBe(true);
    expect(config.processes?.memoryInference?.enabled).toBe(false);
  });

  test("downgrades a judged triage promote to queue instead of disabling triage", () => {
    // Triage still runs — queued proposals are still triaged, they just are not
    // auto-accepted into the stash. Disabling triage outright would remove
    // review work the user asked for.
    const { config, gated } = applyAutonomyGate(JUDGED_STRATEGY, REVIEW_FIRST);

    expect(config.processes?.triage?.enabled).toBe(true);
    expect(config.processes?.triage?.applyMode).toBe("queue");
    expect(gated.map((g) => g.lane)).toContain("triagePromote");
  });

  test("leaves a deterministic-only triage promote alone and does not report it (#1143)", () => {
    for (const judgment of [undefined, { enabled: false }] as const) {
      const strategy =
        judgment === undefined
          ? DEFAULT_STRATEGY
          : {
              ...DEFAULT_STRATEGY,
              processes: { ...DEFAULT_STRATEGY.processes, triage: { ...DEFAULT_STRATEGY.processes.triage, judgment } },
            };
      const { config, gated } = applyAutonomyGate(strategy, REVIEW_FIRST);

      expect(config.processes?.triage?.applyMode).toBe("promote");
      expect(gated.map((g) => g.lane)).not.toContain("triagePromote");
      // memoryInference is still gated and still reported.
      expect(config.processes?.memoryInference?.enabled).toBe(false);
      expect(gated.map((g) => g.lane)).toContain("memoryInference");
    }
  });

  test("leaves review-first lanes and sync.push untouched", () => {
    const { config } = applyAutonomyGate(DEFAULT_STRATEGY, REVIEW_FIRST);

    expect(config.processes?.reflect?.enabled).toBe(true);
    expect(config.processes?.distill?.enabled).toBe(true);
    expect(config.processes?.validation?.enabled).toBe(true);
    // sync.push is deliberately outside this gate.
    expect(config.sync?.push).toBe(true);
  });

  test("reports every downgraded lane, each naming the config key", () => {
    const { gated } = applyAutonomyGate(JUDGED_STRATEGY, REVIEW_FIRST);
    const lanes = gated.map((g) => g.lane);

    expect(lanes).not.toContain("consolidate");
    expect(lanes).toContain("memoryInference");
    expect(lanes).toContain("triagePromote");
    for (const entry of gated) {
      expect(entry.configKey).toBe(IMPROVE_AUTONOMY_CONFIG_KEY);
      expect(entry.reason.length).toBeGreaterThan(0);
    }
  });

  test("reports nothing for a strategy that was already review-first", () => {
    const quiet = { processes: { reflect: { enabled: true }, triage: { enabled: true, applyMode: "queue" as const } } };
    const { gated } = applyAutonomyGate(quiet, REVIEW_FIRST);

    expect(gated).toEqual([]);
  });

  test("blocks the plan-bypassing cleanup lane", () => {
    expect(isAutonomyLaneAllowed("memoryCleanup", REVIEW_FIRST)).toBe(false);
  });
});

describe("applyAutonomyGate with autonomy ON", () => {
  test("passes the strategy through unchanged", () => {
    const { config, gated } = applyAutonomyGate(DEFAULT_STRATEGY, AUTONOMOUS);

    expect(config.processes?.consolidate?.enabled).toBe(true);
    expect(config.processes?.memoryInference?.enabled).toBe(true);
    expect(config.processes?.triage?.applyMode).toBe("promote");
    expect(gated).toEqual([]);
  });

  test("allows the plan-bypassing cleanup lane", () => {
    expect(isAutonomyLaneAllowed("memoryCleanup", AUTONOMOUS)).toBe(true);
  });
});

describe("lane inventory", () => {
  test("covers exactly the three lanes D8 gates, and not advisory consolidation or sync.push", () => {
    expect([...(AUTONOMY_LANES as readonly string[])].sort()).toEqual([
      "memoryCleanup",
      "memoryInference",
      "triagePromote",
    ]);
    expect(AUTONOMY_LANES as readonly string[]).not.toContain("push");
  });
});

describe("improve-judge-gone", () => {
  let storage: IsolatedAkmStorage;

  beforeEach(() => {
    storage = withIsolatedAkmStorage();
    writeSandboxConfig({
      semanticSearchMode: "off",
      defaultBundle: "fixture",
      bundles: { fixture: { path: storage.stashDir, components: { main: { root: ".", adapter: "akm" } } } },
    });
  });

  afterEach(() => storage.cleanup());

  describe("akm improve judge (removed)", () => {
    test("exits 2 naming `akm doctor judge reflect.quality` and does no improve work", async () => {
      const result = await runCliCapture(["improve", "judge", "--format=json"]);
      expect(result.code).toBe(2);
      const error = JSON.parse(result.stderr.trim()) as { code?: string; hint?: string };
      expect(error.code).toBe("UNKNOWN_COMMAND");
      expect(error.hint).toContain("akm doctor judge reflect.quality");
      expect(result.stdout).toBe("");
    });

    test("a root asset named `judge` is still a scope", async () => {
      fs.writeFileSync(path.join(storage.stashDir, "judge.md"), "---\ndescription: a root note\n---\nbody\n");
      await akmIndex({ stashDir: storage.stashDir, full: true });
      const result = await runCliCapture(["improve", "judge", "--dry-run", "--format=json"]);
      expect(result.code).toBe(78);
      expect((JSON.parse(result.stderr.trim()) as { code?: string }).code).toBe("LLM_NOT_CONFIGURED");
    });
  });
});

describe("improve-lock-serialization", () => {
  let cleanup: Cleanup = () => {};
  let lockPath = "";

  beforeEach(() => {
    const storage = withIsolatedAkmStorage();
    lockPath = improveLockPath(path.join(storage.stashDir, ".akm"));
    cleanup = storage.cleanup;
  });

  afterEach(() => {
    cleanup();
    cleanup = () => {};
    lockPath = "";
  });

  describe("improve whole-run lock", () => {
    test("serializes contenders and preserves the current owner", () => {
      const first = tryAcquireImproveLock(lockPath, false);
      expect(first.state).toBe("acquired");
      if (first.state !== "acquired") throw new Error("expected first acquisition");

      const contender = tryAcquireImproveLock(lockPath, true);
      expect(contender.state).toBe("skipped");
      expect(fs.existsSync(lockPath)).toBe(true);

      releaseImproveLock(first.ownership);
      expect(fs.existsSync(lockPath)).toBe(false);
    });

    test("allows a successor only after the owner releases", () => {
      const first = tryAcquireImproveLock(lockPath, false);
      if (first.state !== "acquired") throw new Error("expected first acquisition");
      releaseImproveLock(first.ownership);

      const second = tryAcquireImproveLock(lockPath, false);
      expect(second.state).toBe("acquired");
      if (second.state !== "acquired") throw new Error("expected second acquisition");
      releaseImproveLock(second.ownership);
    });

    // Field follow-up to #948 (dev-team field review 2026-09-10): a losing
    // contender with no `--skip-if-locked` used to throw
    // `ConfigError("INVALID_CONFIG_FILE")` (exit 78) — a config-error code for
    // ordinary, retryable contention between two legitimate `improve` runs.
    // Reclassified to `TransientError`/`IMPROVE_LOCK_HELD` (exit 75), mirroring
    // `INDEX_DB_CONTENDED` (#956).
    test("a losing contender without --skip-if-locked throws TransientError(IMPROVE_LOCK_HELD), never a ConfigError", () => {
      const first = tryAcquireImproveLock(lockPath, false);
      if (first.state !== "acquired") throw new Error("expected first acquisition");

      try {
        expect(() => tryAcquireImproveLock(lockPath, false)).toThrow(TransientError);
        try {
          tryAcquireImproveLock(lockPath, false);
          throw new Error("expected tryAcquireImproveLock to throw");
        } catch (err) {
          expect(err).toBeInstanceOf(TransientError);
          expect((err as TransientError).code).toBe("IMPROVE_LOCK_HELD");
          expect((err as TransientError).message).toContain("akm improve is already running");
          expect((err as TransientError).hint()).toContain("--skip-if-locked");
        }
      } finally {
        releaseImproveLock(first.ownership);
      }
    });
  });
});

/**
 * D8 — `resolveImprovePlan` applies the autonomy gate.
 *
 * `tests/improve-autonomy-gate.test.ts` pins the gate's decisions in isolation.
 * This pins that the plan resolver actually USES it — the wiring, which a gate
 * with perfect unit tests can still be missing.
 *
 * The `consolidate` strategy is the discriminating fixture: consolidate is its
 * only LLM-backed process, so with autonomy OFF the gate disables it and the
 * plan resolves with no connection or harness configured at all. With autonomy ON the same
 * call demands one and throws `LLM_NOT_CONFIGURED`. That asymmetry is
 * only possible if the gate runs BEFORE the LLM preflight, which is the
 * ordering the choke point depends on.
 */

const BASE = {} as unknown as Parameters<typeof resolveImprovePlan>[1];

function configWith(
  experimental?: { improveAutonomy?: boolean },
  withEngine = false,
): Parameters<typeof resolveImprovePlan>[1] {
  return {
    ...BASE,
    ...(experimental ? { experimental } : {}),
    ...(withEngine
      ? {
          connections: { test: { endpoint: "http://localhost:1/v1/chat/completions", models: { fast: "test" } } },
        }
      : {}),
  } as Parameters<typeof resolveImprovePlan>[1];
}

describe("resolveImprovePlan applies the autonomy gate", () => {
  test("autonomy OFF keeps review-only consolidate planning enabled", () => {
    const plan = resolveImprovePlan("consolidate", configWith(undefined, true));

    expect(plan.processes.consolidate.enabled).toBe(true);
    expect(plan.autonomyGated).toEqual([]);
  });

  test("autonomy OFF still requires the planner's engine", () => {
    expect(() => resolveImprovePlan("consolidate", configWith())).toThrow(/requires a connection or harness/);
  });

  test("autonomy ON does not change the review-only planner's engine requirement", () => {
    expect(() => resolveImprovePlan("consolidate", configWith({ improveAutonomy: true }))).toThrow(
      /requires a connection or harness/,
    );
  });

  // The "already review-first strategy reports no downgrades" case lives in
  // tests/improve-autonomy-gate.test.ts: asserting it here would need an
  // `connections` fixture purely to get past the preflight for reflect, which adds
  // setup without adding signal the three cases above do not already give.
});

describe("the shipped default strategy drains deterministically without autonomy (#1143)", () => {
  test("default runs triage in promote mode with no judgment and no triagePromote downgrade", () => {
    const plan = resolveImprovePlan("default", configWith(undefined, true));

    expect(plan.processes.triage.enabled).toBe(true);
    expect(plan.strategy.config.processes?.triage?.applyMode).toBe("promote");
    expect(plan.strategy.config.processes?.triage?.maxAcceptsPerRun).toBe(200);
    expect(plan.triageJudgment ?? null).toBeNull();
    expect(plan.autonomyGated.map((g) => g.lane)).toEqual(["memoryInference"]);
  });

  test("a default strategy with judgment on and no autonomy is downgraded to queue and reported", () => {
    const config = {
      ...configWith(undefined, true),
      improve: {
        strategies: { default: { processes: { triage: { judgment: { enabled: true, connection: "test" } } } } },
      },
    } as Parameters<typeof resolveImprovePlan>[1];
    const plan = resolveImprovePlan("default", config);

    expect(plan.strategy.config.processes?.triage?.applyMode).toBe("queue");
    expect(plan.autonomyGated.map((g) => g.lane).sort()).toEqual(["memoryInference", "triagePromote"]);
  });
});
