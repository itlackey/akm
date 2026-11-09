// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** What the one scheduler entry may be bound to: a stable install, not a copy that moves when its host does. */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { resolveAkmInvocation } from "../src/tasks/resolve-akm-bin";
import { makeSandboxDir, type SandboxedDir } from "./_helpers/sandbox";

let root: SandboxedDir;

/** `<dir>/dist/chunks/x.js` beside `<dir>/dist/cli.js`, under `<base>`. */
function layout(base: string): string {
  const dist = path.join(base, "dist");
  fs.mkdirSync(path.join(dist, "chunks"), { recursive: true });
  fs.writeFileSync(path.join(dist, "cli.js"), "");
  return pathToFileURL(path.join(dist, "chunks", "x.js")).href;
}

beforeEach(() => {
  root = makeSandboxDir("akm-resolve-bin");
});
afterEach(() => root.cleanup());

describe("resolveAkmInvocation", () => {
  const common = {
    env: {},
    runtime: "bun" as const,
    execPath: "/usr/bin/bun",
    mainPath: "/nowhere/cli.js",
    electron: false,
  };

  test("a CLI carried in another package's node_modules is package-local, not a checkout", () => {
    const url = layout(path.join(root.dir, "plugin", "0.10.1", "node_modules", "akm-cli"));
    expect(resolveAkmInvocation({ ...common, cliEntryUrl: url }).via).toBe("package-local");
  });

  test("a source tree outside node_modules is still a checkout", () => {
    const url = layout(path.join(root.dir, "work", "akm"));
    expect(resolveAkmInvocation({ ...common, cliEntryUrl: url }).via).toBe("checkout");
  });

  test("Electron's binary, which opens a window unless told otherwise, is never a launcher", () => {
    const url = layout(path.join(root.dir, "work", "akm"));
    expect(resolveAkmInvocation({ ...common, cliEntryUrl: url, electron: true }).via).toBe("package-local");
  });
});
