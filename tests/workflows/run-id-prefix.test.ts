// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * #919 — one run-id prefix resolver, used everywhere a run id is accepted.
 * `status` already fell back to a workflow-ref listing (which happens to
 * make an 8-char prefix "work" there), but `abandon`/`resume`/`run <id>`
 * required the full UUID. `WorkflowRunsRepository.resolveRunIdPrefix` and
 * the `readWorkflowRun`/`resolveWorkflowRunTarget` call sites in
 * `runtime/runs.ts` fix that centrally.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { NotFoundError, UsageError } from "../../src/core/errors";
import { withWorkflowRunsRepo } from "../../src/storage/repositories/workflow-runs-repository";
import { abandonWorkflowRun, resolveWorkflowRunTarget, startWorkflowRun } from "../../src/workflows/runtime/runs";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeWorkflowTestConfig } from "../_helpers/sandbox";

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  writeWorkflowTestConfig();
});

afterEach(() => storage.cleanup());

function writeWorkflow(name: string): void {
  fs.mkdirSync(path.join(storage.stashDir, "workflows"), { recursive: true });
  fs.writeFileSync(
    path.join(storage.stashDir, "workflows", `${name}.md`),
    [
      "---",
      "type: workflow",
      "description: Run id prefix test",
      "steps:",
      "  - id: work",
      "---",
      "",
      "## work",
      "",
      "Do the work.",
      "",
    ].join("\n"),
    "utf8",
  );
}

/** Insert a minimal, otherwise-unused run row with a controlled `id`. */
function insertRunWithId(id: string): void {
  withWorkflowRunsRepo((repo) => {
    repo.insertRun({
      id,
      workflowRef: "workflows/fixture",
      scopeKey: null,
      workflowEntryId: null,
      workflowTitle: "fixture",
      paramsJson: "{}",
      currentStepId: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      agentHarness: null,
      agentSessionId: null,
    });
  });
}

describe("#919 — WorkflowRunsRepository.resolveRunIdPrefix", () => {
  test("resolves a prefix that matches exactly one run id", async () => {
    insertRunWithId("abcdef12-0000-0000-0000-000000000001");
    insertRunWithId("11112222-0000-0000-0000-000000000002");
    const resolved = await withWorkflowRunsRepo((repo) => repo.resolveRunIdPrefix("abcdef12"));
    expect(resolved).toBe("abcdef12-0000-0000-0000-000000000001");
  });

  test("throws a UsageError naming every candidate when the prefix is ambiguous", async () => {
    insertRunWithId("abcdef12-0000-0000-0000-000000000001");
    insertRunWithId("abcdef12-0000-0000-0000-000000000002");
    await expect(withWorkflowRunsRepo((repo) => repo.resolveRunIdPrefix("abcdef12"))).rejects.toThrow(
      /abcdef12-0000-0000-0000-000000000001.*abcdef12-0000-0000-0000-000000000002/,
    );
  });

  test("throws a NotFoundError when nothing matches the prefix", async () => {
    insertRunWithId("abcdef12-0000-0000-0000-000000000001");
    await expect(withWorkflowRunsRepo((repo) => repo.resolveRunIdPrefix("deadbeef"))).rejects.toThrow(NotFoundError);
  });
});

describe("#919 — run-id-or-ref resolution never mistakes a ref for a prefix", () => {
  test("resolveWorkflowRunTarget falls through (returns undefined) for a workflow ref", async () => {
    // A workflow ref always contains a "/" — outside the id/prefix charset
    // (`^[0-9a-f-]{8,}$`) — so it must never be resolved as a run id prefix,
    // even when nothing in the repo matches it either way.
    const resolved = await resolveWorkflowRunTarget("workflows/does-not-exist");
    expect(resolved).toBeUndefined();
  });

  test("resolveWorkflowRunTarget resolves a bare id-shaped prefix", async () => {
    insertRunWithId("abcdef12-0000-0000-0000-000000000001");
    const resolved = await resolveWorkflowRunTarget("abcdef12");
    expect(resolved).toBe("abcdef12-0000-0000-0000-000000000001");
  });
});

describe("#919 — abandon accepts the same id prefixes as status", () => {
  test("`abandon <8-char prefix>` resolves and abandons the matching run", async () => {
    writeWorkflow("abandon-me");
    const started = await startWorkflowRun("workflows/abandon-me");
    const prefix = started.run.id.slice(0, 8);

    const abandoned = await abandonWorkflowRun(prefix);

    expect(abandoned.run.id).toBe(started.run.id);
    expect(abandoned.run.status).toBe("failed");
  });

  test("`abandon <ambiguous prefix>` reports a UsageError naming both runs", async () => {
    insertRunWithId("abcdef12-0000-0000-0000-000000000001");
    insertRunWithId("abcdef12-0000-0000-0000-000000000002");
    await expect(abandonWorkflowRun("abcdef12")).rejects.toThrow(UsageError);
  });
});
