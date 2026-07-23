// Independent proof: a single stale persisted 0.8 task `workflow:` target that no
// longer resolves (its workflow file was deleted) blocks the ENTIRE `migrate apply`.
// planTaskTargetRefMigration(target) runs at the very top of runMigrationApply,
// before any mutation, and throws for an unresolvable legacy target -> the whole
// migration aborts (rolls back) and the user cannot upgrade to 0.9 until they
// manually find and edit/remove the offending task.
import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { getConfigPath, getDataDir, getStateDbPathInDataDir } from "../../src/core/paths";
import { openStateDbAtCeiling, PRE_CUTOVER_STATE_CEILING } from "../_fixtures/migration/seed-rows";
import { runCliCapture } from "../_helpers/cli";
import {
  type Cleanup,
  sandboxHome,
  sandboxXdgCacheHome,
  sandboxXdgConfigHome,
  sandboxXdgDataHome,
} from "../_helpers/sandbox";

let cleanup: Cleanup | undefined;
beforeEach(() => {
  const home = sandboxHome();
  const config = sandboxXdgConfigHome(home.cleanup);
  const cache = sandboxXdgCacheHome(config.cleanup);
  cleanup = sandboxXdgDataHome(cache.cleanup).cleanup;
});
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

function writeConfigs(): string {
  fs.mkdirSync(path.dirname(getConfigPath()), { recursive: true });
  fs.writeFileSync(getConfigPath(), `${JSON.stringify({ configVersion: "0.8.0" })}\n`, { mode: 0o600 });
  const prepared = path.join(path.dirname(getConfigPath()), "prepared-0.9.json");
  fs.writeFileSync(
    prepared,
    `${JSON.stringify({
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      stashDir: path.join(getDataDir(), "stash"),
    })}\n`,
  );
  return prepared;
}

test("a stale/unresolvable persisted task workflow target blocks the whole migration", async () => {
  openStateDbAtCeiling(getStateDbPathInDataDir(), PRE_CUTOVER_STATE_CEILING).close();

  const stash = path.join(getDataDir(), "stash");
  const tasksDir = path.join(stash, "tasks");
  fs.mkdirSync(tasksDir, { recursive: true });
  // A persisted 0.8 task whose legacy `workflow:` target points at a workflow
  // that does NOT exist on disk (a normal outcome: the user deleted the workflow
  // months ago but left the scheduled task behind).
  fs.writeFileSync(
    path.join(tasksDir, "nightly.yml"),
    "version: 1\nworkflow: workflow:ship\nschedule: '0 2 * * *'\n",
  );
  // NOTE: stash/workflows/ship.{md,yaml,yml} intentionally absent.

  const prepared = writeConfigs();
  const applied = await runCliCapture(["migrate", "apply", "--config", prepared]);

  console.log("exit code:", applied.code);
  console.log("stderr:", applied.stderr.slice(0, 600));

  // The migration is BLOCKED by the one stale task.
  expect(applied.code).not.toBe(0);
  expect(applied.stderr).toMatch(/task|workflow:ship|not found|migrate/i);

  // No cutover happened: the state.db is still at the pre-cutover ceiling (fully
  // restored / never advanced), so the user is stuck on 0.8 until they hand-fix.
  const { Database } = await import("bun:sqlite");
  const db = new Database(getStateDbPathInDataDir(), { readonly: true });
  try {
    const last = (db.query("SELECT id FROM schema_migrations ORDER BY rowid").all() as Array<{ id: string }>).at(-1);
    console.log("state.db ledger tip after blocked apply:", last?.id);
    expect(last?.id).toBe(PRE_CUTOVER_STATE_CEILING); // never reached 020
  } finally {
    db.close();
  }
}, 60_000);
