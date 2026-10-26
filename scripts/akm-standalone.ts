#!/usr/bin/env bun

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
/**
 * Entry point for COMPILED standalone binaries (`bun build --compile`) —
 * release artifacts, tests/release-check.sh, and the Docker install tests.
 *
 * It exists so the executable embeds both the CLI and the explicit task-v2 to
 * task-v3 migrator. A compiled binary has no scripts/ tree on disk, while the
 * source/npm build exposes the same task-only implementation as `akm-migrate`.
 *
 * Dispatch:
 *   - `AKM_MIGRATE_ENTRY=1` (set by `runMigrationTool` when it re-execs this
 *     same binary): run the migrator's `main` over our args, exactly like the
 *     `scripts/akm-migrate.ts` subprocess would.
 *   - otherwise: run the CLI. `AKM_STANDALONE_ENTRY=1` opts into cli.ts's
 *     startup block, the same pattern `dist/cli-node.mjs` uses with
 *     `AKM_NODE_ENTRY` — cli.ts is imported, so its `import.meta.main` is false.
 */
import { STANDALONE_FROZEN_SCRIPT_ARG } from "../src/tasks/standalone-script-entry";

if (process.argv[2] === STANDALONE_FROZEN_SCRIPT_ARG) {
  const file = process.argv[3];
  if (process.argv.length !== 4 || !file || !path.isAbsolute(file) || ![".js", ".ts"].includes(path.extname(file))) {
    throw new Error("Invalid internal frozen-script invocation.");
  }
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error("Internal frozen-script target is not a no-follow regular file.");
  }
  // Present conventional Bun script argv (`binary`, `script`) to authored code
  // and consume standalone startup markers before the CLI import.
  const executable = process.argv[0] ?? process.execPath;
  process.argv.splice(0, process.argv.length, executable, file);
  delete process.env.AKM_STANDALONE_ENTRY;
  // Dynamic import normally leaves import.meta.main false because this
  // standalone wrapper remains Bun's entry module. Temporarily make the
  // frozen snapshot the runtime's main path so conventional Bun scripts using
  // `if (import.meta.main)` retain their normal entry-module semantics.
  const originalMain = Bun.main;
  if (!Reflect.set(Bun, "main", file))
    throw new Error("Unable to set the standalone frozen script as Bun's main module.");
  try {
    await import(pathToFileURL(file).href);
  } finally {
    Reflect.set(Bun, "main", originalMain);
  }
} else if (process.env.AKM_MIGRATE_ENTRY === "1") {
  // Consume the marker so commands the migrator itself shells out to never
  // see it, and a re-entrant `akm` child dispatches normally.
  delete process.env.AKM_MIGRATE_ENTRY;
  const { runWithJsonErrors } = await import("../src/cli/shared");
  const { main } = await import("./akm-migrate/main");
  await runWithJsonErrors(() => main(process.argv.slice(2)));
} else {
  process.env.AKM_STANDALONE_ENTRY = "1";
  await import("../src/cli");
}
