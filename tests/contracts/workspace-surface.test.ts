// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm-cli/workspace` is a small set of existing operations for a trusted local host (see
 * docs/reference/api.md). This pins its runtime export list and that the hand-written
 * `dist/workspace.d.ts` source stays assignable to what `src/workspace.ts` really exports.
 */

import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type * as Declared from "../../scripts/node-runtime/workspace";
import * as workspace from "../../src/workspace";

const ROOT = path.resolve(import.meta.dir, "..", "..");

// Compile-time (`bunx tsc --noEmit` is the gate): every real export satisfies its declaration. The one
// opaque type, the write target, is declared as the subset a host reads, so `withEnvSecretWrite`
// (which takes it back) can only be checked the other way: the declared function is usable as the real one.
const sourceAsDeclared: Omit<typeof Declared, "withEnvSecretWrite"> = {} as Omit<
  typeof workspace,
  "withEnvSecretWrite"
>;
const declaredWrite: typeof workspace.withEnvSecretWrite = {} as typeof Declared.withEnvSecretWrite;
const actions: Declared.WorkspaceAction = {} as workspace.WorkspaceAction;
const routes: Declared.WriteRoute = {} as workspace.WriteRoute;
const sourceActions: workspace.WorkspaceAction = {} as Declared.WorkspaceAction;
const sourceRoutes: workspace.WriteRoute = {} as Declared.WriteRoute;
const clone: Declared.CloneResponse = {} as workspace.CloneResponse;
const options: workspace.CloneOptions = {} as Declared.CloneOptions;
void [sourceAsDeclared, declaredWrite, actions, routes, sourceActions, sourceRoutes, clone, options];

test("workspace exports exactly what a local host uses", () => {
  expect(Object.keys(workspace).sort()).toEqual([
    "AkmError",
    "NO_SUCH_ROUTE",
    "UsageError",
    "akmClone",
    "classifyWorkspaceError",
    "deriveCanonicalAssetName",
    "handleApiRequest",
    "handleWorkspaceAction",
    "handleWriteRequest",
    "indexWrittenAssets",
    "matchWorkspaceAction",
    "matchWriteRoute",
    "removeEnv",
    "removeSecret",
    "resolveEnvPath",
    "resolveEnvWriteTarget",
    "resolveSecretPath",
    "resolveSecretWriteTarget",
    "scrubUrlCredentials",
    "sensitiveMarkerPath",
    "setSecret",
    "withEnvSecretWrite",
    "writeEnv",
  ]);
});

test("the shipped declarations list every runtime export, the Node entry re-exports them, and nothing more", () => {
  const declared = fs.readFileSync(path.join(ROOT, "scripts", "node-runtime", "workspace.d.ts"), "utf8");
  const names = [...declared.matchAll(/^export (?:abstract )?(?:function|class|const) (\w+)/gm)].map((m) => m[1]);
  expect(names.sort()).toEqual(Object.keys(workspace).sort());
  const node = fs.readFileSync(path.join(ROOT, "scripts", "node-runtime", "workspace-node.mjs"), "utf8");
  const reexported = /^export \{([^}]*)\};/m
    .exec(node)?.[1]
    ?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  expect(reexported?.sort()).toEqual(Object.keys(workspace).sort());
});
