// PROOF: Interrupted pre-cutover migration (journal at `state-applied`) + an
// out-of-band change to the live config.json traps the user: `migrate apply`
// refuses to resume (generation mismatch) AND `backup restore` refuses because
// the apply journal exists. No supported command can move forward or roll back.

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { getMigrationApplyJournalPath } from "../../src/core/migration-backup";
import { getConfigPath, getDataDir, getDbPath, getStateDbPathInDataDir } from "../../src/core/paths";
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

/** Minimal last-good index.db (entries + usage_events) — a realistic 0.8 sidecar DB. */
function seedMinimalIndexDb(): void {
  fs.mkdirSync(path.dirname(getDbPath()), { recursive: true });
  const idx = new Database(getDbPath());
  idx.exec(
    `CREATE TABLE entries (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       entry_key TEXT NOT NULL,
       item_ref  TEXT,
       entry_type TEXT NOT NULL,
       stash_dir TEXT NOT NULL
     );
     CREATE TABLE usage_events (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       event_type TEXT NOT NULL,
       entry_ref TEXT,
       created_at TEXT NOT NULL DEFAULT (datetime('now'))
     );`,
  );
  idx
    .prepare("INSERT INTO entries (entry_key, item_ref, entry_type, stash_dir) VALUES (?, ?, ?, ?)")
    .run("skills:demo", "primary//skills/demo", "skill", path.join(getDataDir(), "stash"));
  idx.close();
}

function writeConfigs(): string {
  fs.mkdirSync(path.dirname(getConfigPath()), { recursive: true });
  // Live 0.8 config on disk (pre-cutover shape).
  fs.writeFileSync(getConfigPath(), `${JSON.stringify({ configVersion: "0.8.0" })}\n`, { mode: 0o600 });
  const prepared = path.join(path.dirname(getConfigPath()), "prepared-0.9.json");
  fs.writeFileSync(
    prepared,
    `${JSON.stringify({
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      stashDir: path.join(getDataDir(), "stash"),
      sources: [{ type: "filesystem", path: path.join(getDataDir(), "team"), name: "team", writable: true }],
      installed: [{ id: "reg-kit", source: "npm", ref: "@scope/kit", stashRoot: path.join(getDataDir(), "kit") }],
    })}\n`,
  );
  return prepared;
}

describe("interrupted pre-cutover migration + out-of-band config edit", () => {
  test("migrate apply refuses to resume AND backup restore refuses -> no supported way forward", async () => {
    // ── Build a realistic pre-cutover FROM-state and drive the REAL apply flow,
    //    crashing (SIGKILL) the instant it reaches `state-applied`.
    openStateDbAtCeiling(getStateDbPathInDataDir(), PRE_CUTOVER_STATE_CEILING).close();
    seedMinimalIndexDb();
    fs.mkdirSync(path.join(getDataDir(), "stash"), { recursive: true });
    const prepared = writeConfigs();

    const child = Bun.spawn(["bun", "src/cli.ts", "migrate", "apply", "--config", prepared], {
      cwd: path.resolve(import.meta.dir, "../.."),
      env: { ...process.env, AKM_TEST_MIGRATION_CRASH_AFTER: "state" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    // SIGKILL => non-zero, and the journal is parked at the pre-cutover phase.
    expect(exitCode).not.toBe(0);
    expect(fs.existsSync(getMigrationApplyJournalPath())).toBe(true);
    const parkedPhase = JSON.parse(fs.readFileSync(getMigrationApplyJournalPath(), "utf8")).phase;
    expect(parkedPhase).toBe("state-applied");

    // Sanity: an UNTOUCHED resume works (proves the deadlock is caused ONLY by
    // the out-of-band change, not by a broken fixture).
    // -> we do NOT resume here; instead we perturb the live config first.

    // ── Out-of-band change: the user edits their own live config.json (a very
    //    natural reaction to a stuck migration — the 0.9 runtime rejects the old
    //    config so no other akm command works). One appended byte is enough to
    //    change its migration-generation fingerprint.
    fs.appendFileSync(getConfigPath(), " ");

    // ── Recovery path 1: `migrate apply` — the ONLY forward-recovery command.
    const resume = await runCliCapture(["migrate", "apply"]);
    expect(resume.code).not.toBe(0);
    expect(resume.stderr).toMatch(/does not match the exact live artifact generation/);

    // ── Recovery path 2: `backup restore --confirm` — the ONLY rollback command.
    const restore = await runCliCapture(["backup", "restore", "--for", "0.9.0", "--confirm"]);
    expect(restore.code).not.toBe(0);
    expect(restore.stderr).toMatch(/Migration apply recovery is pending/);

    // ── The journal is STILL present (apply threw before mutating), so the two
    //    commands remain mutually exclusive on every subsequent invocation.
    expect(fs.existsSync(getMigrationApplyJournalPath())).toBe(true);

    // ── DEADLOCK: both supported recovery commands fail simultaneously. `migrate
    //    apply` says "can't resume, generation mismatch"; `backup restore` says
    //    "run migrate apply first". No documented escape (no --abandon/--force).
    const applyBlocked = /does not match the exact live artifact generation/.test(resume.stderr);
    const restoreBlocked = /Migration apply recovery is pending/.test(restore.stderr);
    expect(applyBlocked && restoreBlocked).toBe(true);
  }, 30_000);

  // CONTROL: identical crash, but NO out-of-band edit -> resume completes cleanly.
  // Proves the fixture yields a resumable state and the config edit is the sole
  // cause of the wedge (not a broken fixture).
  test("control: untouched resume after the same crash succeeds", async () => {
    openStateDbAtCeiling(getStateDbPathInDataDir(), PRE_CUTOVER_STATE_CEILING).close();
    seedMinimalIndexDb();
    fs.mkdirSync(path.join(getDataDir(), "stash"), { recursive: true });
    const prepared = writeConfigs();

    const child = Bun.spawn(["bun", "src/cli.ts", "migrate", "apply", "--config", prepared], {
      cwd: path.resolve(import.meta.dir, "../.."),
      env: { ...process.env, AKM_TEST_MIGRATION_CRASH_AFTER: "state" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exitCode).not.toBe(0);
    expect(JSON.parse(fs.readFileSync(getMigrationApplyJournalPath(), "utf8")).phase).toBe("state-applied");

    // No config edit -> resume completes and clears the journal.
    const resume = await runCliCapture(["migrate", "apply"]);
    expect(resume.code, resume.stderr).toBe(0);
    expect(fs.existsSync(getMigrationApplyJournalPath())).toBe(false);
  }, 30_000);
});
