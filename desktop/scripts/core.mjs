// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const destination = path.join(root, "desktop", ".core");
const packed = await mkdtemp(path.join(tmpdir(), "akm-desktop-core-"));
execFileSync("bun", ["run", "build"], { cwd: root, stdio: "inherit" });
execFileSync("bun", ["pm", "pack", "--filename", path.join(packed, "core.tgz")], {
  cwd: root,
  stdio: ["ignore", "ignore", "inherit"],
});
// This directory contains generated package contents only; never mix versions.
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
execFileSync("tar", ["-xf", path.join(packed, "core.tgz"), "-C", destination, "--strip-components=1"], {
  stdio: "inherit",
});
const manifest = JSON.parse(await readFile(path.join(destination, "package.json"), "utf8"));
await rm(packed, { recursive: true, force: true });
console.log(`Desktop core: akm-cli@${manifest.version} built from this checkout.`);
