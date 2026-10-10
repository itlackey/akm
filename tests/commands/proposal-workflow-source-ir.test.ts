import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Proposal } from "../../src/commands/proposal/proposal-types";
import { validateProposal } from "../../src/commands/proposal/validators/proposals";

const workspaces: string[] = [];

function workspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akm-proposal-source-ir-"));
  workspaces.push(root);
  return root;
}

function workflowProposal(filePath: string, content: string, root: string): Proposal {
  return {
    id: "proposal-workflow-source-ir",
    ref: "stash//workflows/source-ir",
    status: "pending",
    source: "propose",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    payload: { content },
    changes: [{ path: filePath, after: content, op: "create" }],
    proposedTarget: { source: "stash", root },
  };
}

const MARKDOWN_WORKFLOW = `---
type: workflow
steps:
  - id: review
---

# Source IR review

## review

Review the source IR boundary.
`;

const GITHUB_WORKFLOW = `name: Source IR review
on: { workflow_dispatch: null }
jobs:
  contract:
    runs-on: [self-hosted]
    steps:
      - id: review
        uses: akm/command
        with:
          content: Review the source IR boundary.
`;

afterEach(() => {
  for (const root of workspaces.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("proposal workflow source-IR boundary", () => {
  test("a valid Markdown proposal passes validation without touching the workspace", () => {
    const root = workspace();
    const before = fs.readdirSync(root);

    expect(validateProposal(workflowProposal("workflows/source-ir.md", MARKDOWN_WORKFLOW, root))).toEqual({
      ok: true,
      findings: [],
    });
    expect(fs.readdirSync(root)).toEqual(before);
  });

  test.each([
    "yaml",
    "yml",
  ])("unsupported .%s proposals fail closed with source diagnostics and no workspace leak", (extension) => {
    const root = workspace();
    const before = fs.readdirSync(root);
    const report = validateProposal(workflowProposal(`workflows/source-ir.${extension}`, GITHUB_WORKFLOW, root));

    expect(report.ok).toBe(false);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]).toMatchObject({ kind: "invalid-workflow-structure" });
    expect(report.findings[0]?.message).toContain("unsupported-workflow-extension");
    expect(report.findings[0]?.message).toContain(`workflows/source-ir.${extension}:1`);
    expect(report.findings[0]?.message).not.toContain(root);
    expect(fs.readdirSync(root)).toEqual(before);
  });
});
