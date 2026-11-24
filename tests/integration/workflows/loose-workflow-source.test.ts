// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * A loose `.md` outside `workflows/` that says `type: workflow` is no workflow source in an akm bundle: it is not
 * run, and `akm lint` does not lint it as one (as before the adapter refactor).
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { resetConfigCache } from "../../../src/core/config/config";
import { _resetWarnOnceForTests } from "../../../src/core/warn";
import { loadWorkflowAsset } from "../../../src/workflows/runtime/workflow-asset-loader";
import { runCliCapture } from "../../_helpers/cli";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "../../_helpers/sandbox";

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  writeSandboxConfig({
    semanticSearchMode: "off",
    defaultBundle: "main",
    bundles: { main: { path: storage.stashDir, writable: true, adapter: "akm" } },
  });
  resetConfigCache();
});

afterEach(() => storage.cleanup());

const FLOW = "---\ntype: workflow\nsteps:\n  - id: a\n---\n\n## a\n\nDo it.\n";

function write(relativePath: string, content: string): void {
  const file = path.join(storage.stashDir, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

test("a loose workflow is refused when run, and a workflow in workflows/ still loads", async () => {
  write("notes/loose-flow.md", FLOW);
  write("workflows/real.md", FLOW);
  await expect(loadWorkflowAsset("main//notes/loose-flow")).rejects.toThrow(
    'Bundle "main" uses adapter "akm", which does not support native workflow execution.',
  );
  expect((await loadWorkflowAsset("main//workflows/real")).ref).toBe("main//workflows/real");
});

test("akm lint does not report a loose workflow", async () => {
  write("notes/loose-flow.md", FLOW);
  const result = await runCliCapture(["lint", "--format", "json"]);
  expect(result.stdout).not.toContain("loose-flow");
});

test("a workflow symlinked to a file of another extension is warned about by show and by index", async () => {
  write("workflows/target.txt", FLOW);
  fs.symlinkSync("target.txt", path.join(storage.stashDir, "workflows", "linked.md"));
  const warning = "resolves through a symlink to workflows/target.txt with a different extension";
  const shown = await runCliCapture(["show", "workflows/linked"]);
  expect(shown.stderr).toContain(warning);
  _resetWarnOnceForTests();
  const indexed = await runCliCapture(["index", "--full"]);
  expect(indexed.stderr + indexed.stdout).toContain(warning);
});
