// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The `scheduler` step of `akm migrate apply` against a real `crontab` lookup on PATH, in a child process whose only
 * location is HOME (an installation that moves a location never writes the OS scheduler). An image without a
 * `crontab` binary must still exit 0 so a `set -e` entrypoint boots; a `crontab` that exists and fails must block.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "../..");
let home: string;
let bin: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "akm-migrate-sched-"));
  bin = path.join(home, "bin");
  fs.mkdirSync(bin);
  // The content-ref step walks bundles with git, which an image that ships akm has.
  const git = Bun.which("git");
  if (git) fs.symlinkSync(git, path.join(bin, "git"));
  const stash = path.join(home, "stash");
  fs.mkdirSync(stash);
  const configDir = path.join(home, ".config", "akm");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, "config.json"),
    JSON.stringify({
      semanticSearchMode: "off",
      defaultBundle: "stash",
      bundles: { stash: { path: stash, writable: true } },
      scheduler: { enabled: ["stash//tasks/a"] },
    }),
  );
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

function apply() {
  const result = spawnSync(process.execPath, [path.join(repoRoot, "scripts/akm-migrate.ts"), "apply"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { PATH: bin, HOME: home },
  });
  return {
    status: result.status,
    plan: JSON.parse(result.stdout) as { status: string; blockers: string[]; scheduler: { warnings: string[] } },
    stderr: result.stderr,
  };
}

test("apply with no crontab binary warns in the plan and exits 0", () => {
  const { status, plan, stderr } = apply();

  expect(stderr).toBe("");
  expect(plan.blockers).toEqual([]);
  expect(plan.status).not.toBe("blocked");
  expect(plan.scheduler.warnings.join(" ")).toContain("crontab");
  expect(status).toBe(0);
});

test("apply with a crontab that exists and fails blocks", () => {
  const stub = path.join(bin, "crontab");
  fs.writeFileSync(stub, "#!/bin/sh\necho 'crontab: permission denied' >&2\nexit 1\n");
  fs.chmodSync(stub, 0o755);

  const { status, plan } = apply();

  expect(plan.status).toBe("blocked");
  expect(plan.blockers.join(" ")).toContain("crontab");
  expect(status).toBe(1);
});
