// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Stages the web process alone as an npm package for servers and containers: the built app, `server/`, and a
// manifest that depends on the released `akm-cli`. No Electron. `--release` refuses a dirty tree or an engine that
// is not the released tarball (release-guard.mjs); then `npm publish` the printed directory.
import { execFileSync } from "node:child_process";
import { chmod, cp, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { releaseRefusal } from "./release-guard.mjs";

/** The published package name; the one place to change it. */
const PACKAGE_NAME = "@itlackey/akm-ui";

const root = fileURLToPath(new URL("..", import.meta.url));
const release = process.argv.includes("--release");
const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const core = JSON.parse(await readFile(path.join(root, ".core.json"), "utf8").catch(() => "null"));
const version = JSON.parse(await readFile(path.join(root, ".core/package.json"), "utf8")).version;
const commit = execFileSync("git", ["rev-parse", "--short=12", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const dirty = Boolean(execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim());
if (release) {
  const refusal = releaseRefusal({ dirty, core });
  if (refusal) throw new Error(refusal);
}
const stage = await mkdtemp(path.join(os.tmpdir(), "akm-ui-package-"));
await cp(path.join(root, "build"), path.join(stage, "build"), { recursive: true });
await cp(path.join(root, "server"), path.join(stage, "server"), { recursive: true });
// Source maps would only add weight; the package is not debugged from its tarball.
const removeMaps = async (/** @type {string} */ dir) => {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) await removeMaps(file);
    else if (entry.name.endsWith(".map")) await rm(file);
  }
};
await removeMaps(path.join(stage, "build"));
await chmod(path.join(stage, "server/server.mjs"), 0o755);
await writeFile(
  path.join(stage, "package.json"),
  `${JSON.stringify(
    {
      name: PACKAGE_NAME,
      version,
      description: "AKM's web interface for a server or container, started with akm-ui.",
      license: "MPL-2.0",
      type: "module",
      repository: { type: "git", url: "git+https://github.com/itlackey/akm.git", directory: "desktop" },
      bin: { "akm-ui": "server/server.mjs" },
      dependencies: { "akm-cli": version, "jsonc-parser": manifest.dependencies["jsonc-parser"] },
      engines: { node: manifest.engines.node },
    },
    null,
    2,
  )}\n`,
);
await writeFile(
  path.join(stage, "build-info.json"),
  `${JSON.stringify({ commit: commit + (dirty ? "-dirty" : "") })}\n`,
);
await cp(path.join(root, "THIRD_PARTY.md"), path.join(stage, "THIRD_PARTY.md"));
await cp(path.join(root, "../LICENSE"), path.join(stage, "LICENSE"));
await writeFile(
  path.join(stage, "README.md"),
  `# ${PACKAGE_NAME}

AKM's web interface for a server or container. It manages the library of the user that runs it.

\`\`\`sh
npm install -g ${PACKAGE_NAME}
akm-ui --host 0.0.0.0 --port 4444 --origin http://my-server:4444
\`\`\`

It prints one JSON line with the \`url\` to open; that URL carries the session token. Anyone with the token can edit
the library's files, reveal its secrets and install host tools, and over plain HTTP the token is not encrypted: use a
private network, or a TLS proxy that keeps the Host header. See
https://github.com/itlackey/akm/blob/main/desktop/README.md#run-it-on-a-server.
`,
);
console.log(JSON.stringify({ name: PACKAGE_NAME, version, stage }));
