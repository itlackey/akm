// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm-cli/workspace` is a set of typed operations for a trusted local host (see docs/reference/api.md). The runtime
 * export list is the source module's own: this pins that the hand-written `dist/workspace.d.ts` and the Node entry
 * declare and re-export exactly that, that every operation namespace matches its declaration, and that no
 * primitive or dispatcher is exported.
 */

import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type * as Declared from "../../scripts/node-runtime/workspace";
import * as workspace from "../../src/workspace";

const ROOT = path.resolve(import.meta.dir, "..", "..");

// Compile-time (`bunx tsc --noEmit` is the gate): every real export satisfies its declaration, and the
// declared inputs are accepted by the real operations.
const sourceAsDeclared: typeof Declared = {} as typeof workspace;
void sourceAsDeclared;

const read = (...parts: string[]) => fs.readFileSync(path.join(ROOT, ...parts), "utf8");

test("the shipped declarations list every runtime export, the Node entry re-exports them, and nothing more", () => {
  const runtime = Object.keys(workspace).sort();
  const declared = read("scripts", "node-runtime", "workspace.d.ts");
  const names = [...declared.matchAll(/^export (?:abstract )?(?:function|class|const|namespace) (\w+)/gm)].map(
    (m) => m[1],
  );
  expect(names.sort()).toEqual(runtime);
  const node = read("scripts", "node-runtime", "workspace-node.mjs");
  const reexported = /^export \{([^}]*)\};/m
    .exec(node)?.[1]
    ?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  expect(reexported?.sort()).toEqual(runtime);
});

test("each operation namespace declares exactly the functions it exports", () => {
  const declared = read("scripts", "node-runtime", "workspace.d.ts");
  for (const [name, value] of Object.entries(workspace)) {
    if (typeof value !== "object" || value === null || value instanceof Set) continue;
    const block = new RegExp(`^export namespace ${name} \\{([\\s\\S]*?)^\\}`, "m").exec(declared)?.[1];
    expect(block, `declaration of ${name}`).toBeDefined();
    const fns = [...(block as string).matchAll(/^ {2}function (\w+)/gm)].map((m) => m[1]);
    expect(fns.sort()).toEqual(Object.keys(value).sort());
  }
});

test("the surface carries no primitive and no dispatcher", () => {
  for (const gone of [
    "handleApiRequest",
    "handleWriteRequest",
    "handleWorkspaceAction",
    "classifyWorkspaceError",
    "writeEnv",
    "withEnvSecretWrite",
    "akmClone",
  ])
    expect(Object.keys(workspace)).not.toContain(gone);
});
