// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Chunk 5 F4a M-core-2 (item 3) — drain-layer broken-workflow drop.
 *
 * The `akm` adapter's `recognize`/`foldRecognizedMetadata` SWALLOWS a workflow
 * parse error (returns a document with just the base metadata), so a broken
 * workflow would silently index through the raw recognize path. The live
 * pipeline dropped it via the renderer contributor's throw → skip-with-warning.
 * `drainDirDocuments` restores that drop: it re-runs the workflow parser and
 * drops the entry with a `Skipped workflow …` warning.
 *
 * This pins the GAP directly (recognize alone does NOT drop; the drain does),
 * complementing the end-to-end coverage in
 * `tests/integration/workflows/indexer-rejection.test.ts`.
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { akmAdapter } from "../../src/core/adapter/adapters/akm-adapter";
import { akmWorkflowAdapter } from "../../src/core/adapter/adapters/akm-workflow-adapter";
import type { BundleComponent } from "../../src/core/adapter/types";
import { drainDirDocuments } from "../../src/indexer/scan/drain-dir";
import { buildFileContext } from "../../src/indexer/walk/file-context";

const VALID_WORKFLOW = `---
type: workflow
steps:
  - id: validate
---

# Ship Release

## validate

Confirm release notes are present.
`;

// Duplicate step ID ("first") — a parse error the workflow validator rejects.
const BROKEN_WORKFLOW = `---
type: workflow
steps:
  - id: first
  - id: first
---

## first

do A
`;

const VALID_YAML_WORKFLOW = `name: YAML drain
on: { workflow_dispatch: null }
jobs:
  main:
    runs-on: [self-hosted]
    steps:
      - id: validate
        run: echo ok
        working-directory: packages/cli
`;

const BROKEN_YAML_WORKFLOW = VALID_YAML_WORKFLOW.replace(
  "        run: echo ok\n        working-directory: packages/cli",
  "        uses: actions/checkout@v4",
);

function makeStash(): { stashDir: string; goodPath: string; badPath: string } {
  const stashDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-drain-wf-"));
  fs.mkdirSync(path.join(stashDir, "workflows"), { recursive: true });
  const goodPath = path.join(stashDir, "workflows", "good.md");
  const badPath = path.join(stashDir, "workflows", "bad.md");
  fs.writeFileSync(goodPath, VALID_WORKFLOW);
  fs.writeFileSync(badPath, BROKEN_WORKFLOW);
  return { stashDir, goodPath, badPath };
}

function component(root: string): BundleComponent {
  return { id: "b", adapter: "akm", root, writable: true };
}

describe("drain-layer broken-workflow drop (F4a M-core-2 item 3)", () => {
  test("recognize ALONE swallows the workflow parse error (the gap the drain closes)", () => {
    const { stashDir, badPath } = makeStash();
    const brokenCtx = buildFileContext(stashDir, badPath);
    // The adapter fold does NOT throw and does NOT abstain on a broken workflow
    // — it returns a full IndexDocument. Without the drain re-check this would
    // silently land in the index.
    const doc = akmAdapter.recognize(component(stashDir), brokenCtx);
    expect(doc).not.toBeNull();
    expect(doc?.type).toBe("workflow");
  });

  test("drain drops the broken workflow with a 'Skipped workflow' warning, keeps the valid one", () => {
    const { stashDir, goodPath, badPath } = makeStash();
    const ctxs = [buildFileContext(stashDir, goodPath), buildFileContext(stashDir, badPath)];

    const drained = drainDirDocuments(akmAdapter, component(stashDir), ctxs);

    // Only the valid workflow survives.
    expect(drained.entries).toHaveLength(1);
    expect(drained.entries[0]?.name).toBe("good");
    expect(drained.entries[0]?.type).toBe("workflow");

    // The broken one produced a workflow-skip warning naming the file.
    expect(drained.warnings).toHaveLength(1);
    const warning = drained.warnings[0];
    if (!warning) throw new Error("Expected one workflow warning");
    expect(warning.startsWith("Skipped workflow ")).toBe(true);
    expect(warning).toContain(badPath);
    // Its concrete parse error (duplicate step id) is carried in the detail.
    expect(warning).toMatch(/Duplicate step id/);

    // The valid workflow's hash is surfaced (content_hash source), the broken
    // one's is not (it never became an entry).
    expect(drained.hashByFile.get(goodPath)).toBeDefined();
    expect(drained.hashByFile.get(badPath)).toBeUndefined();
  });

  test.each([
    ["ordinary", akmAdapter, "akm", "workflows"],
    ["standalone", akmWorkflowAdapter, "akm-workflow", "."],
  ] as const)("%s adapter drains valid YAML and surfaces invalid YAML", (_label, adapter, adapterId, subdir) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "akm-drain-yaml-"));
    const ownedDir = path.join(root, subdir);
    fs.mkdirSync(ownedDir, { recursive: true });
    const goodPath = path.join(ownedDir, "good.yml");
    const badPath = path.join(ownedDir, "bad.yml");
    fs.writeFileSync(goodPath, VALID_YAML_WORKFLOW);
    fs.writeFileSync(badPath, BROKEN_YAML_WORKFLOW);
    try {
      const c: BundleComponent = { id: "b", adapter: adapterId, root, writable: true };
      const contexts = [buildFileContext(root, goodPath), buildFileContext(root, badPath)];
      const [goodContext, badContext] = contexts;
      if (!goodContext || !badContext) throw new Error("YAML drain fixture must contain two contexts");
      expect(adapter.recognize(c, goodContext)).toMatchObject({ type: "workflow" });
      expect(adapter.recognize(c, badContext)).toMatchObject({ type: "workflow" });

      const drained = drainDirDocuments(adapter, c, contexts);
      expect(drained.entries.map(({ name }) => name)).toEqual(["good"]);
      expect(drained.warnings).toHaveLength(1);
      expect(drained.warnings[0]).toContain(badPath);
      // P4 FLIP (docs/plans/specs/p4-deletions-closeout.md §3.1, row B-05,
      // F-A1.19): the locator grammar is deleted — this now rejects as an
      // unrecognized ref shape, not the old "Remote action acquisition"
      // wording.
      expect(drained.warnings[0]).toContain("Target ref");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test.each([
    ["ordinary", akmAdapter, "akm", "workflows"],
    ["standalone", akmWorkflowAdapter, "akm-workflow", "."],
  ] as const)("%s adapter drains inline akm/command content without scanning it for native-tool constructs", (_label, adapter, adapterId, subdir) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "akm-drain-template-"));
    const ownedDir = path.join(root, subdir);
    fs.mkdirSync(ownedDir, { recursive: true });
    const templatePath = path.join(ownedDir, "template.yml");
    fs.writeFileSync(
      templatePath,
      `name: Inline template
on: { workflow_dispatch: null }
jobs:
  main:
    runs-on: [self-hosted]
    steps:
      - id: review
        uses: akm/command
        with:
          content: Review $ARGUMENTS against @docs/style-guide.md
`,
    );
    try {
      const c: BundleComponent = { id: "b", adapter: adapterId, root, writable: true };
      const context = buildFileContext(root, templatePath);
      expect(adapter.recognize(c, context)).toMatchObject({ type: "workflow" });

      const drained = drainDirDocuments(adapter, c, [context]);
      expect(drained.entries).toHaveLength(1);
      expect(drained.warnings).toHaveLength(0);
      expect(drained.hashByFile.has(templatePath)).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
