// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";

const launcher = fileURLToPath(new URL("../scripts/AppRun", import.meta.url));
const posix = { skip: process.platform === "win32" && "the AppImage launcher is a POSIX shell script" };
// A stand-in Electron in a temporary AppDir: prints its arguments and exits 23, so a run shows whether it started.
let appDir;
before(async () => {
  appDir = await mkdtemp(join(tmpdir(), "akm-apprun-"));
  await writeFile(join(appDir, "akm-desktop"), '#!/bin/sh\necho "electron started"\nprintf \'%s\\n\' "$@"\nexit 23\n');
  await chmod(join(appDir, "akm-desktop"), 0o755);
});
after(() => rm(appDir, { recursive: true, force: true }));

const run = (args, env = {}) =>
  spawnSync("sh", [launcher, ...args], { env: { PATH: process.env.PATH, APPDIR: appDir, ...env }, encoding: "utf8" });

test("an ordinary launch forwards its arguments to Electron", posix, () => {
  const result = run(["--flag", "a b"]);
  assert.equal(result.status, 23, result.stderr);
  assert.equal(result.stdout, "electron started\n--flag\na b\n");
});

test("the updater's install-only run exits successfully without starting Electron", posix, () => {
  // electron-updater runs the replacement AppImage this way while the old instance is quitting.
  const result = run([], { APPIMAGE_SILENT_INSTALL: "true", APPIMAGE_EXIT_AFTER_INSTALL: "true" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
});

test("a silent run that is not install-only still launches", posix, () => {
  const result = run(["--flag"], { APPIMAGE_SILENT_INSTALL: "true" });
  assert.equal(result.status, 23, result.stderr);
  assert.equal(result.stdout, "electron started\n--flag\n");
});
