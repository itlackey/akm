// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm lint` on a git bundle asks git which files a walk reaches once per check, not once per asset: one
 * `git check-ignore` per file made lint on a bundle of a few thousand files take minutes.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { akmLint } from "../../src/commands/lint/index";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../_helpers/sandbox";

let storage: IsolatedAkmStorage;
const originalPath = process.env.PATH;
afterEach(() => {
  process.env.PATH = originalPath;
  storage?.cleanup();
});

const ASSETS = 40;

describe("akm lint on a git bundle", () => {
  // The counting `git` is a shell script.
  test.skipIf(process.platform === "win32")(
    `checks ${ASSETS} assets without a git check-ignore per asset`,
    async () => {
      storage = withIsolatedAkmStorage();
      for (let i = 0; i < ASSETS; i++) {
        const full = path.join(storage.stashDir, "knowledge", `doc-${i}.md`);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, `---\ndescription: doc ${i}\n---\n# Doc ${i}\n`, "utf8");
      }
      expect(spawnSync("git", ["init", "-q"], { cwd: storage.stashDir }).status).toBe(0);

      // A `git` first on PATH that logs its subcommand and runs the real one.
      const realGit = Bun.which("git");
      const shimDir = fs.mkdtempSync(path.join(path.dirname(storage.stashDir), "git-shim-"));
      const log = path.join(shimDir, "calls.log");
      fs.writeFileSync(path.join(shimDir, "git"), `#!/bin/sh\necho "$1" >> "${log}"\nexec "${realGit}" "$@"\n`, {
        mode: 0o755,
      });
      process.env.PATH = `${shimDir}${path.delimiter}${originalPath}`;

      const result = await akmLint({ dir: storage.stashDir });
      expect(result.flagged.filter((issue) => issue.issue === "missing-updated")).toHaveLength(ASSETS);

      const checkIgnores = fs
        .readFileSync(log, "utf8")
        .split("\n")
        .filter((subcommand) => subcommand === "check-ignore");
      expect(checkIgnores.length).toBeLessThan(ASSETS);
    },
  );
});
