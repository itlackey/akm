// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Contract for `src/tasks/prepare/**`'s three-caller shape parity (spec
 * a retired design doc §4, Lane B / D4 module map).
 *
 * `prepareTaskExecution` moved body-intact to `src/tasks/prepare/prepare.ts`
 * at the P1b split, behind a `src/tasks/runtime-v3.ts` compat shim kept only
 * so production callers did not all need rewiring in the same change-set.
 * P4 (a retired design doc §3.2.7, row B-25, F-A2.15)
 * DELETED that shim once every caller was rewired to import `prepare/prepare`
 * directly. Its callers are `src/tasks/run/load-task.ts` and
 * `src/commands/tasks/tasks.ts` (`task explain`).
 *
 * This file pins that `load-task.ts`'s EXACT context shape — as literally
 * constructed at its call site today — produces the expected
 * `PreparedTaskExecution` once routed through `prepare/prepare`'s entry
 * point. The context objects are typed against `PrepareTaskExecutionContext`
 * (a real, tsc-checked type — not a hand-rolled guess), and
 * `prepareTaskExecution` is typed as `typeof prepareTaskExecution` from
 * that same live import — so a caller-shaped context literal that does not
 * structurally satisfy the real parameter type fails `tsc`, not merely a
 * runtime assertion. This is the "type-level usage" proof: if the entry's
 * signature drifts from today's, every test below stops compiling before it
 * ever runs.
 *
 * Every fixture below is a bare `run:` (shell) task source v4 document: it
 * needs no `config.engines`, no stored command/workflow/script asset, and —
 * critically — never invokes `resolveAsset`/`readFile`/`commandSourceLoader`
 * (those branches belong to the command/workflow/script arms). That isolates
 * this file's one concern — did each caller's context shape survive the P1b
 * move and the P4 shim deletion unchanged — from `prepareTaskExecution`'s
 * per-kind behavior, which is already characterized elsewhere (the P0/P1a
 * suites and this phase's Lane A/C tests). Each stub below throws if invoked,
 * so an accidental call is itself a loud test failure.
 *
 * STRUCTURAL RATCHET: the caller-shape test above pins BEHAVIOR only.
 * They say nothing about whether `src/tasks/runtime-v3.ts` still exists as a
 * second copy of this logic for some caller to have been missed rewiring off
 * of. The check below closes that gap — mirrors
 * tests/tasks/run-split.test.ts's analogous "the deleted shim does not
 * exist" check for src/tasks/runner.ts (P4 F-A2.16).
 */

import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { makeBundleRef } from "../../src/core/asset/asset-ref";
import type { AkmConfig } from "../../src/core/config/config-types";
import { prepareTaskExecution } from "../../src/tasks/prepare/prepare";
import type { PrepareTaskExecutionContext } from "../../src/tasks/prepare/prepared-execution";
import { parseTaskSource } from "../../src/tasks/source/parse-task-source";
import { projectTaskSourceV4 } from "../../src/tasks/source/project-v4";
import { makeSandboxDir, type SandboxedDir } from "../_helpers/sandbox";

const ROOT = path.resolve(import.meta.dir, "../..");
const RUNTIME_V3_FILE = path.join(ROOT, "src/tasks/runtime-v3.ts");

/** No `config.engines`/`defaults` needed — the shell/`run:` arm never reads them. */
const config: AkmConfig = { semanticSearchMode: "off" };

const sandboxes: SandboxedDir[] = [];
afterEach(() => {
  for (const sandbox of sandboxes.splice(0).reverse()) sandbox.cleanup();
});

/** A real, empty directory to stand in for the bundle root. */
function sandboxRoot(): string {
  const made = makeSandboxDir("akm-prepare-split");
  sandboxes.push(made);
  return made.dir;
}

/** The minimal valid task source v4 shell document every shape mirror below shares. */
function shellDocument(root: string) {
  const parsed = parseTaskSource({
    yaml: "version: 4\nrun: printf ok\nschedule: '@daily'\n",
    filePath: `${root}/tasks/nightly.yml`,
  });
  return projectTaskSourceV4(parsed.v4);
}

describe("prepare/prepare.ts's entry — caller shape parity (P1b spec §4.1/§4.2, D4; P4 shim deletion)", () => {
  test("run/load-task.ts's context shape — bundleName/bundleRoot/config + resolveAsset({bundle,type,name})", async () => {
    const root = sandboxRoot();
    const document = shellDocument(root);
    const bundleName = "bundle";
    const context: PrepareTaskExecutionContext = {
      taskId: "nightly",
      taskRef: makeBundleRef(bundleName, "tasks/nightly"),
      bundleName,
      bundleRoot: root,
      config,
      // load-task.ts's resolveAsset destructures {bundle, type, name}. Never
      // invoked for a run: task — a call here is itself a failure.
      resolveAsset: async ({ bundle, type, name }) => {
        throw new Error(`unexpected resolveAsset(${bundle}, ${type}, ${name}) while preparing a run: task`);
      },
    };

    const prepared = await prepareTaskExecution(document, context);
    expect(prepared).toMatchObject({ kind: "shell", command: "printf ok" });
  });
});

describe("src/tasks/runtime-v3.ts — the deleted compat shim (spec §9, P4 §3.2.7 row B-25)", () => {
  test("does not exist — every caller is rewired to prepare/prepare.ts directly", () => {
    expect(fs.existsSync(RUNTIME_V3_FILE)).toBe(false);
  });
});
