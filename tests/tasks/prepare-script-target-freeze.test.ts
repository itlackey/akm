// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Ported from the deleted `tests/tasks-runtime-v3.test.ts` (removed by this
 * stabilization PR; see `origin/release/0.9.2:tests/tasks-runtime-v3.test.ts`
 * ~line 142 and ~line 225). That file held the ONLY coverage for two
 * invariants of a task's frozen script/run-target snapshot:
 *
 *  1. a `uses: scripts/<file>` target freezes a byte-exact sha256/bytesBase64
 *     snapshot of the script's source bytes and carries NO live resumable
 *     file path — only the immutable bytes/hash travel forward;
 *  2. a `run:` target's `working-directory:` joins the bundle root: the task
 *     carries a plain path, not a directory identity (the second invariant of
 *     the original suite, a physical-path canonicalization, went with the
 *     identity).
 *
 * The first invariant still holds at HEAD — the logic moved body-intact into
 * `src/tasks/prepare/script-capture.ts` (`captureScriptTarget`) behind
 * `src/tasks/prepare/prepare.ts`'s `prepareTaskV3Execution` entry point. This
 * file ports the invariants only — never the retired v3 document grammar
 * the original suite spoke — expressed against task source v4 (`version: 4`),
 * exercised through the CURRENT `prepare/prepare.ts` entry point:
 * `tests/tasks/prepare-split.test.ts` drives that same entry for its own
 * caller-shape-parity concern but explicitly defers `prepareTaskV3Execution`'s
 * PER-KIND behavior — this file, and specifically these invariants — to
 * "elsewhere" (that file's own header comment).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { makeBundleRef } from "../../src/core/asset/asset-ref";
import type { AkmConfig } from "../../src/core/config/config-types";
import { prepareTaskV3Execution } from "../../src/tasks/prepare/prepare";
import type { PrepareTaskV3ExecutionContext } from "../../src/tasks/prepare/prepared-execution";
import { parseTaskSource } from "../../src/tasks/source/parse-task-source";
import { projectTaskSourceV4 } from "../../src/tasks/source/project-v4";
import { makeSandboxDir, type SandboxedDir } from "../_helpers/sandbox";

/** No `config.engines`/`defaults` needed — neither the script nor the shell arm reads them. */
const config: AkmConfig = { configVersion: "0.9.0", semanticSearchMode: "off" };

const sandboxes: SandboxedDir[] = [];
afterEach(() => {
  for (const sandbox of sandboxes.splice(0).reverse()) sandbox.cleanup();
});

/** A real, empty directory to stand in for the bundle root. */
function sandboxRoot(): string {
  const made = makeSandboxDir("akm-prepare-script-freeze");
  sandboxes.push(made);
  return made.dir;
}

function contextFor(root: string): PrepareTaskV3ExecutionContext {
  const bundleName = "bundle";
  return {
    taskId: "nightly",
    taskRef: makeBundleRef(bundleName, "tasks/nightly"),
    bundleName,
    bundleRoot: root,
    config,
  };
}

describe("prepareTaskV3Execution's frozen script/run-target snapshot (ported from the deleted tests/tasks-runtime-v3.test.ts)", () => {
  test("a uses: scripts/<file> target freezes byte-exact sha256/bytesBase64 and carries no live resumable file path", async () => {
    const root = sandboxRoot();
    fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
    const scriptPath = path.join(root, "scripts", "nightly.sh");
    const bytes = Buffer.from("#!/bin/sh\nprintf frozen\n", "utf8");
    fs.writeFileSync(scriptPath, bytes);

    const parsed = parseTaskSource({
      yaml: "version: 4\nuses: scripts/nightly.sh\nschedule: '@daily'\n",
      filePath: path.join(root, "tasks", "nightly.yml"),
      workspaceRoot: root,
    });
    const document = projectTaskSourceV4(parsed.v4);

    const prepared = await prepareTaskV3Execution(document, contextFor(root));

    expect(prepared.kind).toBe("script");
    if (prepared.kind !== "script") return;
    expect(prepared.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(Buffer.from(prepared.bytesBase64, "base64")).toEqual(bytes);
    // No live resumable file path: only the immutable bytes/hash snapshot
    // travels forward — never a path back to the source file on disk (a
    // resumed run must not depend on that file still existing/unchanged).
    expect("path" in prepared).toBe(false);
    expect("file" in prepared).toBe(false);
  });

  test.skipIf(process.platform === "win32")(
    "a uses: scripts/<file> target that is a symlink to a file outside the bundle freezes the target's bytes",
    async () => {
      const root = sandboxRoot();
      const outside = sandboxRoot();
      fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
      const bytes = Buffer.from("#!/bin/sh\nprintf from-elsewhere\n", "utf8");
      fs.writeFileSync(path.join(outside, "shared.sh"), bytes);
      fs.symlinkSync(path.join(outside, "shared.sh"), path.join(root, "scripts", "nightly.sh"));

      const parsed = parseTaskSource({
        yaml: "version: 4\nuses: scripts/nightly.sh\nschedule: '@daily'\n",
        filePath: path.join(root, "tasks", "nightly.yml"),
        workspaceRoot: root,
      });
      const prepared = await prepareTaskV3Execution(projectTaskSourceV4(parsed.v4), contextFor(root));

      expect(prepared.kind).toBe("script");
      if (prepared.kind !== "script") return;
      expect(Buffer.from(prepared.bytesBase64, "base64")).toEqual(bytes);
      expect(prepared.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    },
  );

  test("a run: target's working-directory: joins the bundle root, and a plain run: task works from it", async () => {
    const root = sandboxRoot();
    fs.mkdirSync(path.join(root, "work"));

    const parsed = parseTaskSource({
      yaml: "version: 4\nrun: printf ok\nworking-directory: work\nschedule: '@daily'\n",
      filePath: path.join(root, "tasks", "nightly.yml"),
      workspaceRoot: root,
    });
    const prepared = await prepareTaskV3Execution(projectTaskSourceV4(parsed.v4), contextFor(root));

    expect(prepared.kind).toBe("shell");
    if (prepared.kind !== "shell") return;
    expect(prepared.cwd).toBe(path.join(root, "work"));
    expect(Object.hasOwn(prepared, "cwdIdentity")).toBe(false);
  });
});
