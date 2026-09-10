// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * #942 — `akm workflow run/list/status/abandon` must not silently disagree
 * about whether a ref has an active run just because the caller's cwd
 * differs (a scheduled task's cwd vs. a human's shell hash to different
 * scope keys). `list` stays scope-local by default (the documented
 * per-project partition, storage-locations.md), but:
 *   - `list`/`list --all-scopes` now say WHICH scope they searched, so an
 *     empty result is never indistinguishable from "nothing anywhere";
 *   - `--all-scopes` surfaces a run started in another scope;
 *   - starting the same ref from a scope with no active run of its own now
 *     warns, naming the other scope's run id and scope, instead of silently
 *     starting a second, colliding run;
 *   - `abandon <id>` still works from any scope (#919, unchanged).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { withWorkflowRunsRepo } from "../../../src/storage/repositories/workflow-runs-repository";
import { getCurrentWorkflowScopeKey } from "../../../src/workflows/authoring/scope-key";
import type { UnitDispatcher } from "../../../src/workflows/exec/native-executor";
import { runWorkflowSteps } from "../../../src/workflows/exec/run-workflow";
import { abandonWorkflowRun, listWorkflowRuns } from "../../../src/workflows/runtime/runs";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeWorkflowTestConfig } from "../../_helpers/sandbox";

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  writeWorkflowTestConfig();
});

afterEach(() => storage.cleanup());

const okDispatcher: UnitDispatcher = async () => ({ ok: true, text: "done" });

/** Two steps so `--max-steps=1` leaves the run genuinely `active`, mirroring run-resume-and-new.test.ts. */
function writeTwoStepWorkflow(name: string): void {
  fs.mkdirSync(path.join(storage.stashDir, "workflows"), { recursive: true });
  fs.writeFileSync(
    path.join(storage.stashDir, "workflows", `${name}.md`),
    [
      "---",
      "type: workflow",
      "description: scope visibility test",
      "steps:",
      "  - id: first-step",
      "  - id: second-step",
      "---",
      "",
      "## first-step",
      "",
      "Do the first thing.",
      "",
      "## second-step",
      "",
      "Do the second thing.",
      "",
    ].join("\n"),
    "utf8",
  );
}

/** Run `fn` with `process.cwd()` switched to `dir`, always restored — never left dangling on a throw. */
async function withCwd<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const prior = process.cwd();
  process.chdir(dir);
  try {
    return await fn();
  } finally {
    process.chdir(prior);
  }
}

describe("#942 — active runs are visible across scopes", () => {
  test("list names the scope searched, --all-scopes finds another scope's run, starting from there warns, and abandon works from anywhere", async () => {
    writeTwoStepWorkflow("cross-scope");

    // Scope A: cwd inside the stash.
    const scopeA = await withCwd(storage.stashDir, async () => getCurrentWorkflowScopeKey());
    const started = await withCwd(storage.stashDir, () =>
      runWorkflowSteps({ target: "workflows/cross-scope", maxSteps: 1, dispatcher: okDispatcher }),
    );
    expect(started.run.status).toBe("active");
    const runIdA = started.run.id;

    // Scope B: cwd well outside the stash (os.tmpdir() is an ancestor of
    // storage.root, never of storage.stashDir, so it never resolves as "inside
    // the stash" — see resolveWorkflowScopeAnchor).
    const scopeB = await withCwd(os.tmpdir(), async () => getCurrentWorkflowScopeKey());
    expect(scopeB).not.toBe(scopeA);

    // `list` from scope B sees nothing for the default (scope-local) view —
    // but now names WHICH scope it searched, so this is distinguishable from
    // "nothing anywhere".
    const emptyFromB = await withCwd(os.tmpdir(), () => listWorkflowRuns());
    expect(emptyFromB.runs).toEqual([]);
    expect(emptyFromB.scopeKey).toBe(scopeB);

    // `list --all-scopes` from scope B finds the run started in scope A, and
    // reports `scopeKey: null` (searched every scope) on the envelope while
    // the run's own per-row `scopeKey` still names where it actually started.
    const allScopes = await withCwd(os.tmpdir(), () => listWorkflowRuns({ allScopes: true }));
    expect(allScopes.scopeKey).toBeNull();
    expect(allScopes.runs.map((r) => r.id)).toContain(runIdA);
    expect(allScopes.runs.find((r) => r.id === runIdA)?.scopeKey).toBe(scopeA);

    // Starting the SAME ref from scope B does not collide with scope A's
    // guard (the scope-local uniqueness guard stays scope-local, a
    // deliberate per-project partition) — it starts a genuinely separate
    // run — but warns, naming scope A's run id and scope, instead of
    // silently leaving two stalled "active" answers for the same ref.
    const startedFromB = await withCwd(os.tmpdir(), () =>
      runWorkflowSteps({ target: "workflows/cross-scope", maxSteps: 1, dispatcher: okDispatcher }),
    );
    expect(startedFromB.run.id).not.toBe(runIdA);
    expect(startedFromB.resumed).toBeUndefined();
    const warnings = startedFromB.warnings ?? [];
    expect(warnings.some((w) => w.includes(runIdA) && w.includes(scopeA) && w.includes("another scope"))).toBe(true);

    // `abandon <id>` still works from any scope (#919) — pinned here for the
    // scope B run started above, called from scope B itself.
    const abandoned = await withCwd(os.tmpdir(), () => abandonWorkflowRun(startedFromB.run.id));
    expect(abandoned.run.status).toBe("failed");

    // And from scope B against the ORIGINAL scope-A run too.
    const abandonedA = await withCwd(os.tmpdir(), () => abandonWorkflowRun(runIdA));
    expect(abandonedA.run.status).toBe("failed");
  });

  test("repository: an own-scope active run does not mask a DIFFERENT scope's run under findActiveRunOutsideScope", async () => {
    // Regression pin (coordinator review of the initial #942 implementation):
    // `getActiveRunRowForScope(refs, null)` plus a `scope_key !== callerScope`
    // post-filter picks the single most-recently-updated active run across
    // EVERY scope, then discards it if it happens to be the caller's own —
    // so when the caller's own scope's run is the most recently updated one,
    // the whole query returns nothing, silently hiding a genuinely different
    // scope's active run (the exact failure the reviewer demonstrated with
    // `--new`/`--force`, where the caller's own active run wins the
    // `LIMIT 1`). `findActiveRunOutsideScope` excludes the caller's scope IN
    // SQL, so it cannot be masked this way regardless of timestamp order.
    const ref = "workflows/repo-level-scope-test";
    const scopeA = "scope-a-repo-test";
    const scopeB = "scope-b-repo-test";

    await withWorkflowRunsRepo(async (repo) => {
      // Scope B's run is seeded (and updated) FIRST, scope A's own run SECOND
      // — so scope A's row sorts first under `ORDER BY updated_at DESC`,
      // which is exactly the ordering that hid it under the old query.
      repo.insertRun({
        id: "run-scope-b",
        workflowRef: ref,
        scopeKey: scopeB,
        workflowEntryId: null,
        workflowTitle: "Repo-level scope test",
        paramsJson: "{}",
        currentStepId: "step-1",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        agentHarness: null,
        agentSessionId: null,
        checkinArmedAt: null,
      });
      repo.insertRun({
        id: "run-scope-a",
        workflowRef: ref,
        scopeKey: scopeA,
        workflowEntryId: null,
        workflowTitle: "Repo-level scope test",
        paramsJson: "{}",
        currentStepId: "step-1",
        createdAt: "2026-01-02T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
        agentHarness: null,
        agentSessionId: null,
        checkinArmedAt: null,
      });

      // The scope-local guard still finds the caller's own run.
      expect(repo.getActiveRunRowForScope([ref], scopeA)?.id).toBe("run-scope-a");

      // The cross-scope query, called AS the scope-A caller, must still
      // surface scope B's run — never masked by scope A's own, more
      // recently updated, row.
      const outsideA = repo.findActiveRunOutsideScope([ref], scopeA);
      expect(outsideA?.id).toBe("run-scope-b");
      expect(outsideA?.scope_key).toBe(scopeB);
    });
  });
});
