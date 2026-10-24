import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { akmAdapter } from "../../../src/core/adapter/adapters/akm-adapter";
import { akmTaskAdapter } from "../../../src/core/adapter/adapters/akm-task-adapter";
import { akmWorkflowAdapter } from "../../../src/core/adapter/adapters/akm-workflow-adapter";
import { BUILTIN_ADAPTERS } from "../../../src/core/adapter/adapters/index";
import type { BundleComponent, ValidateContext } from "../../../src/core/adapter/types";
import { buildFileContext } from "../../../src/indexer/walk/file-context";

const YAML = `name: Adapter contract
on:
  workflow_dispatch:
jobs:
  main:
    runs-on: [self-hosted]
    steps:
      - id: check
        run: bun test
`;

function context(root: string): ValidateContext {
  return {
    readFile: async (relative) => fs.readFileSync(path.join(root, relative), "utf8"),
    list: async () => [],
    resolveRef: async () => ({ exists: false }),
  };
}

describe("GitHub YAML workflow adapter ownership", () => {
  test("the workflow adapter claims a complete on+jobs .yml root before the task adapter", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "akm-workflow-adapter-"));
    const filePath = path.join(root, "contract.yml");
    fs.writeFileSync(filePath, YAML);
    try {
      expect(BUILTIN_ADAPTERS.indexOf(akmWorkflowAdapter)).toBeLessThan(BUILTIN_ADAPTERS.indexOf(akmTaskAdapter));
      expect(akmWorkflowAdapter.looksLikeRoot?.(root)).toBe(true);
      expect(akmTaskAdapter.looksLikeRoot?.(root)).toBe(false);
      const component: BundleComponent = { id: "fixture", adapter: "akm-workflow", root, writable: false };
      const document = akmWorkflowAdapter.recognize(component, buildFileContext(root, filePath));
      expect(document).toMatchObject({
        ref: "fixture//contract",
        conceptId: "contract",
        adapterId: "akm-workflow",
        type: "workflow",
        name: "contract",
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("the ordinary AKM bundle recognizes workflows/*.yml as one workflow asset", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "akm-workflow-main-adapter-"));
    const workflowDir = path.join(root, "workflows");
    fs.mkdirSync(workflowDir);
    const filePath = path.join(workflowDir, "contract.yml");
    fs.writeFileSync(filePath, YAML);
    try {
      const component: BundleComponent = { id: "stash", adapter: "akm", root, writable: true };
      const document = akmAdapter.recognize(component, buildFileContext(root, filePath));
      expect(document).toMatchObject({
        ref: "stash//workflows/contract",
        conceptId: "workflows/contract",
        adapterId: "akm",
        type: "workflow",
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("validation returns one source-located workflow diagnostic and never task diagnostics", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "akm-workflow-validation-"));
    const bad = YAML.replace("run: bun test", "uses: actions/checkout@v4");
    fs.writeFileSync(path.join(root, "contract.yml"), bad);
    try {
      const component: BundleComponent = { id: "fixture", adapter: "akm-workflow", root, writable: false };
      const diagnostics = await akmWorkflowAdapter.validate?.(
        component,
        [{ op: "update", path: "contract.yml", before: YAML, after: bad }],
        context(root),
      );
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics?.[0]).toMatchObject({
        file: "contract.yml",
        issue: "invalid-workflow-structure",
        line: 9,
        fixed: false,
      });
      // P4 FLIP (docs/plans/specs/p4-deletions-closeout.md §3.1, row B-05,
      // F-A1.19): the locator grammar is deleted — this now rejects as an
      // unrecognized ref shape, not the old "remote action acquisition"
      // wording.
      expect(diagnostics?.[0]?.detail.toLowerCase()).toContain("target ref");
      expect(diagnostics?.some(({ issue }) => issue === "invalid-task-yaml")).toBe(false);
      expect(
        akmWorkflowAdapter.recognize(component, buildFileContext(root, path.join(root, "contract.yml"))),
      ).toMatchObject({ type: "workflow", conceptId: "contract", adapterId: "akm-workflow" });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("a malformed .yml in an explicit workflow component is diagnosed instead of silently skipped", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "akm-workflow-malformed-"));
    fs.writeFileSync(path.join(root, "broken.yml"), "- not\n- a\n- mapping\n");
    try {
      const component: BundleComponent = { id: "fixture", adapter: "akm-workflow", root, writable: false };
      const diagnostics = await akmWorkflowAdapter.validate?.(
        component,
        [{ op: "update", path: "broken.yml", after: "- not\n- a\n- mapping\n" }],
        context(root),
      );
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics?.[0]).toMatchObject({
        file: "broken.yml",
        issue: "invalid-workflow-structure",
        line: 1,
        fixed: false,
      });
      expect(diagnostics?.[0]?.detail).toContain("root must be a mapping");
      expect(
        akmWorkflowAdapter.recognize(component, buildFileContext(root, path.join(root, "broken.yml"))),
      ).toMatchObject({ type: "workflow", conceptId: "broken", adapterId: "akm-workflow" });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
