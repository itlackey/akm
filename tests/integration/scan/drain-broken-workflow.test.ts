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
 * drops the entry with a `Skipped workflow …` warning, while caching the valid
 * workflow's parsed document for the `workflow_documents` side-table upsert.
 *
 * This pins the GAP directly (recognize alone does NOT drop; the drain does),
 * complementing the end-to-end coverage in
 * `tests/integration/workflows/indexer-rejection.test.ts`.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerBuiltinAdapters } from "../../../src/core/adapter/adapters";
import { akmAdapter } from "../../../src/core/adapter/adapters/akm-adapter";
import { resetAdapterRegistryForTests } from "../../../src/core/adapter/registry";
import type { BundleComponent } from "../../../src/core/adapter/types";
import { drainDirDocuments } from "../../../src/indexer/scan/drain-dir";
import { buildFileContext } from "../../../src/indexer/walk/file-context";
import { takeWorkflowDocument } from "../../../src/workflows/runtime/document-cache";

beforeAll(() => {
  resetAdapterRegistryForTests();
  registerBuiltinAdapters();
});

const VALID_WORKFLOW = `# Workflow: Ship Release

## Step: Validate
Step ID: validate

### Instructions
Confirm release notes are present.
`;

// Duplicate step ID ("first") — a parse error the workflow validator rejects.
const BROKEN_WORKFLOW = `# Workflow: Bad

## Step: First
Step ID: first
### Instructions
do A

## Step: Second
Step ID: first
### Instructions
do B
`;

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
    expect(warning!.startsWith("Skipped workflow ")).toBe(true);
    expect(warning).toContain(badPath);
    // Its concrete parse error (duplicate step id) is carried in the detail.
    expect(warning).toMatch(/already used|Step ID/);

    // The valid workflow's hash is surfaced (content_hash source), the broken
    // one's is not (it never became an entry).
    expect(drained.hashByFile.get(goodPath)).toBeDefined();
    expect(drained.hashByFile.get(badPath)).toBeUndefined();

    // The valid workflow's parsed document is cached for the persist-time
    // workflow_documents write (same side channel the live contributor used).
    const cached = takeWorkflowDocument(drained.entries[0]!);
    expect(cached).toBeDefined();
    expect(cached?.title).toBe("Ship Release");
  });
});
