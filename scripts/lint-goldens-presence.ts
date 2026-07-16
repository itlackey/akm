// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Golden-oracle presence + integrity gate (0.9.0 gate hardening).
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
 * Checks (all mechanical, no suite run — adversarial-audit hardened):
 *   1. `tests/fixtures/goldens/DESIGNATIONS.json` exists, parses, is non-empty.
 *   2. Every registered fixture file exists on disk.
 *   3. Every registered consumer suite file exists on disk.
 *   4. FROZEN INTEGRITY: every `frozen-migration-input` entry carries a
 *      `sha256` and the asset's bytes match it — `AKM_UPDATE_GOLDENS=1`
 *      cannot silently mutate a frozen oracle; a legitimate re-baseline
 *      re-designates the entry (designation/reBaselineChunk/hash) in the same
 *      reviewed change (surface-owner rule, registry `$policy`).
 *   5. NOT GUTTED: every consumer suite still calls
 *      `expectGolden(`/`loadGolden(`, contains no `.skip(`, and every
 *      entry's fixture path string appears in at least one of its consumers
 *      — an emptied/skipped suite reads as "0 pass 0 fail", exit 0, to bun,
 *      so file existence alone is not enough.
 *
 * Wired into `bun run lint`, so it holds at every chunk BASELINE gate
 * (lint+tsc only), every Finalize `bun run check`, and CI.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const GOLDENS_ROOT = path.join(REPO_ROOT, "tests", "fixtures", "goldens");
const DESIGNATIONS_PATH = path.join(GOLDENS_ROOT, "DESIGNATIONS.json");

interface DesignationEntry {
  path: string;
  designation: string;
  consumers: string[];
  sha256?: string;
}

function fail(message: string): never {
  console.error(`lint-goldens-presence: ${message}`);
  console.error(
    "The golden fixtures are behavior-preservation oracles for the 0.9.0 chunk gates (plan §15.5); " +
      "restore them (git history has them) or update tests/fixtures/goldens/DESIGNATIONS.json in the same " +
      "change if an asset is being retired or re-baselined by its owning chunk (surface-owner rule in $policy).",
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
const consumerContents = new Map<string, string | null>();

function readConsumer(rel: string): string | null {
  if (!consumerContents.has(rel)) {
    const abs = path.join(REPO_ROOT, rel);
    consumerContents.set(rel, fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : null);
  }
  return consumerContents.get(rel) ?? null;
}

for (const entry of entries) {
  const assetAbs = path.join(REPO_ROOT, entry.path);
  if (!fs.existsSync(assetAbs)) {
    problems.push(`missing golden asset: ${entry.path}`);
    continue;
  }

  if (entry.designation === "frozen-migration-input") {
    if (!entry.sha256) {
      problems.push(`frozen entry missing its sha256 pin (registry $policy amendment): ${entry.path}`);
    } else {
      const actual = crypto.createHash("sha256").update(fs.readFileSync(assetAbs)).digest("hex");
      if (actual !== entry.sha256) {
        problems.push(
          `FROZEN ASSET MUTATED: ${entry.path} bytes no longer match the registry sha256 — a frozen oracle was ` +
            "re-recorded outside its owning chunk (re-designate via the surface-owner rule instead)",
        );
      }
    }
  }

  const referenced = (entry.consumers ?? []).some((c) => {
    const src = readConsumer(c);
    return src !== null && src.includes(entry.path);
  });
  if (!referenced) {
    problems.push(`no consumer suite references the fixture path string: ${entry.path} (gutted or rewired suite?)`);
  }
}

for (const [rel, src] of consumerContents) {
  if (src === null) {
    problems.push(`missing consumer suite: ${rel}`);
    continue;
  }
  if (!src.includes("expectGolden(") && !src.includes("loadGolden(")) {
    problems.push(`consumer suite no longer calls expectGolden/loadGolden (gutted?): ${rel}`);
  }
  if (/\b(?:describe|test|it)\.skip\(/.test(src)) {
    problems.push(`consumer suite contains .skip( — golden coverage silently disabled: ${rel}`);
  }
}

if (problems.length > 0) {
  console.error(`lint-goldens-presence: ${problems.length} problem(s):`);
  for (const p of problems) console.error(`  ${p}`);
  fail("golden oracles are absent, mutated, or unexercised — downstream chunk gates would pass vacuously.");
}

const frozen = entries.filter((e) => e.designation === "frozen-migration-input").length;
console.log(
  `lint-goldens-presence: OK — ${entries.length} designated golden asset(s) present (${frozen} frozen, hash-verified), consumer suites intact.`,
);
