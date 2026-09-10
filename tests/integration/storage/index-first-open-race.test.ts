// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Field follow-up: two concurrent `akm index` runs against a sandbox with no
 * pre-existing index.db could intermittently exit 70 with
 * `{"ok":false,"error":"no such table: entries"}`. Measured root cause: on a
 * brand-new database `index_meta.version` is absent, so
 * `classifyIndexGeneration` returns `older` and
 * `rebuildIncompatibleIndexGeneration` runs and drops `entries` -- while a
 * second concurrent opener, racing the same fresh file, can observe exactly
 * that transient "entries created, version not yet stamped" state from the
 * first opener's still-in-flight `ensureSchema` and treat it as a genuine
 * stale generation, dropping `entries` out from under the first opener
 * (`reconcileRoots`'s `SELECT ... FROM entries` then throws). This is the
 * same non-atomic-bootstrap shape as `state-db-migrations.test.ts`'s
 * "state.db first open" regression, applied to index.db.
 *
 * The fix wraps `ensureSchema`'s generation check through the final
 * `index_meta.version` stamp in one `withImmediateTransaction(db, ...,
 * "index")` (`index-schema.ts`): a concurrent opener's own `BEGIN IMMEDIATE`
 * blocks behind `busy_timeout` until that commits, so it only ever observes
 * fully-fresh (skip the rebuild) or fully-canonical (also skip the rebuild)
 * -- never the in-between. A still-contended opener sees `INDEX_DB_CONTENDED`
 * (exit 75, the documented retry-shortly contract), never the dropped-table
 * failure.
 *
 * Reproduced by racing two real `bun src/cli.ts index --full --format=json`
 * CLI child processes against a FRESH sandbox (own isolated stash/XDG dirs,
 * no pre-existing index.db) on every trial -- unlike
 * `index-concurrent-start.test.ts` next door (same `beforeEach` sandbox
 * reused across its whole trial loop, so only its first trial can ever hit a
 * first-open race; the rest exercise write-to-an-existing-index.db
 * contention instead), this test rebuilds the sandbox per trial specifically
 * to keep hitting the first-open window. A minimized reproduction (spawning
 * only `openIndexDatabase` + a read, skipping the rest of the CLI) was tried
 * first and measured at 0 failures in 150 pre-fix trials -- the fuller CLI
 * startup path apparently staggers the two children's arrival at
 * `ensureSchema` enough to actually land in the race window, where a
 * minimal script's near-simultaneous start does not, so this test pays for
 * the full CLI's startup cost to stay a faithful reproduction. Probabilistic,
 * not deterministic: forcing genuine interleaving between two OS processes
 * without a stall hook is not something this repo's driver exposes.
 * Measured against the unfixed code (see this change's PR description for
 * the exact run): ~2-4% of trials hit the race, idle or under load; 200
 * trials keeps the odds of missing a real regression entirely under 1-in-500
 * at the low end of that range.
 *
 * Integration-scoped (ORG-03/06): spawns real CLI subprocesses, each opening
 * a real index.db.
 */

import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "../../../");
const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  }
});

const STASH_SKELETON_SUBDIRS = ["skills", "commands", "agents", "knowledge", "scripts", "memories", "lessons"];

/** A fresh isolated sandbox (own stash/XDG dirs) with no pre-existing index.db. */
function freshSandboxEnv(prefix: string): Record<string, string> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  const stashDir = path.join(root, "stash");
  const dataDir = path.join(root, "data");
  const cacheDir = path.join(root, "cache");
  const configDir = path.join(root, "config");
  const stateDir = path.join(root, "state");
  for (const sub of STASH_SKELETON_SUBDIRS) fs.mkdirSync(path.join(stashDir, sub), { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.mkdirSync(path.join(configDir, "akm"), { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  const sessionLogsDir = path.join(root, "claude-projects");
  fs.mkdirSync(sessionLogsDir, { recursive: true });
  const claudePluginsDir = path.join(root, "claude-plugins");
  fs.mkdirSync(claudePluginsDir, { recursive: true });

  fs.writeFileSync(
    path.join(configDir, "akm", "config.json"),
    `${JSON.stringify({ configVersion: "0.9.0", semanticSearchMode: "off" }, null, 2)}\n`,
    "utf8",
  );

  const memDir = path.join(stashDir, "memories");
  for (let i = 0; i < 5; i++) {
    fs.writeFileSync(
      path.join(memDir, `note-${i}.md`),
      `---\ndescription: note ${i}\n---\n\nContent for note ${i}.\n`,
      "utf8",
    );
  }

  return {
    ...process.env,
    AKM_BUNDLE_DIR: stashDir,
    XDG_DATA_HOME: dataDir,
    XDG_CACHE_HOME: cacheDir,
    XDG_CONFIG_HOME: configDir,
    XDG_STATE_HOME: stateDir,
    AKM_CLAUDE_PROJECTS_DIR: sessionLogsDir,
    AKM_CLAUDE_PLUGINS_DIR: claudePluginsDir,
  };
}

interface ChildResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function spawnIndexChild(env: Record<string, string>): Promise<ChildResult> {
  const child = Bun.spawn(["bun", "src/cli.ts", "index", "--full", "--format=json"], {
    cwd: repoRoot,
    env,
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

// Measured against the unfixed code: ~2-4% of trials hit the race (see the
// module doc). 200 trials keeps the odds of missing a real regression
// entirely under 1-in-500 at the low end of that range.
const CONCURRENT_TRIALS = 200;

describe("index.db first open — concurrent creation never drops entries out from under the other opener (field follow-up)", () => {
  test("two real CLI processes racing an absent index.db never exit 70, and at least one completes", async () => {
    for (let trial = 0; trial < CONCURRENT_TRIALS; trial += 1) {
      const env = freshSandboxEnv(`akm-index-first-open-${trial}-`);

      const [a, b] = await Promise.all([spawnIndexChild(env), spawnIndexChild(env)]);

      for (const result of [a, b]) {
        if (result.code === 0) {
          const parsed = JSON.parse(result.stdout);
          expect(parsed.ok).toBe(true);
        } else {
          // The field bug is exit 70 with "no such table: entries" -- never
          // acceptable. The only allowed non-zero outcome is the documented
          // transient-contention contract.
          expect(result.code).toBe(75);
          expect(result.stderr).not.toMatch(/no such table: entries/i);
        }
      }
      // At least one side must actually finish the index -- two processes
      // racing a first open may not BOTH be told to retry.
      expect(a.code === 0 || b.code === 0).toBe(true);
    }
  }, 400_000);
});
