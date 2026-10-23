// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * A script asset that is a symlink keeps the interpreter its authored name
 * selects: `scripts/deploy.sh` linked to `real-script.txt` (or to a file with
 * no extension) runs under the shell, in the same bundle and across bundles.
 */

import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { AkmConfig } from "../../src/core/config/config";
import { resolveAssetPath } from "../../src/sources/resolve";
import { prepareTaskV3Execution } from "../../src/tasks/prepare/prepare";
import { resolveBundleAsset } from "../../src/tasks/run/load-task";
import { parseTaskSource } from "../../src/tasks/source/parse-task-source";
import { projectTaskSourceV4 } from "../../src/tasks/source/project-v4";
import { makeSandboxDir, type SandboxedDir } from "../_helpers/sandbox";

const sandboxes: SandboxedDir[] = [];
afterEach(() => {
  for (const sandbox of sandboxes.splice(0).reverse()) sandbox.cleanup();
});

function sandbox(prefix: string): string {
  const made = makeSandboxDir(prefix);
  sandboxes.push(made);
  return made.dir;
}

/** A bundle whose `scripts/deploy.sh` links to `targetName` outside the bundle. */
function bundleWithLinkedScript(targetName: string): string {
  const bundle = sandbox("akm-script-ext-bundle");
  const outside = sandbox("akm-script-ext-outside");
  fs.writeFileSync(path.join(outside, targetName), "echo deployed\n");
  fs.mkdirSync(path.join(bundle, "scripts"), { recursive: true });
  fs.symlinkSync(path.join(outside, targetName), path.join(bundle, "scripts", "deploy.sh"));
  return bundle;
}

function task(uses: string, root: string) {
  const parsed = parseTaskSource({
    yaml: `version: 4\nuses: ${uses}\nschedule: '@daily'\n`,
    filePath: `${root}/tasks/nightly.yml`,
  });
  return projectTaskSourceV4(parsed.v4);
}

describe("a symlinked script keeps its authored interpreter", () => {
  for (const targetName of ["real-script.txt", "real-script"]) {
    test(`same bundle: scripts/deploy.sh -> ${targetName}`, async () => {
      const bundle = bundleWithLinkedScript(targetName);
      const config = { configVersion: "0.9.0", semanticSearchMode: "off" } as AkmConfig;
      const prepared = await prepareTaskV3Execution(task("work//scripts/deploy.sh", bundle), {
        taskId: "nightly",
        taskRef: "work//tasks/nightly",
        bundleName: "work",
        bundleRoot: bundle,
        config,
        resolveAsset: async ({ type, name }) => ({
          file: await resolveAssetPath(bundle, type, name),
          bundleRoot: bundle,
        }),
      });
      expect(prepared).toMatchObject({ kind: "script", interpreter: "sh", extension: ".sh" });
    });

    test(`cross bundle: shared//scripts/deploy.sh -> ${targetName}`, async () => {
      const work = sandbox("akm-script-ext-work");
      const shared = bundleWithLinkedScript(targetName);
      const config = {
        configVersion: "0.9.0",
        semanticSearchMode: "off",
        defaultBundle: "work",
        bundles: { work: { path: work }, shared: { path: shared, writable: false } },
      } as unknown as AkmConfig;
      const prepared = await prepareTaskV3Execution(task("shared//scripts/deploy.sh", work), {
        taskId: "nightly",
        taskRef: "work//tasks/nightly",
        bundleName: "work",
        bundleRoot: work,
        config,
        resolveAsset: async ({ bundle, type, name }) => resolveBundleAsset(config, { bundle, type, name }),
      });
      expect(prepared).toMatchObject({ kind: "script", interpreter: "sh", extension: ".sh" });
      expect(Buffer.from((prepared as { bytesBase64: string }).bytesBase64, "base64").toString()).toBe(
        "echo deployed\n",
      );
    });
  }
});
