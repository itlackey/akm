// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Without arguments: pack this checkout, for development and CI. With `--tarball <file>`: unpack the released
// akm-cli tarball, the only engine a distributable Desktop build embeds (package.mjs --release checks this).
const root = fileURLToPath(new URL("../..", import.meta.url));
const destination = path.join(root, "desktop", ".core");
const packed = await mkdtemp(path.join(tmpdir(), "akm-desktop-core-"));
const flag = process.argv.indexOf("--tarball");
const tarball = flag === -1 ? undefined : path.resolve(process.argv[flag + 1] ?? "");
if (flag !== -1 && !process.argv[flag + 1]) throw new Error("--tarball needs the path of an akm-cli .tgz file.");
const archive = tarball ?? path.join(packed, "core.tgz");
if (!tarball) {
  execFileSync("bun", ["run", "build"], { cwd: root, stdio: "inherit" });
  execFileSync("bun", ["pm", "pack", "--filename", archive], { cwd: root, stdio: ["ignore", "ignore", "inherit"] });
}
// This directory contains generated package contents only; never mix versions.
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
// Name the archive relative to its folder: GNU tar reads "C:\\..." as a remote host (Git's tar on Windows).
execFileSync("tar", ["-xf", path.basename(archive), "-C", destination, "--strip-components=1"], {
  cwd: path.dirname(archive),
  stdio: "inherit",
});
const manifest = JSON.parse(await readFile(path.join(destination, "package.json"), "utf8"));
await rm(packed, { recursive: true, force: true });
// Next to .core, not in it: the package is installed as a dependency and must stay exactly what was unpacked.
const source = tarball ? "release" : "checkout";
await writeFile(path.join(root, "desktop", ".core.json"), `${JSON.stringify({ version: manifest.version, source })}\n`);
console.log(
  `Desktop core: akm-cli@${manifest.version} from ${tarball ? `the release tarball ${tarball}` : "this checkout"}.`,
);
