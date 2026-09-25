// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * itlackey/akm — a poisoned transaction journal must not turn `akm migrate
 * apply` into a blocked/failed run. Drives the real `runMigration`
 * orchestrator so the coverage is what `akm migrate status`/`apply` actually
 * report against a stash with a quarantine-worthy journal.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { runMigration } from "../../scripts/akm-migrate/run-migrate";
import { resetConfigCache } from "../../src/core/config/config";
import { advanceTxn, beginTxn, registerTxnKind } from "../../src/core/fs-txn";
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

test("a poisoned journal is quarantined and reported; the plan stays current, not blocked", async () => {
  writeSandboxConfig({ defaultBundle: "primary", bundles: { primary: { path: storage.stashDir } } });
  registerTxnKind<{ label: string }>("test-run-migrate-poisoned", {
    phases: ["prepared", "files-published", "committed"],
    commitPhase: "files-published",
    rollback() {
      throw new Error("poisoned journal");
    },
    finalize() {},
  });
  beginTxn({ kind: "test-run-migrate-poisoned", root: storage.stashDir, changes: [], payload: { label: "bad" } });

  const plan = await runMigration({ apply: true });

  expect(plan.status).toBe("current");
  expect(plan.blockers).toEqual([]);
  expect(plan.staleTxns && "recovered" in plan.staleTxns).toBe(true);
  const staleTxns = plan.staleTxns as { recovered: unknown[]; quarantined: { kind: string; reason: string }[] };
  expect(staleTxns.recovered).toEqual([]);
  expect(staleTxns.quarantined).toHaveLength(1);
  expect(staleTxns.quarantined[0]?.kind).toBe("test-run-migrate-poisoned");
  expect(staleTxns.quarantined[0]?.reason).toMatch(/poisoned journal/);
});

test("a poisoned journal does not block a sibling journal in the same status/apply pass", async () => {
  writeSandboxConfig({ defaultBundle: "primary", bundles: { primary: { path: storage.stashDir } } });
  registerTxnKind<{ label: string }>("test-run-migrate-poisoned-sibling", {
    phases: ["prepared", "files-published", "committed"],
    commitPhase: "files-published",
    rollback() {
      throw new Error("poisoned journal");
    },
    finalize() {},
  });
  registerTxnKind<{ label: string }>("test-run-migrate-healthy-sibling", {
    phases: ["prepared", "files-published", "committed"],
    commitPhase: "files-published",
    rollback() {},
    finalize() {},
  });
  beginTxn({
    kind: "test-run-migrate-poisoned-sibling",
    root: storage.stashDir,
    changes: [],
    payload: { label: "bad" },
  });
  const healthy = beginTxn({
    kind: "test-run-migrate-healthy-sibling",
    root: storage.stashDir,
    changes: [],
    payload: { label: "ok" },
  });
  advanceTxn(healthy, "files-published");

  const plan = await runMigration({ apply: true });

  const staleTxns = plan.staleTxns as {
    recovered: { kind: string }[];
    quarantined: { kind: string }[];
  };
  expect(staleTxns.recovered.map((j) => j.kind)).toEqual(["test-run-migrate-healthy-sibling"]);
  expect(staleTxns.quarantined.map((j) => j.kind)).toEqual(["test-run-migrate-poisoned-sibling"]);
  expect(plan.status).toBe("current");
});
