// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * One poisoned migration step must never end the whole `runMigration` run.
 * Before this fix, `runMigration` ran its steps in a flat sequence with no
 * per-step catch, so any one step's throw propagated out of `runMigration`
 * itself — no plan at all, and (through `runWithJsonErrors`) `akm-migrate
 * status|apply` exiting INTERNAL(70) instead of reporting a blocked plan.
 *
 * Two levels:
 *   - `migrationStep` directly, against synthetic steps (sync and async
 *     actions alike): precise, fast, and independent of which real
 *     migrate/*.ts step happens to be easiest to break today.
 *   - `runMigration` end to end, with a REAL poisoned step: a symlinked
 *     bundle root the asset walker refuses, and a config `loadConfig()` rejects.
 *     Both must land in `failedSteps` while every other section is still
 *     reported.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { migrationStep, runMigration } from "../../scripts/akm-migrate/run-migrate";
import { resetConfigCache } from "../../src/core/config/config";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "../_helpers/sandbox";

// ── migrationStep directly ──────────────────────────────────────────────────

test("migrationStep: one poisoned step among N leaves the other N-1 with their normal outcome", async () => {
  const failedSteps: { step: string; error: string }[] = [];
  const results = await Promise.all(
    ["a", "b", "c", "d", "e"].map((label, index) =>
      migrationStep(failedSteps, `step-${label}`, () => {
        if (index === 2) throw new Error(`${label} is poisoned`);
        return `${label}-ok`;
      }),
    ),
  );

  expect(results).toEqual(["a-ok", "b-ok", undefined, "d-ok", "e-ok"]);
  expect(failedSteps).toHaveLength(1);
  expect(failedSteps[0]).toEqual({ step: "step-c", error: "c is poisoned" });
});

test("migrationStep: a poisoned apply falls back to its own read-only probe instead of losing the section", async () => {
  const failedSteps: { step: string; error: string }[] = [];
  const result = await migrationStep(
    failedSteps,
    "writeStep",
    () => {
      throw new Error("write failed");
    },
    () => "probed-value",
  );

  expect(result).toBe("probed-value");
  expect(failedSteps).toHaveLength(1);
  expect(failedSteps[0]?.step).toBe("writeStep");
  expect(failedSteps[0]?.error).toBe("write failed");
});

test("migrationStep: a poisoned apply AND a poisoned probe still return (undefined), never throw", async () => {
  const failedSteps: { step: string; error: string }[] = [];
  const result = await migrationStep(
    failedSteps,
    "writeStep",
    () => {
      throw new Error("write failed");
    },
    () => {
      throw new Error("probe failed too");
    },
  );

  expect(result).toBeUndefined();
  expect(failedSteps).toHaveLength(2);
  expect(failedSteps[0]).toEqual({ step: "writeStep", error: "write failed" });
  expect(failedSteps[1]).toEqual({ step: "writeStep (read-only fallback)", error: "probe failed too" });
});

test("migrationStep: same isolation guarantee for an async action", async () => {
  const failedSteps: { step: string; error: string }[] = [];
  const results = await Promise.all(
    ["a", "b", "c"].map((label, index) =>
      migrationStep(failedSteps, `async-${label}`, async () => {
        if (index === 1) throw new Error(`${label} is poisoned`);
        return `${label}-ok`;
      }),
    ),
  );

  expect(results).toEqual(["a-ok", undefined, "c-ok"]);
  expect(failedSteps).toHaveLength(1);
  expect(failedSteps[0]).toEqual({ step: "async-b", error: "b is poisoned" });
});

// ── runMigration end to end ─────────────────────────────────────────────────

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  resetConfigCache();
});

afterEach(() => {
  resetConfigCache();
  storage.cleanup();
});

for (const apply of [false, true]) {
  test(`${apply ? "apply" : "status"}: an asset step that throws is recorded, and every other section is still reported`, async () => {
    // A bundle root that is a symlink: the asset walker refuses it, under apply and under the read-only fallback alike.
    const real = path.join(storage.root, "task-bundle");
    const alias = path.join(storage.root, "task-bundle-alias");
    fs.mkdirSync(real);
    fs.symlinkSync(real, alias, "dir");
    writeSandboxConfig({
      defaultBundle: "primary",
      bundles: {
        primary: { path: storage.stashDir, writable: true, components: { main: { root: ".", adapter: "akm" } } },
        tasks: { path: alias, components: { main: { root: ".", adapter: "akm-task" } } },
      },
    });

    const plan = await runMigration({ apply });

    expect(plan.status).toBe("blocked");
    const steps = (plan.failedSteps ?? []).map((entry) => entry.step);
    expect(steps).toContain("assetEngineKeys");
    expect(plan.blockers.some((line) => line.includes('"assetEngineKeys"') && line.includes("real directory"))).toBe(
      true,
    );
    expect(plan.assetEngineKeys).toBeUndefined();
    // Every other step in the same run still completed normally.
    expect(plan.configFile).toBeDefined();
    expect(plan.stateMigrations).toBeDefined();
  });

  test(`${apply ? "apply" : "status"}: a config loadConfig() rejects blocks the plan instead of throwing out of runMigration`, async () => {
    // bundles.primary.path is a number, not a string: schema-invalid, so a step's own `loadConfig()` throws.
    writeSandboxConfig({
      defaultBundle: "primary",
      bundles: { primary: { path: 42, writable: true } },
    });

    const plan = await runMigration({ apply });

    expect(plan.status).toBe("blocked");
    expect(plan.failedSteps?.length).toBeGreaterThan(0);
    // A config-independent section (state.db migrations read XDG_STATE_HOME,
    // never `loadConfig()`) still ran and is present.
    expect(plan.stateMigrations).toBeDefined();
  });
}
