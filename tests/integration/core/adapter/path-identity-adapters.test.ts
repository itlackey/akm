// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** Identity by path for the `website-snapshot` and `akm-workflow` adapters: no frontmatter or tag gates a page or a workflow. */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { akmWorkflowAdapter } from "../../../../src/core/adapter/adapters/akm-workflow-adapter";
import { websiteSnapshotAdapter } from "../../../../src/core/adapter/adapters/website-snapshot-adapter";
import type { Bundle } from "../../../../src/core/adapter/types";
import { buildFileContext } from "../../../../src/indexer/walk/file-context";

const BUNDLE_ID = "sample";
const ctx = {
  readFile: async () => null,
  list: async () => [],
  resolveRef: async () => ({ exists: false }),
};

describe("website-snapshot adapter — every page under stash/knowledge/ is a page, by its path", () => {
  test("a Markdown page with no sourceUrl and no website tag is a website page too", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "akm-website-"));
    try {
      const file = path.join(root, "stash", "knowledge", "example-com", "plain.md");
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, "---\ntitle: Plain\n---\n\nNo provenance.\n");
      const doc = websiteSnapshotAdapter.recognize({ id: BUNDLE_ID, root }, buildFileContext(root, file));
      expect(doc).toMatchObject({ type: "website", conceptId: "example-com/plain", name: "Plain" });
      expect(websiteSnapshotAdapter.list({ id: BUNDLE_ID, root }).assets.map((asset) => asset.conceptId)).toEqual([
        "example-com/plain",
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("akm-workflow adapter — every Markdown file but a README is a workflow, by its path", () => {
  test("a file whose frontmatter says another type is still a workflow; validate reports the type", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "akm-workflow-"));
    try {
      const file = path.join(root, "doc.md");
      const raw = "---\ntype: knowledge\ndescription: A doc\n---\n\nBody.\n";
      fs.writeFileSync(file, raw);
      const b: Bundle = { id: BUNDLE_ID, root };

      expect(akmWorkflowAdapter.recognize(b, buildFileContext(root, file))).toMatchObject({
        type: "workflow",
        conceptId: "doc",
      });
      expect(akmWorkflowAdapter.list(b).assets.map((asset) => asset.conceptId)).toEqual(["doc"]);
      const diagnostics = await akmWorkflowAdapter.validateChanges(
        b,
        [{ path: "doc.md", op: "update", after: raw }],
        ctx,
      );
      expect(diagnostics.filter((d) => d.issue === "type-from-content")).toEqual([
        expect.objectContaining({ file: "doc.md", detail: expect.stringContaining('type "knowledge"') }),
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
