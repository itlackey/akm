// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fs from "node:fs";
import path from "node:path";
import { makeSandboxDir } from "./sandbox";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");

/**
 * An installed-style `dist/`: the REAL launcher (`scripts/node-runtime/akm`) beside a `cli.js` that runs this checkout's
 * `src/cli.ts`. It does not depend on `bun run build`, so it is never stale.
 */
export function makeLauncherDist(): { launcher: string; cleanup: () => void } {
  const sandbox = makeSandboxDir("akm-launcher-dist-");
  const launcher = path.join(sandbox.dir, "akm");
  fs.copyFileSync(path.join(REPO_ROOT, "scripts", "node-runtime", "akm"), launcher);
  fs.chmodSync(launcher, 0o755);
  fs.writeFileSync(
    path.join(sandbox.dir, "cli.js"),
    [
      "// Runs src/cli.ts the way the built cli.js does: opt in to the startup block.",
      'process.env.AKM_NODE_ENTRY = "1";',
      `await import(${JSON.stringify(path.join(REPO_ROOT, "src", "cli.ts"))});`,
      "",
    ].join("\n"),
  );
  return { launcher, cleanup: sandbox.cleanup };
}
