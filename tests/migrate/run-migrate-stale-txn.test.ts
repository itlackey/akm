// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * itlackey/akm — an untrusted or stuck transaction journal must not turn
 * `akm migrate apply` into a blocked/failed run. Drives the real
 * `runMigration` orchestrator so the coverage is what `akm migrate
 * status`/`apply` actually report against a stash with a deferred (recovery
 * action failed) journal.
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

test("a journal whose recovery action fails is deferred and reported; the plan stays current, not blocked", async () => {
  writeSandboxConfig({ defaultBundle: "primary", bundles: { primary: { path: storage.stashDir } } });
  registerTxnKind<{ label: string }>("test-run-migrate-stuck", {
    phases: ["prepared", "files-published", "committed"],
    commitPhase: "files-published",
    rollback() {
      throw new Error("recovery action failed, journal is still trusted");
    },
    finalize() {},
  });
  beginTxn({ kind: "test-run-migrate-stuck", root: storage.stashDir, changes: [], payload: { label: "bad" } });

  const plan = await runMigration({ apply: true });

  expect(plan.status).toBe("current");
  expect(plan.blockers).toEqual([]);
  expect(plan.staleTxns && "recovered" in plan.staleTxns).toBe(true);
  const staleTxns = plan.staleTxns as {
    recovered: unknown[];
    quarantined: unknown[];
    deferred: { kind: string; reason: string }[];
  };
  expect(staleTxns.recovered).toEqual([]);
  expect(staleTxns.quarantined).toEqual([]);
  expect(staleTxns.deferred).toHaveLength(1);
  expect(staleTxns.deferred[0]?.kind).toBe("test-run-migrate-stuck");
  expect(staleTxns.deferred[0]?.reason).toMatch(/recovery action failed, journal is still trusted/);
});

test("a deferred journal does not block a sibling journal in the same status/apply pass", async () => {
  writeSandboxConfig({ defaultBundle: "primary", bundles: { primary: { path: storage.stashDir } } });
  registerTxnKind<{ label: string }>("test-run-migrate-stuck-sibling", {
    phases: ["prepared", "files-published", "committed"],
    commitPhase: "files-published",
    rollback() {
      throw new Error("recovery action failed, journal is still trusted");
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
    kind: "test-run-migrate-stuck-sibling",
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
    deferred: { kind: string }[];
  };
  expect(staleTxns.recovered.map((j) => j.kind)).toEqual(["test-run-migrate-healthy-sibling"]);
  expect(staleTxns.quarantined).toEqual([]);
  expect(staleTxns.deferred.map((j) => j.kind)).toEqual(["test-run-migrate-stuck-sibling"]);
  expect(plan.status).toBe("current");
});
