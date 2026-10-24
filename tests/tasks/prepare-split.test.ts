// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Contract for `src/tasks/prepare/**`'s three-caller shape parity (spec
 * docs/plans/specs/p1b-model-extraction.md §4, Lane B / D4 module map).
 *
 * `prepareTaskV3Execution` moved body-intact to `src/tasks/prepare/prepare.ts`
 * at the P1b split, behind a `src/tasks/runtime-v3.ts` compat shim kept only
 * so production callers did not all need rewiring in the same change-set.
 * P4 (docs/plans/specs/p4-deletions-closeout.md §3.2.7, row B-25, F-A2.15)
 * DELETED that shim once every caller was rewired to import `prepare/prepare`
 * directly — today's three callers are `src/tasks/run/load-task.ts`,
 * `src/tasks/scheduler-sync.ts`, and `src/workflows/freeze/targets/task.ts`
 * (`resolveTaskForComposition`/`taskDispatch`; `src/workflows/ir/source-freeze-v4.ts`,
 * the file this comment used to cite, is itself a P4-deleted shim, row B-27).
 *
 * This file pins that each caller's EXACT context shape — as literally
 * constructed at its call site today — produces the expected
 * `PreparedTaskV3Execution` once routed through `prepare/prepare`'s entry
 * point. The context objects are typed against `PrepareTaskV3ExecutionContext`
 * (a real, tsc-checked type — not a hand-rolled guess), and
 * `prepareTaskV3Execution` is typed as `typeof prepareTaskV3Execution` from
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
 * move and the P4 shim deletion unchanged — from `prepareTaskV3Execution`'s
 * per-kind behavior, which is already characterized elsewhere (the P0/P1a
 * suites and this phase's Lane A/C tests). Each stub below throws if invoked,
 * so an accidental call is itself a loud test failure.
 *
 * STRUCTURAL RATCHET: the three caller-shape tests above pin BEHAVIOR only.
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
import { prepareTaskV3Execution } from "../../src/tasks/prepare/prepare";
import type { PrepareTaskV3ExecutionContext } from "../../src/tasks/prepare/prepared-execution";
import { parseTaskSource } from "../../src/tasks/source/parse-task-source";
import { projectTaskSourceV4 } from "../../src/tasks/source/project-v4";
import { makeSandboxDir, type SandboxedDir } from "../_helpers/sandbox";

const ROOT = path.resolve(import.meta.dir, "../..");
const RUNTIME_V3_FILE = path.join(ROOT, "src/tasks/runtime-v3.ts");

/** No `config.engines`/`defaults` needed — the shell/`run:` arm never reads them. */
const config: AkmConfig = { configVersion: "0.9.0", semanticSearchMode: "off" };

const sandboxes: SandboxedDir[] = [];
afterEach(() => {
  for (const sandbox of sandboxes.splice(0).reverse()) sandbox.cleanup();
});

/** A real, empty directory — `bundleRoot` must physically exist for directory-identity capture. */
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
    workspaceRoot: root,
  });
  return projectTaskSourceV4(parsed.v4);
}

describe("prepare/prepare.ts's entry — three-caller shape parity (P1b spec §4.1/§4.2, D4; P4 shim deletion)", () => {
  test("run/load-task.ts's context shape — bundleName/bundleRoot/config + resolveAsset({bundle,type,name}) + conditional schedulerContext", async () => {
    const root = sandboxRoot();
    const document = shellDocument(root);
    const bundleName = "bundle";
    const context: PrepareTaskV3ExecutionContext = {
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

    const prepared = await prepareTaskV3Execution(document, context);
    expect(prepared).toMatchObject({ kind: "shell", command: "printf ok" });
  });

  test("scheduler-sync.ts's context shape — readFile + commandSourceLoader, no resolveAsset in the common case", async () => {
    const root = sandboxRoot();
    const document = shellDocument(root);
    const bundleName = "bundle";
    const context: PrepareTaskV3ExecutionContext = {
      taskId: "nightly",
      taskRef: makeBundleRef(bundleName, "tasks/nightly"),
      bundleName,
      bundleRoot: root,
      config,
      // scheduler-sync.ts's readFile/commandSourceLoader. Neither is invoked
      // for a run: task — a call here is itself a failure.
      readFile: (file, bundleRootArg) => {
        throw new Error(`unexpected readFile(${file}, ${bundleRootArg}) while preparing a run: task`);
      },
      commandSourceLoader: (ref, kind) => {
        throw new Error(`unexpected commandSourceLoader(${ref}, ${kind}) while preparing a run: task`);
      },
    };

    const prepared = await prepareTaskV3Execution(document, context);
    expect(prepared).toMatchObject({ kind: "shell", command: "printf ok" });
  });

  test("workflows/freeze/targets/task.ts's context shape — commandSourceLoader + resolveAsset({ref,type}) + a defaulted readFile", async () => {
    const root = sandboxRoot();
    const document = shellDocument(root);
    const bundleName = "bundle";
    const context: PrepareTaskV3ExecutionContext = {
      taskId: "nightly",
      taskRef: makeBundleRef(bundleName, "tasks/nightly"),
      bundleName,
      bundleRoot: root,
      config,
      commandSourceLoader: (ref, kind) => {
        throw new Error(`unexpected commandSourceLoader(${ref}, ${kind}) while preparing a run: task`);
      },
      // taskDispatch's resolveAsset destructures {ref, type} (ignoring
      // bundle/name) and always returns the {file, bundleRoot} object form,
      // never the bare-string form of the union return type.
      resolveAsset: async ({ ref, type }) => {
        throw new Error(`unexpected resolveAsset(${ref}, ${type}) while preparing a run: task`);
      },
      // taskDispatch's readFile defaults its second parameter to owned.root
      // via a default parameter, not `??`.
      readFile: (file, bundleRootArg = root) => {
        throw new Error(`unexpected readFile(${file}, ${bundleRootArg}) while preparing a run: task`);
      },
    };

    const prepared = await prepareTaskV3Execution(document, context);
    expect(prepared).toMatchObject({ kind: "shell", command: "printf ok" });
  });
});

describe("src/tasks/runtime-v3.ts — the deleted compat shim (spec §9, P4 §3.2.7 row B-25)", () => {
  test("does not exist — every caller is rewired to prepare/prepare.ts directly", () => {
    expect(fs.existsSync(RUNTIME_V3_FILE)).toBe(false);
  });
});
