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
 * Three levels:
 *   - `migrationStep` directly, against synthetic steps (sync and async
 *     actions alike): precise, fast, and independent of which real
 *     migrate/*.ts step happens to be easiest to break today.
 *   - `runMigration` end to end, with a REAL poisoned item: a second
 *     filesystem bundle whose writer-relocation target directory is
 *     occupied by a file instead of being creatable, so
 *     `applyWriterRelocation` throws for that one bundle while every other
 *     bundle (and every other step) still runs normally.
 *   - `runMigration` end to end with an invalid config (`bundles.primary.path`
 *     not a string): `loadConfig()` inside `writerRelocationTargets` throws,
 *     which must land in `failedSteps` too rather than escape `runMigration`.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { migrationStep, runMigration } from "../../scripts/akm-migrate/run-migrate";
import { resetConfigCache } from "../../src/core/config/config";
import { getDistillRejectedDir } from "../../src/core/paths";
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

// ── runMigration end to end, with a real poisoned bundle ───────────────────

let storage: IsolatedAkmStorage;
let secondaryDir = "";

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  resetConfigCache();
  secondaryDir = fs.mkdtempSync(path.join(storage.root, "secondary-"));
  for (const sub of ["tasks", "workflows", ".akm"]) {
    fs.mkdirSync(path.join(secondaryDir, sub), { recursive: true });
  }
  writeSandboxConfig({
    defaultBundle: "primary",
    bundles: {
      primary: { path: storage.stashDir, writable: true },
      secondary: { path: secondaryDir, writable: true },
    },
  });
});

afterEach(() => {
  resetConfigCache();
  storage.cleanup();
});

test("apply: one bundle's writer relocation throwing does not cost every OTHER bundle its relocation", async () => {
  // Healthy bundle ("primary"): a real pending file to relocate, and its
  // target directory does not exist yet — applyWriterRelocation creates it
  // and moves the file, same as any ordinary run.
  const primaryOld = path.join(storage.stashDir, ".akm", "distill-rejected");
  fs.mkdirSync(primaryOld, { recursive: true });
  fs.writeFileSync(path.join(primaryOld, "lesson.md"), "rejected lesson");

  // Poisoned bundle ("secondary"): also has a pending file, but its target
  // directory is occupied by a FILE (not a directory it could create), so
  // `fs.mkdirSync(newPath, { recursive: true })` inside `applyWriterRelocation`
  // throws — a real, uid-independent filesystem conflict, not a mock.
  const secondaryOld = path.join(secondaryDir, ".akm", "distill-rejected");
  fs.mkdirSync(secondaryOld, { recursive: true });
  fs.writeFileSync(path.join(secondaryOld, "lesson.md"), "rejected lesson");
  const secondaryNewTarget = getDistillRejectedDir(secondaryDir);
  fs.mkdirSync(path.dirname(secondaryNewTarget), { recursive: true });
  fs.writeFileSync(secondaryNewTarget, "blocks mkdirSync(recursive) for this one bundle only");

  const plan = await runMigration({ apply: true });

  // No throw reached the caller: runMigration returned a full plan.
  expect(plan.status).toBe("blocked");
  expect(plan.failedSteps?.some((entry) => entry.step === "writerRelocation:secondary")).toBe(true);
  expect(plan.blockers.some((line) => line.includes("writerRelocation:secondary"))).toBe(true);

  // The healthy bundle's relocation still ran and succeeded normally.
  const relocation = plan.writerRelocation;
  expect(relocation && "relocated" in relocation).toBe(true);
  const relocated = (relocation as { relocated: Record<string, unknown> }).relocated;
  expect(relocated.primary).toBeDefined();
  expect((relocated.primary as { directories: { moved: number }[] }).directories[0]?.moved).toBe(1);
  // The poisoned bundle is simply absent — failedSteps is its only report.
  expect(relocated.secondary).toBeUndefined();

  // Every OTHER step in the same run still completed normally.
  expect(plan.configRetiredKeys && "applied" in plan.configRetiredKeys).toBe(true);
  expect(plan.stateMigrations).toBeDefined();
  expect(plan.taskV3Migration).toBeDefined();
  expect(plan.taskV4Migration).toBeDefined();

  // And the healthy bundle's file was actually moved on disk.
  expect(fs.existsSync(path.join(primaryOld, "lesson.md"))).toBe(false);
  expect(fs.existsSync(path.join(getDistillRejectedDir(storage.stashDir), "lesson.md"))).toBe(true);
});

// ── runMigration end to end, with a config `loadConfig()` rejects ──────────

for (const apply of [false, true]) {
  test(`${apply ? "apply" : "status"}: a config loadConfig() rejects blocks the plan instead of throwing out of runMigration`, async () => {
    // bundles.primary.path is a number, not a string — schema-invalid.
    // `stashDirIfConfigured()` tolerates this (readStashDirFromConfig reads
    // the raw JSON and treats a non-string path as absent, so it falls
    // through to STASH_DIR_NOT_FOUND), but `writerRelocationTargets()` calls
    // the full `loadConfig()`, which throws for it.
    writeSandboxConfig({
      defaultBundle: "primary",
      bundles: { primary: { path: 42, writable: true } },
    });

    const plan = await runMigration({ apply });

    // No throw reached the caller: runMigration returned a full plan.
    expect(plan.status).toBe("blocked");
    expect(
      plan.failedSteps?.some((entry) => entry.step === "stashDir" || entry.step === "writerRelocationTargets"),
    ).toBe(true);

    // A config-independent section (state.db migrations read XDG_STATE_HOME,
    // never `loadConfig()`) still ran and is present.
    expect(plan.stateMigrations).toBeDefined();
  });
}
