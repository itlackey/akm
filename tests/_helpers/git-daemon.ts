// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * A real `git daemon` serving every bare repository under `basePath` on loopback. It runs as a separate process:
 * akm's synchronous git calls would deadlock an in-process server.
 */

import { spawnSync } from "node:child_process";

export interface GitDaemon {
  /** `git://127.0.0.1:<port>` */
  baseUrl: string;
  stop(): void;
}

/** `readyRepo` is a repository (relative to `basePath`) that must exist before the daemon is used. */
export function startGitDaemon(basePath: string, readyRepo: string): GitDaemon {
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const port = probe.port;
  probe.stop(true);
  const daemon = Bun.spawn(
    [
      "git",
      "daemon",
      "--reuseaddr",
      "--listen=127.0.0.1",
      `--port=${port}`,
      `--base-path=${basePath}`,
      "--export-all",
      basePath,
    ],
    { stdout: "ignore", stderr: "ignore" },
  );
  const baseUrl = `git://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 50; attempt++) {
    if (spawnSync("git", ["ls-remote", `${baseUrl}/${readyRepo}`]).status === 0) break;
    Bun.sleepSync(100);
  }
  return { baseUrl, stop: () => daemon.kill() };
}
