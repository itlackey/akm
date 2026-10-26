// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The residue step sweeps `$STASH/.akm` only where no disabled bundle owns the
 * stash: a disabled bundle is inert, and `migrate apply` names no bundle.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { runMigration } from "../../scripts/akm-migrate/run-migrate";
import { resetConfigCache } from "../../src/core/config/config";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "../_helpers/sandbox";

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  resetConfigCache();
});

afterEach(() => {
  resetConfigCache();
  storage.cleanup();
});

function seedResidue(): string {
  const residue = path.join(storage.stashDir, ".akm", "graph.json");
  fs.mkdirSync(path.dirname(residue), { recursive: true });
  fs.writeFileSync(residue, "{}");
  return residue;
}

const bundleAtStash = (extra: Record<string, unknown>) => ({
  bundles: { owner: { path: storage.stashDir, ...extra, components: { main: { root: ".", adapter: "akm" } } } },
});

describe("the residue step and the bundle that owns the stash", () => {
  test("a disabled bundle at the stash keeps its .akm residue, in the preview and in apply", async () => {
    const residue = seedResidue();
    writeSandboxConfig(bundleAtStash({ enabled: false }));

    const preview = await runMigration({ apply: false });
    const plan = await runMigration({ apply: true });

    expect(preview.failedSteps).toBeUndefined();
    expect(preview.deadResidue).toEqual({ pending: [] });
    expect(plan.failedSteps).toBeUndefined();
    expect(plan.deadResidue).toEqual({ removed: [] });
    expect(fs.existsSync(residue)).toBe(true);
  });

  test("an enabled bundle at the stash has its .akm residue removed", async () => {
    const residue = seedResidue();
    writeSandboxConfig(bundleAtStash({}));

    const preview = await runMigration({ apply: false });
    const plan = await runMigration({ apply: true });

    expect(preview.deadResidue).toMatchObject({ pending: [{ relativePath: path.join(".akm", "graph.json") }] });
    expect(plan.failedSteps).toBeUndefined();
    expect(plan.deadResidue).toMatchObject({
      removed: [{ relativePath: path.join(".akm", "graph.json"), removed: true }],
    });
    expect(fs.existsSync(residue)).toBe(false);
  });

  test("a stash no bundle is configured at has its .akm residue removed", async () => {
    const residue = seedResidue();

    const plan = await runMigration({ apply: true });

    expect(plan.failedSteps).toBeUndefined();
    expect(plan.deadResidue).toMatchObject({
      removed: [{ relativePath: path.join(".akm", "graph.json"), removed: true }],
    });
    expect(fs.existsSync(residue)).toBe(false);
  });
});
