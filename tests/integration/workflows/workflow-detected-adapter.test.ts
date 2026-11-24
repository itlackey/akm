// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * A workflow bundle whose adapter is detected from its root, not recorded in config, runs as it did before the adapter
 * refactor: the loader reads the bundle's adapter the way every other command does, never assuming `akm`.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { resetConfigCache } from "../../../src/core/config/config";
import { loadWorkflowAsset } from "../../../src/workflows/runtime/workflow-asset-loader";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "../../_helpers/sandbox";

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
});

afterEach(() => storage.cleanup());

test("a detected akm-workflow bundle (no adapter in config) loads its workflow", async () => {
  const root = path.join(storage.root, "wf-detected");
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(
    path.join(root, "deploy.md"),
    `---
type: workflow
description: deploy
steps:
  - id: execute
    unit:
      exec:
        command: ["sh", "-c", "true"]
---

## execute

Execute.
`,
  );
  writeSandboxConfig({
    semanticSearchMode: "off",
    defaultBundle: "wf",
    bundles: { wf: { path: root, writable: true } },
  });
  resetConfigCache();
  await expect(loadWorkflowAsset("wf//deploy")).resolves.toMatchObject({ ref: "wf//deploy" });
});
