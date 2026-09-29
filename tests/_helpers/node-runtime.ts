// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Resolve a genuine Node.js executable for tests that need to run code
 * under real Node, as opposed to Bun.
 *
 * Bun installs its own `node` shim on PATH (e.g. `~/.bun/bin/node`, a
 * symlink to the `bun` binary itself) so `#!/usr/bin/env node` scripts run
 * under Bun. That shim still sets `process.versions.bun`, even though it
 * was invoked as `node` — `Bun.which("node")` happily returns it when it
 * sits earlier on PATH than a real installation (nvm, system Node, …).
 * Tests that need an actual Node process (e.g. to prove the install
 * launchers' Node-only fallback path, or to simulate an old Node version)
 * must not pick up that shim, so this scans every `node` on PATH and
 * returns the realpath of the first one that reports no `process.versions.bun`.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

let cached: string | undefined;

export function realNodeExecutable(): string {
  if (cached) return cached;
  const exeName = process.platform === "win32" ? "node.exe" : "node";
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, exeName);
    if (!fs.existsSync(candidate)) continue;
    const resolved = fs.realpathSync(candidate);
    const probe = spawnSync(resolved, ["-e", "process.exit(process.versions.bun ? 1 : 0)"], {
      encoding: "utf8",
      timeout: 5_000,
    });
    if (probe.status === 0) {
      cached = resolved;
      return resolved;
    }
  }
  throw new Error("No genuine Node.js executable (distinct from Bun's `node` PATH shim) was found on PATH.");
}
