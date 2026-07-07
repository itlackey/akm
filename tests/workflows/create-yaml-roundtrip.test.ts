// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * PR #714 review follow-ups on workflow ref/extension handling.
 *
 * COMMENT A — `akm workflow create foo.yaml` must write AND validate a YAML
 * *program* (not the markdown template) so the created asset round-trips
 * through show/start/validate, which pick the program parser by the `.yaml`
 * extension. Regression: before the fix the create path wrote the markdown
 * template to `foo.yaml`, so `loadWorkflowAsset` (program parser) rejected it.
 *
 * COMMENT B — `workflow:foo.yaml` and the canonical `workflow:foo` address the
 * same file and MUST share ONE run identity: the active-run guard blocks the
 * alias spelling, and `list --ref` finds runs regardless of how the ref was
 * spelled. Regression: before the fix the stored `workflow_ref` kept the
 * extension, so the two aliases started parallel runs and later queries missed.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { createWorkflowAsset, validateWorkflowProgramSource } from "../../src/workflows/authoring/authoring";
import { getWorkflowStatus, listWorkflowRuns, startWorkflowRun } from "../../src/workflows/runtime/runs";
import { loadWorkflowAsset } from "../../src/workflows/runtime/workflow-asset-loader";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../_helpers/sandbox";

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
});

afterEach(() => storage.cleanup());

// ── COMMENT A: create foo.yaml → program asset that round-trips ──────────────

describe("workflow create with a .yaml/.yml name writes a YAML program", () => {
  test("create foo.yaml writes+validates a program and start/status round-trips", async () => {
    const created = createWorkflowAsset({ name: "foo.yaml" });

    // Canonical (extension-free) ref; the file keeps its .yaml suffix.
    expect(created.ref).toBe("workflow:foo");
    expect(created.path).toBe(path.join(storage.stashDir, "workflows", "foo.yaml"));

    // The written body is a YAML program, not the markdown template.
    const written = fs.readFileSync(created.path, "utf8");
    expect(written).toContain("version: 1");
    expect(written).toContain("steps:");
    expect(written).not.toContain("# Workflow:");

    // Validates cleanly through the program parser+compiler (what `validate`
    // uses for a .yaml target).
    const { result } = validateWorkflowProgramSource(created.path);
    expect(result.ok).toBe(true);

    // Loads as a program (this is what threw before the fix — the markdown
    // template failed the program parser selected by the .yaml extension).
    const asset = await loadWorkflowAsset("workflow:foo");
    expect(asset.program).toBeDefined();
    expect(asset.document).toBeUndefined();

    // start → status round-trip on the canonical ref.
    const started = await startWorkflowRun("workflow:foo");
    const status = await getWorkflowStatus(started.run.id);
    expect(status.workflow.ref).toBe("workflow:foo");
    expect(status.run.status).toBe("active");
  });

  test("create bar.yml also produces a program asset", async () => {
    const created = createWorkflowAsset({ name: "bar.yml" });
    expect(created.ref).toBe("workflow:bar");
    expect(created.path).toBe(path.join(storage.stashDir, "workflows", "bar.yml"));

    const asset = await loadWorkflowAsset("workflow:bar");
    expect(asset.program).toBeDefined();
  });

  test("create foo (no extension) still writes a markdown document", async () => {
    const created = createWorkflowAsset({ name: "plain" });
    expect(created.ref).toBe("workflow:plain");
    expect(created.path).toBe(path.join(storage.stashDir, "workflows", "plain.md"));
    const asset = await loadWorkflowAsset("workflow:plain");
    expect(asset.document).toBeDefined();
    expect(asset.program).toBeUndefined();
  });
});

// ── COMMENT B: one run identity across the alias spellings ───────────────────

describe("workflow_ref canonicalization collapses foo.yaml and foo", () => {
  test("the active-run guard blocks the aliased spelling", async () => {
    createWorkflowAsset({ name: "guard.yaml" });

    const first = await startWorkflowRun("workflow:guard");
    expect(first.run.status).toBe("active");

    // Starting the SAME workflow addressed with the .yaml alias must be
    // refused by the concurrency guard — not silently start a parallel run.
    await expect(startWorkflowRun("workflow:guard.yaml")).rejects.toThrow(/already has an active run/);
  });

  test("the guard also blocks the canonical spelling when the alias started the run", async () => {
    createWorkflowAsset({ name: "guard2.yaml" });

    await startWorkflowRun("workflow:guard2.yaml");
    await expect(startWorkflowRun("workflow:guard2")).rejects.toThrow(/already has an active run/);
  });

  test("list --ref finds the run regardless of how the ref is spelled", async () => {
    createWorkflowAsset({ name: "listed.yaml" });
    const started = await startWorkflowRun("workflow:listed");

    const byCanonical = await listWorkflowRuns({ workflowRef: "workflow:listed" });
    const byAlias = await listWorkflowRuns({ workflowRef: "workflow:listed.yaml" });

    expect(byCanonical.runs.map((r) => r.id)).toContain(started.run.id);
    expect(byAlias.runs.map((r) => r.id)).toContain(started.run.id);

    // Both spellings resolve to exactly the same (single) run; the stored ref
    // is canonical.
    expect(byAlias.runs).toEqual(byCanonical.runs);
    for (const run of byCanonical.runs) expect(run.workflowRef).toBe("workflow:listed");
  });
});
