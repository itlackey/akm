// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// PROOF for candidate: "A single unresolvable persisted 0.8 `workflow:` task
// target hard-blocks the ENTIRE migration."
//
// This test establishes the FACTS the candidate depends on, then evaluates
// whether the behavior is a reportable DEFECT or intentional, recoverable,
// fail-closed guarding.

import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { AkmConfig } from "../../src/core/config/config";
import { planTaskTargetRefMigration } from "../../src/migrate/legacy/task-target-ref-migration";
import { makeSandboxDir } from "../_helpers/sandbox";

function configFor(root: string): AkmConfig {
  return {
    configVersion: "0.9.0",
    semanticSearchMode: "off",
    bundles: { stash: { path: root, writable: true } },
    defaultBundle: "stash",
  } as AkmConfig;
}

test("one stale `workflow:` task target blocks planning for the whole bundle (all-or-nothing)", () => {
  const sandbox = makeSandboxDir("akm-proof-task-block");
  try {
    const root = sandbox.dir;
    fs.mkdirSync(path.join(root, "workflows"), { recursive: true });
    fs.mkdirSync(path.join(root, "tasks"), { recursive: true });

    // A perfectly good, migratable legacy task alongside a stale one.
    fs.writeFileSync(path.join(root, "workflows", "ship.md"), "# ship\n");
    const goodTask = 'schedule: "@daily"\nworkflow: workflow:ship\nenabled: true\n';
    const staleTask = 'schedule: "@daily"\nworkflow: workflow:ghost\nenabled: true\n';
    // "a-good" sorts before "z-stale"; the good one is even reached first.
    fs.writeFileSync(path.join(root, "tasks", "a-good.yml"), goodTask);
    fs.writeFileSync(path.join(root, "tasks", "z-stale.yml"), staleTask);

    // Planning throws on the stale one -> the ENTIRE plan (incl. the good task)
    // is aborted. `migrate apply` surfaces this exact message as a plan blocker
    // (config-migrate.ts buildMigrationPlan L2004-2005 -> requireEligiblePlan).
    let thrown: unknown;
    try {
      planTaskTargetRefMigration(configFor(root));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toMatch(/workflow:ghost.*not found/i);
    expect((thrown as Error).message).toMatch(/z-stale\.yml/);
    expect((thrown as Error).message).toMatch(/Repair or remove this task/i);

    // FAIL-CLOSED: planning is read-only, so the good task bytes are untouched
    // (nothing was mutated before the throw).
    expect(fs.readFileSync(path.join(root, "tasks", "a-good.yml"), "utf8")).toBe(goodTask);
    expect(fs.readFileSync(path.join(root, "tasks", "z-stale.yml"), "utf8")).toBe(staleTask);

    // RECOVERABLE: the user fixes the stale ref exactly as the message instructs
    // (here: restore the missing workflow file), reruns, and planning now
    // succeeds and rewrites BOTH tasks. No data loss, no unrecoverable wedge.
    fs.writeFileSync(path.join(root, "workflows", "ghost.md"), "# ghost\n");
    const plan = planTaskTargetRefMigration(configFor(root));
    expect(plan.rewrites.map((r) => r.to).sort()).toEqual(["workflows/ghost", "workflows/ship"]);
  } finally {
    sandbox.cleanup();
  }
});
