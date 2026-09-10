// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `engine-last-used` advisory wiring (#950): an engine bound to an enabled
 * improve process that has not actually been invoked recently looks
 * identical to a healthy one on every other check — this pins the real DB
 * round-trip (seeded `llm_usage` events + an `improve_runs` row) end to end
 * through `akmHealth()`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { akmHealth } from "../../../src/commands/health";
import { ENGINE_LAST_USED_LOOKBACK_DAYS } from "../../../src/commands/health/engine-usage";
import type { HealthCheckResult } from "../../../src/commands/health/types";
import { appendEvent } from "../../../src/core/events";
import { openStateDatabase } from "../../../src/core/state-db";
import { recordImproveRun } from "../../../src/storage/repositories/improve-runs-repository";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "../../_helpers/sandbox";

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
});

afterEach(() => {
  storage.cleanup();
});

function findAdvisory(checks: HealthCheckResult[], name: string): HealthCheckResult {
  const found = checks.find((c) => c.name === name);
  if (!found) throw new Error(`expected an advisory named ${name}`);
  return found;
}

function configureStrategy(): void {
  writeSandboxConfig({
    engines: {
      ready: { kind: "llm", endpoint: "https://example.test/v1/chat/completions", model: "m" },
    },
    defaults: { llmEngine: "ready", improveStrategy: "lastused" },
    improve: {
      strategies: {
        lastused: { processes: { reflect: { enabled: true, engine: "ready" } } },
      },
    },
  });
}

/** Seed a minimal improve_runs row started `daysAgo` days ago. */
function seedImproveRun(daysAgo: number): void {
  const startedAt = new Date(Date.now() - daysAgo * 24 * 60 * 60_000).toISOString();
  const db = openStateDatabase();
  try {
    recordImproveRun(db, {
      id: `run-${daysAgo}`,
      startedAt,
      completedAt: startedAt,
      stashDir: storage.stashDir,
      dryRun: false,
      strategy: "lastused",
      scopeMode: "all",
      scopeValue: null,
      guidance: null,
      ok: true,
      result: {
        schemaVersion: 2,
        ok: true,
        strategy: "lastused",
        scope: { mode: "all" },
        dryRun: false,
        memorySummary: { eligible: 0, derived: 0 },
        plannedRefs: [],
      },
    });
  } finally {
    db.close();
  }
}

/** Seed an `llm_usage` event for `engine`, `daysAgo` days in the past. */
function seedLlmUsage(engine: string, daysAgo: number): void {
  const ts = Date.now() - daysAgo * 24 * 60 * 60_000;
  appendEvent({ eventType: "llm_usage", metadata: { engine, process: "reflect", durationMs: 500 } }, { now: () => ts });
}

describe("engine-last-used advisory wiring (#950)", () => {
  test("unknown when no improve run has completed in the lookback window (fresh install, not noisy)", async () => {
    configureStrategy();
    const result = await akmHealth({ since: "7d" });
    const advisory = findAdvisory(result.advisories, "engine-last-used");
    expect(advisory.status).toBe("unknown");
    expect(advisory.message).toContain(`${ENGINE_LAST_USED_LOOKBACK_DAYS} days`);
  });

  test("warn for a bound engine with an improve run in the window but no llm_usage events", async () => {
    configureStrategy();
    seedImproveRun(1);
    const result = await akmHealth({ since: "7d" });
    const advisory = findAdvisory(result.advisories, "engine-last-used");
    expect(advisory.status).toBe("warn");
    expect(advisory.message).toContain('Engine "ready"');
    expect(advisory.message).toContain("reflect");
    const engines = advisory.evidence?.engines as Array<{ engine: string; processes: string[] }>;
    expect(engines.find((e) => e.engine === "ready")?.processes).toContain("reflect");
  });

  test("pass, naming the process and time, when the engine has a recent llm_usage event", async () => {
    configureStrategy();
    seedImproveRun(1);
    seedLlmUsage("ready", 1);
    const result = await akmHealth({ since: "7d" });
    const advisory = findAdvisory(result.advisories, "engine-last-used");
    expect(advisory.status).toBe("pass");
    expect(advisory.message).toContain('Engine "ready"');
    expect(advisory.message).toContain('last used by "reflect"');
  });

  test("warn: a usage event older than the lookback window does not count as recent use", async () => {
    configureStrategy();
    seedImproveRun(1);
    seedLlmUsage("ready", ENGINE_LAST_USED_LOOKBACK_DAYS + 5);
    const result = await akmHealth({ since: "7d" });
    const advisory = findAdvisory(result.advisories, "engine-last-used");
    expect(advisory.status).toBe("warn");
  });
});
