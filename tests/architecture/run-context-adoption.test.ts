// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * RunContext adoption ratchet (0.9.0 gate hardening; plan §2.1 / §11 Chunk 9).
 *
 * Chunk 7 MINTED the `RunContext` seam (`src/commands/improve/run-context.ts`)
 * but adoption at the verb call sites is Chunk 6/9 work. Until then the loop
 * carries its state on the legacy `ImproveRunContext` (improve.ts) — a second,
 * incompatible context. This ratchet prevents the limbo from deepening:
 *
 *   1. `ImproveRunContext` references must NEVER spread beyond the files that
 *      carry them today, and per-file counts must not grow. Chunk 9 drives
 *      them to ZERO (manifest gate: `grep ImproveRunContext → 0`), at which
 *      point the empty baseline flips this into the absolute assertion.
 *   2. The minted `createRunContext` seam must not be deleted as "dead code"
 *      before its adoption chunk lands — removal without adoption re-opens
 *      the D6 read-once gap the seam exists to close.
 *
 * Baseline measured at the chunk-7 completion HEAD (43d6f10).
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const SRC_ROOT = path.join(REPO_ROOT, "src");

/** SHRINK-ONLY: file → max allowed `ImproveRunContext` identifier references. */
const IMPROVE_RUN_CONTEXT_BASELINE: ReadonlyMap<string, number> = new Map([
  ["src/commands/improve/improve.ts", 1],
  ["src/commands/improve/loop-stages.ts", 7],
]);

function* walkTsFiles(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walkTsFiles(full);
    else if (entry.isFile() && entry.name.endsWith(".ts")) yield full;
  }
}

function countReferences(): Map<string, number> {
  const counts = new Map<string, number>();
  const pattern = /\bImproveRunContext\b/g;
  for (const file of walkTsFiles(SRC_ROOT)) {
    const rel = path.relative(REPO_ROOT, file).split(path.sep).join("/");
    const matches = fs.readFileSync(file, "utf8").match(pattern);
    if (matches && matches.length > 0) counts.set(rel, matches.length);
  }
  return counts;
}

describe("RunContext adoption ratchet", () => {
  test("ImproveRunContext (the legacy dual context) never spreads: no new files, no per-file growth", () => {
    const live = countReferences();
    const problems: string[] = [];
    for (const [file, count] of live) {
      const allowed = IMPROVE_RUN_CONTEXT_BASELINE.get(file);
      if (allowed === undefined) {
        problems.push(`  NEW file references ImproveRunContext (use RunContext instead): ${file} (${count} refs)`);
      } else if (count > allowed) {
        problems.push(`  GREW: ${file} ${allowed} → ${count} refs (baseline is shrink-only)`);
      }
    }
    if (problems.length > 0) {
      throw new Error(
        `RunContext adoption ratchet — the legacy ImproveRunContext must shrink toward zero (Chunk 9), never ` +
          `spread:\n${problems.join("\n")}\n\nThread the minted RunContext (src/commands/improve/run-context.ts) instead.`,
      );
    }
    expect(problems).toEqual([]);
  });

  test("the minted createRunContext seam stays in place until its adoption chunk retires the baseline", () => {
    // Guard against a well-meaning dead-code sweep deleting the seam before
    // Chunk 6/9 adopt it. Once IMPROVE_RUN_CONTEXT_BASELINE is empty (legacy
    // context gone), this existence pin may be replaced by real usage.
    const seamPath = path.join(SRC_ROOT, "commands", "improve", "run-context.ts");
    expect(fs.existsSync(seamPath)).toBe(true);
    const src = fs.readFileSync(seamPath, "utf8");
    expect(/export function createRunContext\b/.test(src)).toBe(true);
  });
});
