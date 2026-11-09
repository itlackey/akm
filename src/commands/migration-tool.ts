// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { NotFoundError } from "../core/errors";

function migrationEntryPoint(): string | undefined {
  const candidates = [
    fileURLToPath(
      new URL(process.versions.bun ? "../scripts/akm-migrate.js" : "../scripts/akm-migrate-node.js", import.meta.url),
    ),
    ...(process.versions.bun ? [fileURLToPath(new URL("../../scripts/akm-migrate.ts", import.meta.url))] : []),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate));
}

/** The standalone `akm-migrate` child process's captured exit status and output streams. */
export interface MigrationToolResult {
  status: number;
  stdout: string;
  stderr: string;
}

/**
 * Spawns the standalone `akm-migrate` tool and returns its captured exit
 * status plus stdout/stderr — never writes them itself. `migrate-cli.ts` uses
 * this packaging boundary to render the plan through the normal
 * output pipeline.
 */
export async function runMigrationTool(args: readonly string[]): Promise<MigrationToolResult> {
  const entry = migrationEntryPoint();
  if (!entry && process.env.AKM_MIGRATE_ENTRY === "1") {
    // Re-exec loop guard: we ARE the marked child, yet no migrator entry
    // resolved and the standalone wrapper did not intercept the marker — this
    // binary was compiled without `scripts/akm-standalone.ts`.
    throw new NotFoundError(
      "This binary was built without the embedded akm-migrate tool.",
      "FILE_NOT_FOUND",
      "Rebuild from scripts/akm-standalone.ts, or run akm-migrate from a source/npm install.",
    );
  }
  // Compiled standalone: no scripts/ tree exists on disk (`import.meta.url`
  // resolves inside the binary's virtual filesystem). Release binaries embed
  // the migrator in `scripts/akm-standalone.ts` and re-exec themselves
  // with the internal marker.
  // (src must not import scripts/: the dist build's tsc has `rootDir: src`.)
  const result = spawnSync(process.execPath, entry ? [entry, ...args] : [...args], {
    encoding: "utf8",
    env: entry ? process.env : { ...process.env, AKM_MIGRATE_ENTRY: "1" },
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) {
    throw new NotFoundError(
      `Cannot start the standalone akm-migrate tool: ${result.error.message}`,
      "FILE_NOT_FOUND",
      "Reinstall akm-cli, or use a runtime-free standalone release binary.",
    );
  }
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}
