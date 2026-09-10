// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * A concurrent plain `akm index` must exit 75, never 78 (field follow-up to
 * #956, G1). Spawns TWO REAL CLI child processes (`bun src/cli.ts index
 * --full --format=json`) launched back to back with no work between the two
 * `Bun.spawn` calls, so whichever internal race actually resolves first — the
 * short maintenance-barrier registration `acquireMaintenanceBarrier` contends
 * on, or the index.db write contention `INDEX_DB_CONTENDED` (F1) reclassifies
 * — is exercised exactly as a real scheduler/hook double-launch would hit it,
 * unlike index-skip-if-locked.test.ts (a single run, asserting only the
 * deprecation warning/no-op behavior — no concurrency, no lock file) or
 * index-db-contention.test.ts (holds a second DB connection open). Neither
 * mechanism collides on every pair on a fast, unloaded machine (the barrier
 * is normally held sub-millisecond), so this repeats many small concurrent
 * pairs rather than one pair — empirically the reliable way to actually
 * reproduce the reported bug (verified against the unfixed code: repeated
 * small pairs reproduce a real `exit 78` in a handful of trials, where a
 * single pair usually does not collide at all). Across every trial this pins
 * the property the field bug broke: no process ever exits 78 (config error —
 * the reported regression) or 70 (internal/unclassified) — only 0 (no
 * collision, or a "contended" warn-and-proceed that still completed) or 75
 * (`TransientError`, code `MAINTENANCE_BARRIER_BUSY` or `INDEX_DB_CONTENDED`).
 *
 * Integration-scoped (ORG-03/06): spawns real child processes, each opening a
 * real index.db.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { saveConfig } from "../../../../src/core/config/config";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../../../_helpers/sandbox";

const repoRoot = path.resolve(import.meta.dir, "../../../..");

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  saveConfig({ semanticSearchMode: "off" });
});

afterEach(() => {
  storage.cleanup();
});

function seedMemoryFiles(count: number): void {
  const dir = path.join(storage.stashDir, "memories");
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < count; i++) {
    fs.writeFileSync(
      path.join(dir, `note-${i}.md`),
      `---\ndescription: note ${i}\n---\n\nContent for note ${i}.\n`,
      "utf8",
    );
  }
}

interface ChildResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function spawnIndexChild(extraArgs: string[]): Promise<ChildResult> {
  const child = Bun.spawn(["bun", "src/cli.ts", "index", "--full", "--format=json", ...extraArgs], {
    cwd: repoRoot,
    env: { ...process.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stdout, stderr };
}

/** The CLI's JSON error envelope is pretty-printed (emitJsonError uses JSON.stringify(..., null, 2)), so it can span
 * several lines after any plain warn/info lines already on stderr — take the LAST top-level `{...}` block. */
function parseTrailingJsonEnvelope(
  stderr: string,
): { ok: boolean; error: string; code?: string; hint?: string } | undefined {
  const start = stderr.lastIndexOf("{\n");
  if (start === -1) return undefined;
  return JSON.parse(stderr.slice(start));
}

// A handful of tiny files keeps each trial's own run fast; the collision
// this test needs comes from repeating many concurrent pairs (below), not
// from making any one pair's run slow.
const FILES_PER_TRIAL = 5;
// Empirically the smallest trial count that reliably produced at least one
// real collision (either mechanism) against the unfixed code in repeated
// local runs — see the module doc.
const CONCURRENT_TRIALS = 15;

describe("akm index — two real concurrent runs never exit 78 or 70 (field follow-up to #956, G1)", () => {
  test("without --skip-if-locked: every exit code across many concurrent pairs is 0 or 75, and every 75 carries a transient code with a --skip-if-locked hint", async () => {
    seedMemoryFiles(FILES_PER_TRIAL);

    for (let trial = 0; trial < CONCURRENT_TRIALS; trial += 1) {
      // Launched back to back with no work in between — whichever internal
      // race actually resolves (the barrier or index.db) is real, not staged.
      const results = await Promise.all([spawnIndexChild([]), spawnIndexChild([])]);

      for (const result of results) {
        expect([0, 75]).toContain(result.code);
        if (result.code === 75) {
          expect(result.stdout.trim()).toBe("");
          const envelope = parseTrailingJsonEnvelope(result.stderr);
          if (!envelope) throw new Error(`expected a JSON error envelope on stderr, got:\n${result.stderr}`);
          expect(envelope.ok).toBe(false);
          expect(["MAINTENANCE_BARRIER_BUSY", "INDEX_DB_CONTENDED"]).toContain(envelope.code ?? "");
          expect(envelope.hint ?? "").toContain("--skip-if-locked");
        }
      }
    }
  }, 120_000);

  test("--skip-if-locked: every run across many concurrent pairs exits 0 — either a completed index or a lock-held skip, never a failure", async () => {
    seedMemoryFiles(FILES_PER_TRIAL);

    for (let trial = 0; trial < CONCURRENT_TRIALS; trial += 1) {
      const results = await Promise.all([spawnIndexChild(["--skip-if-locked"]), spawnIndexChild(["--skip-if-locked"])]);

      for (const result of results) {
        expect(result.code).toBe(0);
        const parsed = JSON.parse(result.stdout);
        expect(parsed.ok).toBe(true);
      }
    }
  }, 120_000);
});
