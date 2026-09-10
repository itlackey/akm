// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Two-or-more concurrent `akm improve` runs must never exit 78 (field
 * follow-up to #948, dev-team field review 2026-09-10). Before this fix, a
 * losing contender's whole-run lock acquisition
 * (`commands/improve/locks.ts`) threw `ConfigError("INVALID_CONFIG_FILE")`,
 * surfacing as exit 78 — telling a supervisor/scheduler this was a broken
 * command line rather than ordinary contention between two legitimate
 * `improve` invocations, exactly the anti-pattern #956 already fixed for the
 * index rebuild lock and the maintenance-start barrier.
 *
 * Spawns REAL CLI child processes (`bun src/cli.ts improve`) against a
 * fully isolated scratch bundle/config/data dir (never the developer's real
 * `~/.config/akm`), mirroring `index-concurrent-start.test.ts`'s pattern for
 * #956's G1 regression: launch several contenders back to back with no work
 * between the `Bun.spawn` calls, so whichever one wins the lock is real, not
 * staged.
 *
 * Integration-scoped (ORG-03/06): spawns real child processes and opens a
 * real state.db.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { makeSandboxDir, makeStashDir, type SandboxedDir } from "../../../_helpers/sandbox";

const repoRoot = path.resolve(import.meta.dir, "../../../..");
const cliPath = path.join(repoRoot, "src", "cli.ts");

/**
 * A strategy with every LLM-backed process disabled so a winning contender
 * finishes fast without needing a reachable engine — mirrors
 * `improve-lock-invariants.test.ts`'s `quietConfig`. `triage` stays enabled:
 * it needs no engine call against an empty/near-empty memory scope.
 */
function writeQuietConfig(configDir: string): void {
  const configPath = path.join(configDir, "akm", "config.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      defaults: { improveStrategy: "quiet-test" },
      improve: {
        strategies: {
          "quiet-test": {
            processes: {
              reflect: { enabled: false },
              distill: { enabled: false },
              consolidate: { enabled: false },
              memoryInference: { enabled: false },
              graphExtraction: { enabled: false },
              extract: { enabled: false },
              validation: { enabled: false },
              triage: { enabled: true },
              proactiveMaintenance: { enabled: false },
              recombine: { enabled: false },
              procedural: { enabled: false },
            },
          },
        },
      },
    }),
  );
}

let stash: SandboxedDir;
let data: SandboxedDir;
let config: SandboxedDir;

beforeEach(() => {
  stash = makeStashDir();
  data = makeSandboxDir("akm-improve-concurrent-data");
  config = makeSandboxDir("akm-improve-concurrent-config");
  writeQuietConfig(config.dir);
});

afterEach(() => {
  stash.cleanup();
  data.cleanup();
  config.cleanup();
});

interface ChildResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function spawnImproveChild(): Promise<ChildResult> {
  const child = Bun.spawn(
    ["bun", cliPath, "improve", "memory", "--strategy", "quiet-test", "--json-to-stdout", "--no-sync"],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        AKM_BUNDLE_DIR: stash.dir,
        XDG_CONFIG_HOME: config.dir,
        XDG_DATA_HOME: data.dir,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
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

describe("akm improve — concurrent runs never exit 78 (field follow-up to #948)", () => {
  test("5 concurrent `akm improve` invocations: every exit code is 0 or 75, never 78 or 70, and every 75 carries IMPROVE_LOCK_HELD", async () => {
    const results = await Promise.all([
      spawnImproveChild(),
      spawnImproveChild(),
      spawnImproveChild(),
      spawnImproveChild(),
      spawnImproveChild(),
    ]);

    let acquiredCount = 0;
    for (const result of results) {
      expect([0, 75]).toContain(result.code);
      if (result.code === 0) {
        acquiredCount += 1;
        const parsed = JSON.parse(result.stdout) as { ok: boolean };
        expect(parsed.ok).toBe(true);
      } else {
        expect(result.stdout.trim()).toBe("");
        const envelope = parseTrailingJsonEnvelope(result.stderr);
        if (!envelope) throw new Error(`expected a JSON error envelope on stderr, got:\n${result.stderr}`);
        expect(envelope.ok).toBe(false);
        expect(envelope.code).toBe("IMPROVE_LOCK_HELD");
        expect(envelope.hint ?? "").toContain("--skip-if-locked");
        expect(envelope.error).toContain("akm improve is already running");
      }
    }
    // Exactly one contender holds the whole-run lock at a time (it is not
    // opportunistic like the index rebuild lock) — the rest must contend
    // for it, never proceed unlocked.
    expect(acquiredCount).toBeGreaterThanOrEqual(1);
    expect(acquiredCount).toBeLessThan(results.length);
  }, 60_000);
});
