// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Each call site routed through `parseTaskSource` (which accepts exactly one
 * version) is exercised against a `version: 4` document: `run/load-task.ts`,
 * `akm-lint.ts` taskDiagnostics, `akm-task-adapter.ts` validate() +
 * looksLikeRoot(), `akm-metadata.ts` foldRecognizedMetadata, and the "task"
 * canonical proposal validator.
 *
 * `tests/lint-task-yaml.test.ts` and `tests/tasks/scheduler-binding.test.ts`
 * cover other call sites, and the scheduler-sync call site is covered in
 * tests/tasks-scheduler-sync-v4.test.ts rather than duplicated here.
 * `akmTasksAdd` (which re-parses the YAML `renderTaskYaml` just rendered,
 * always `version: 4`) is not duplicated here either: its own round trip is
 * covered un-mocked by tests/commands/tasks-write-target.test.ts and
 * tests/commands/tasks-lifecycle.test.ts.
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  defaultProposalValidators,
  runProposalValidators,
} from "../src/commands/proposal/validators/proposal-validators";
import { taskDiagnostics } from "../src/core/adapter/adapters/akm-lint";
import { applyFoldedMetadata, foldRecognizedMetadata } from "../src/core/adapter/adapters/akm-metadata";
import { akmTaskAdapter } from "../src/core/adapter/adapters/akm-task-adapter";
import type { BundleComponent } from "../src/core/adapter/types";
import { createValidateContext } from "../src/core/adapter/validate-context";
import type { IndexDocument } from "../src/indexer/passes/metadata";
import { buildFileContext } from "../src/indexer/walk/file-context";
import { makeProposal, payloadChanges } from "./_helpers/factories";

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

function component(root: string, adapter: string): BundleComponent {
  return { id: "fixture", adapter, root, writable: true };
}

const VALID_V4_TASK = ["version: 4", "run: echo hi", "shell: sh", ""].join("\n");
const INVALID_V4_TASK = ["version: 4", "uses: commands/x", "run: echo x", ""].join("\n"); // both uses and run

// ── akm-lint.ts — taskDiagnostics ───────────────────────────────────────────

describe("taskDiagnostics — akm lint on a version: 4 source (akm-lint.ts:317)", () => {
  test("a valid version: 4 source yields NO invalid-task-yaml diagnostic", () => {
    const diagnostics = taskDiagnostics("tasks/nightly.yml", VALID_V4_TASK);
    expect(diagnostics.filter((d) => d.issue === "invalid-task-yaml")).toEqual([]);
  });

  test("an invalid version: 4 source (both uses: and run:) yields invalid-task-yaml with the v4 detail text", () => {
    const diagnostics = taskDiagnostics("tasks/nightly.yml", INVALID_V4_TASK);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.issue).toBe("invalid-task-yaml");
    // What distinguishes a routed v4 failure from a stale "must be exactly 3"
    // mis-route is the "task source v4" label this detail rides on.
    expect(diagnostics[0]?.detail).toMatch(/exactly one/i);
    expect(diagnostics[0]?.detail).toMatch(/task source v4/i);
  });
});

// ── akm-task-adapter.ts — validate() + looksLikeRoot() ─────────────────────

describe("akmTaskAdapter.validate() — a version: 4 source (akm-task-adapter.ts:99)", () => {
  test("a valid version: 4 .yml yields zero diagnostics", async () => {
    const root = tmpDir("akm-task-adapter-v4-valid-");
    writeFile(path.join(root, "nightly.yml"), VALID_V4_TASK);

    const diagnostics = await akmTaskAdapter.validate(
      component(root, "akm-task"),
      [{ path: "nightly.yml", op: "update" }],
      createValidateContext({ root }),
    );

    expect(diagnostics).toEqual([]);
  });

  test("an invalid version: 4 .yml is invalid-task-yaml, consuming the union without throwing", async () => {
    const root = tmpDir("akm-task-adapter-v4-invalid-");
    writeFile(path.join(root, "bad.yml"), INVALID_V4_TASK);

    const diagnostics = await akmTaskAdapter.validate(
      component(root, "akm-task"),
      [{ path: "bad.yml", op: "update" }],
      createValidateContext({ root }),
    );

    expect(diagnostics.map((d) => d.issue)).toEqual(["invalid-task-yaml"]);
  });
});

describe("akmTaskAdapter.looksLikeRoot() — a version: 4 root (akm-task-adapter.ts:164)", () => {
  test("a directory containing only a valid version: 4 .yml is detected as an akm-task root", () => {
    const root = tmpDir("akm-task-adapter-v4-root-");
    writeFile(path.join(root, "nightly.yml"), VALID_V4_TASK);

    if (!akmTaskAdapter.looksLikeRoot) throw new Error("akmTaskAdapter.looksLikeRoot must be defined");
    expect(akmTaskAdapter.looksLikeRoot(root)).toBe(true);
  });

  // The runtime reads only v4 (#987), but a root of v2/v3 task files is still
  // an akm-task root: `akm migrate apply` must find those files to convert
  // them, and `akm task sync` must report them rather than lose their rows.
  test.each([
    ["version: 2", "version: 2\nschedule: '@daily'\ncommand: /bin/echo ok\n"],
    ["version: 3", "version: 3\nrun: echo ok\nakm:\n  schedule: '@daily'\n"],
  ])("a directory holding only a %s task file is detected as an akm-task root", (_label, yaml) => {
    const root = tmpDir("akm-task-adapter-legacy-root-");
    writeFile(path.join(root, "weekly.yml"), yaml);
    expect(akmTaskAdapter.looksLikeRoot?.(root)).toBe(true);
  });

  test("YAML that declares a version but no task target is not a task root", () => {
    const root = tmpDir("akm-task-adapter-compose-root-");
    writeFile(path.join(root, "docker-compose.yml"), "version: 3\nservices:\n  web:\n    image: nginx\n");
    expect(akmTaskAdapter.looksLikeRoot?.(root)).toBe(false);
  });
});

// ── akm-metadata.ts — foldRecognizedMetadata ───────────────────────────────
//
// FoldedMetadata (akm-metadata.ts) has no `name` field — `IndexDocument.name`
// is set by the CALLING recognizer from the conceptId/filename, not by this
// fold. This block therefore covers the three fields the fold CAN carry:
// description, tags, and the when_to_use searchHint (mirroring the
// lesson-md/memory-md cases' own `applyFrontmatterDescriptionAndTags` +
// `when_to_use:` hint pattern).

describe("foldRecognizedMetadata('task-yaml', …) — a version: 4 task's top-level keys (akm-metadata.ts:242)", () => {
  test("description, tags, and a when_to_use: searchHint are extracted from the v4 document's TOP-LEVEL keys", () => {
    const root = tmpDir("akm-metadata-v4-");
    const filePath = path.join(root, "tasks", "nightly.yml");
    writeFile(
      filePath,
      [
        "version: 4",
        "description: Nightly v4 review",
        "when_to_use: Run every weeknight",
        "tags: [contract, review]",
        "run: echo hi",
        "shell: sh",
        "",
      ].join("\n"),
    );

    const ctx = buildFileContext(root, filePath);
    const entry: IndexDocument = { name: "nightly", type: "task" };
    applyFoldedMetadata(entry, foldRecognizedMetadata("task-yaml", ctx));

    expect(entry.description).toBe("Nightly v4 review");
    expect(entry.tags).toContain("contract");
    expect(entry.tags).toContain("review");
    // Still applies unconditionally.
    expect(entry.tags).toContain("task");
    expect(entry.tags).toContain("scheduled");
    expect(entry.searchHints).toContain("when_to_use:Run every weeknight");
  });

  test("does not throw for a version: 4 document — the fold consumes the union (smoke, akm-metadata.ts:242)", () => {
    const root = tmpDir("akm-metadata-v4-smoke-");
    const filePath = path.join(root, "tasks", "nightly.yml");
    writeFile(filePath, VALID_V4_TASK);
    const ctx = buildFileContext(root, filePath);

    expect(() => foldRecognizedMetadata("task-yaml", ctx)).not.toThrow();
  });
});

// ── proposal-validators.ts — the "task" canonical proposal validator ───────

describe("the canonical task proposal validator consumes a version: 4 proposal body (smoke, proposal-validators.ts:76)", () => {
  const canonicalValidator = defaultProposalValidators.find((v) => v.name === "canonical-asset-proposal-validator");

  test("canonical-asset-proposal-validator is registered in defaultProposalValidators", () => {
    expect(canonicalValidator).toBeDefined();
  });

  test("a valid version: 4 proposal body yields zero findings", () => {
    if (!canonicalValidator) throw new Error("canonical-asset-proposal-validator must be registered");
    const proposal = makeProposal("tasks/nightly");
    proposal.changes = payloadChanges(VALID_V4_TASK);

    const report = runProposalValidators(proposal, [canonicalValidator], {
      parsedRef: { type: "task", name: "nightly" },
    });

    expect(report.findings).toEqual([]);
  });

  test("an invalid version: 4 proposal body yields an invalid-task-structure finding, not a throw", () => {
    if (!canonicalValidator) throw new Error("canonical-asset-proposal-validator must be registered");
    const proposal = makeProposal("tasks/bad");
    proposal.changes = payloadChanges(INVALID_V4_TASK);

    const report = runProposalValidators(proposal, [canonicalValidator], {
      parsedRef: { type: "task", name: "bad" },
    });

    expect(report.findings.map((f) => f.kind)).toEqual(["invalid-task-structure"]);
  });
});
