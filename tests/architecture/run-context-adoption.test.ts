// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * RunContext adoption ratchet (0.9.0 gate hardening; plan §2.1 / §11 Chunk 9).
 *
 * Chunk 7 MINTED the `RunContext` seam (`src/commands/improve/run-context.ts`).
 * Until WI-9.10, the improve loop carried its state on the legacy
 * `ImproveRunContext` (improve.ts) — a second, incompatible context.
 * WI-9.10 unified `ImproveRunContext` onto `RunContext` + a new mutable
 * `ImproveLoopState` (`src/commands/improve/improve-run-types.ts`) that
 * CONTAINS a `RunContext`, and deleted the `ImproveRunContext` interface
 * outright, so this ratchet is now ABSOLUTE (anchors.md A.5):
 *
 *   1. `ImproveRunContext` may never reappear ANYWHERE in `src/**` — the
 *      baseline below is the empty map, so every match is a violation
 *      (manifest gate: `grep ImproveRunContext → 0`, satisfied by
 *      construction).
 *   2. The minted `createRunContext` seam must not be deleted as "dead
 *      code" — it is now load-bearing: `akmImprove` constructs it at the
 *      run entry (`src/commands/improve/improve.ts`).
 *   3. The legacy interface must never come back under the same name, in
 *      ANY file — a rename-and-redefine would slip past a naive grep of
 *      the OLD identifier only if it also changed the name; this ratchet
 *      greps the literal identifier itself across all of `src/**`, so a
 *      revival under the same name fails immediately, absolutely.
 *
 * Baseline measured at the chunk-7 completion HEAD (43d6f10); emptied and
 * flipped absolute at WI-9.10 (chunk-9).
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const SRC_ROOT = path.join(REPO_ROOT, "src");

/** ABSOLUTE (empty): no file may reference the legacy `ImproveRunContext` identifier. */
const IMPROVE_RUN_CONTEXT_BASELINE: ReadonlyMap<string, number> = new Map([]);

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
  test("ImproveRunContext (the legacy dual context) is fully retired: zero references anywhere in src", () => {
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
        `RunContext adoption ratchet — ImproveRunContext was deleted at WI-9.10; the baseline is now the empty ` +
          `map, so ANY match is a violation:\n${problems.join("\n")}\n\nThread the minted RunContext ` +
          `(src/commands/improve/run-context.ts) + ImproveLoopState (src/commands/improve/improve-run-types.ts) instead.`,
      );
    }
    expect(problems).toEqual([]);
  });

  test("the minted createRunContext seam stays in place — it is load-bearing at the akmImprove entry", () => {
    // Guard against a well-meaning dead-code sweep deleting the seam. It is no
    // longer merely "pinned for a future adoption chunk" — akmImprove
    // constructs it directly (src/commands/improve/improve.ts).
    const seamPath = path.join(SRC_ROOT, "commands", "improve", "run-context.ts");
    expect(fs.existsSync(seamPath)).toBe(true);
    const src = fs.readFileSync(seamPath, "utf8");
    expect(/export function createRunContext\b/.test(src)).toBe(true);
  });

  test("the legacy interface can never come back under its own name, in any file (absolute anti-rename/anti-regression guard)", () => {
    // WI-9.10 flip: with the baseline emptied, the previous "definition site
    // must still exist while the baseline is non-empty" guard would now be
    // permanently vacuous. Replaced with the permanent, absolute assertion the
    // ratchet exists to protect: no file anywhere in src/** may declare an
    // `interface ImproveRunContext` (or a `type ImproveRunContext` alias)
    // ever again — independent of, and in addition to, the identifier-count
    // check above.
    expect(IMPROVE_RUN_CONTEXT_BASELINE.size).toBe(0);
    for (const file of walkTsFiles(SRC_ROOT)) {
      const src = fs.readFileSync(file, "utf8");
      const rel = path.relative(REPO_ROOT, file).split(path.sep).join("/");
      expect([rel, /\binterface\s+ImproveRunContext\b/.test(src)]).toEqual([rel, false]);
      expect([rel, /\btype\s+ImproveRunContext\b/.test(src)]).toEqual([rel, false]);
    }
  });
});
