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
 * COMMENT B — `workflows/foo.yaml` and the canonical `workflows/foo` address the
 * same file and MUST share ONE run identity: the active-run guard blocks the
 * alias spelling, and `list --ref` finds runs regardless of how the ref was
 * spelled. Regression: before the fix the stored `workflow_ref` kept the
 * extension, so the two aliases started parallel runs and later queries missed.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { createWorkflowAsset, validateWorkflowProgramSource } from "../../../src/workflows/authoring/authoring";
import { getWorkflowStatus, listWorkflowRuns, startWorkflowRun } from "../../../src/workflows/runtime/runs";
import { loadWorkflowAsset } from "../../../src/workflows/runtime/workflow-asset-loader";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeWorkflowTestConfig } from "../../_helpers/sandbox";

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  writeWorkflowTestConfig();
});

afterEach(() => storage.cleanup());

// ── COMMENT A: create foo.yaml → program asset that round-trips ──────────────

describe("workflow create with a .yaml/.yml name writes a YAML program", () => {
  test("create foo.yaml writes+validates a program and start/status round-trips", async () => {
    const created = createWorkflowAsset({ name: "foo.yaml" });

    // Canonical (extension-free) ref; the file keeps its .yaml suffix.
    expect(created.ref).toBe("workflows/foo");
    expect(created.path).toBe(path.join(storage.stashDir, "workflows", "foo.yaml"));

    // The written body is a YAML program, not the markdown template.
    const written = fs.readFileSync(created.path, "utf8");
    expect(written).toContain("version: 2");
    expect(written).toContain("steps:");
    expect(written).not.toContain("# Workflow:");

    // Validates cleanly through the program parser+compiler (what `validate`
    // uses for a .yaml target).
    const { result } = validateWorkflowProgramSource(created.path);
    expect(result.ok).toBe(true);

    // Loads as a program (this is what threw before the fix — the markdown
    // template failed the program parser selected by the .yaml extension).
    const asset = await loadWorkflowAsset("workflows/foo");
    expect(asset.program).toBeDefined();
    expect(asset.document).toBeUndefined();

    // start → status round-trip on the canonical ref.
    const started = await startWorkflowRun("workflows/foo");
    const status = await getWorkflowStatus(started.run.id);
    expect(status.workflow.ref).toBe("workflows/foo");
    expect(status.run.status).toBe("active");
  });

  test("create bar.yml also produces a program asset", async () => {
    const created = createWorkflowAsset({ name: "bar.yml" });
    expect(created.ref).toBe("workflows/bar");
    expect(created.path).toBe(path.join(storage.stashDir, "workflows", "bar.yml"));

    const asset = await loadWorkflowAsset("workflows/bar");
    expect(asset.program).toBeDefined();
  });

  test("create foo (no extension) still writes a markdown document", async () => {
    const created = createWorkflowAsset({ name: "plain" });
    expect(created.ref).toBe("workflows/plain");
    expect(created.path).toBe(path.join(storage.stashDir, "workflows", "plain.md"));
    const asset = await loadWorkflowAsset("workflows/plain");
    expect(asset.document).toBeDefined();
    expect(asset.program).toBeUndefined();
  });
});

// ── COMMENT B: one run identity across the alias spellings ───────────────────

describe("workflow_ref canonicalization collapses foo.yaml and foo", () => {
  test("the active-run guard blocks the aliased spelling", async () => {
    createWorkflowAsset({ name: "guard.yaml" });

    const first = await startWorkflowRun("workflows/guard");
    expect(first.run.status).toBe("active");

    // Starting the SAME workflow addressed with the .yaml alias must be
    // refused by the concurrency guard — not silently start a parallel run.
    await expect(startWorkflowRun("workflows/guard.yaml")).rejects.toThrow(/already has an active run/);
  });

  test("the guard also blocks the canonical spelling when the alias started the run", async () => {
    createWorkflowAsset({ name: "guard2.yaml" });

    await startWorkflowRun("workflows/guard2.yaml");
    await expect(startWorkflowRun("workflows/guard2")).rejects.toThrow(/already has an active run/);
  });

  test("list --ref finds the run regardless of how the ref is spelled", async () => {
    createWorkflowAsset({ name: "listed.yaml" });
    const started = await startWorkflowRun("workflows/listed");

    const byCanonical = await listWorkflowRuns({ workflowRef: "workflows/listed" });
    const byAlias = await listWorkflowRuns({ workflowRef: "workflows/listed.yaml" });

    expect(byCanonical.runs.map((r) => r.id)).toContain(started.run.id);
    expect(byAlias.runs.map((r) => r.id)).toContain(started.run.id);

    // Both spellings resolve to exactly the same (single) run; the stored ref
    // is canonical.
    expect(byAlias.runs).toEqual(byCanonical.runs);
    for (const run of byCanonical.runs) expect(run.workflowRef).toBe("workflows/listed");
  });
});

// ── COMMENT C (Codex round-3 finding C): reject cross-extension shadows ───────

describe("workflow create rejects a canonical-name collision across extensions", () => {
  test("creating foo.yaml is refused when foo.md already exists (would shadow it)", () => {
    const md = createWorkflowAsset({ name: "dup" });
    expect(md.path).toBe(path.join(storage.stashDir, "workflows", "dup.md"));

    // The `.md` resolves BEFORE `.yaml`, so a `dup.yaml` would be shadowed by
    // `dup.md` under the canonical `workflows/dup` ref — refuse and name the file.
    let err: unknown;
    try {
      createWorkflowAsset({ name: "dup.yaml" });
    } catch (e) {
      err = e;
    }
    expect(String((err as Error).message)).toContain("already exists as");
    expect(String((err as Error).message)).toContain("dup.md");
    // No shadowing file was written.
    expect(fs.existsSync(path.join(storage.stashDir, "workflows", "dup.yaml"))).toBe(false);
  });

  test("creating foo.md is refused when foo.yaml already exists (the other direction)", () => {
    createWorkflowAsset({ name: "dup2.yaml" });

    let err: unknown;
    try {
      createWorkflowAsset({ name: "dup2" }); // no extension ⇒ resolves to dup2.md
    } catch (e) {
      err = e;
    }
    expect(String((err as Error).message)).toContain("already exists as");
    expect(String((err as Error).message)).toContain("dup2.yaml");
    expect(fs.existsSync(path.join(storage.stashDir, "workflows", "dup2.md"))).toBe(false);
  });

  test("--force does NOT punch through a different-extension shadow", () => {
    createWorkflowAsset({ name: "dup3.md" });
    expect(() => createWorkflowAsset({ name: "dup3.yaml", force: true })).toThrow(/already exists as/);
  });

  test("--force still overwrites the SAME extension (classic behavior preserved)", () => {
    createWorkflowAsset({ name: "same.yaml" });
    // Same target extension: force is allowed to overwrite.
    expect(() => createWorkflowAsset({ name: "same.yaml", force: true })).not.toThrow();
  });
});
