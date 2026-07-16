// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Golden-oracle presence gate (0.9.0 gate hardening).
 *
 * The Chunk 0a golden fixtures are the behavior-preservation oracles that
 * later chunk gates verify against ("goldens from Chunk 0a stay green" —
 * manifest Chunks 6 and 9; recognition/placement parity in Wave 2). The
 * designation meta-test (`tests/goldens-designations.test.ts`) is deliberately
 * vacuous-safe over an empty registry, so a wholesale deletion of
 * `tests/fixtures/goldens/` makes every downstream gate pass VACUOUSLY —
 * exactly what happened in the 2026-07-15 test purge and what this lint makes
 * impossible to repeat silently.
 *
 * Checks (all mechanical, no suite run):
 *   1. `tests/fixtures/goldens/DESIGNATIONS.json` exists and parses.
 *   2. The registry is non-empty (Chunk 0a landed; an empty registry after
 *      that is a deletion, not a fresh start).
 *   3. Every registered fixture file exists on disk.
 *   4. Every registered consumer suite file exists on disk.
 *
 * Wired into `bun run lint`, so it holds at every chunk BASELINE gate
 * (lint+tsc only), every Finalize `bun run check`, and CI. Removing golden
 * assets legitimately (e.g. a designated re-baseline chunk retiring one)
 * means updating the registry in the same change — which is the intended
 * audit trail, not friction.
 */

import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const GOLDENS_ROOT = path.join(REPO_ROOT, "tests", "fixtures", "goldens");
const DESIGNATIONS_PATH = path.join(GOLDENS_ROOT, "DESIGNATIONS.json");

interface DesignationEntry {
  path: string;
  designation: string;
  consumers: string[];
}

function fail(message: string): never {
  console.error(`lint-goldens-presence: ${message}`);
  console.error(
    "The golden fixtures are behavior-preservation oracles for the 0.9.0 chunk gates (plan §15.5); " +
      "restore them (git history has them) or update tests/fixtures/goldens/DESIGNATIONS.json in the same " +
      "change if an asset is being retired by its designated chunk.",
  );
  process.exit(1);
}

if (!fs.existsSync(DESIGNATIONS_PATH)) {
  fail(`missing registry: ${path.relative(REPO_ROOT, DESIGNATIONS_PATH)} — the golden oracle set has been deleted.`);
}

let entries: DesignationEntry[];
try {
  const parsed = JSON.parse(fs.readFileSync(DESIGNATIONS_PATH, "utf8")) as { entries?: DesignationEntry[] };
  entries = parsed.entries ?? [];
} catch (err) {
  fail(`unreadable registry: ${err instanceof Error ? err.message : String(err)}`);
}

if (entries.length === 0) {
  fail("the registry is empty — Chunk 0a landed 51 designated assets; an empty registry means they were deleted.");
}

const problems: string[] = [];
const missingConsumers = new Set<string>();
for (const entry of entries) {
  const assetAbs = path.join(REPO_ROOT, entry.path);
  if (!fs.existsSync(assetAbs)) problems.push(`missing golden asset: ${entry.path}`);
  for (const consumer of entry.consumers ?? []) {
    if (!fs.existsSync(path.join(REPO_ROOT, consumer))) missingConsumers.add(consumer);
  }
}
for (const consumer of [...missingConsumers].sort()) {
  problems.push(`missing consumer suite: ${consumer}`);
}

if (problems.length > 0) {
  console.error(`lint-goldens-presence: ${problems.length} problem(s):`);
  for (const p of problems) console.error(`  ${p}`);
  fail("golden oracles referenced by DESIGNATIONS.json are absent — downstream chunk gates would pass vacuously.");
}

console.log(`lint-goldens-presence: OK — ${entries.length} designated golden asset(s) present with their consumer suites.`);
