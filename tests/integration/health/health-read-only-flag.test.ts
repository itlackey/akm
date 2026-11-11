// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Integration: real CLI processes against isolated state databases and filesystem fixtures.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AkmHealthResult } from "../../../src/commands/health/types";
import { createProposal } from "../../../src/commands/proposal/repository";
import { STATE_MIGRATIONS } from "../../../src/core/state/migrations";
import { getStateDbPath, openStateDatabase } from "../../../src/core/state-db";
import { type Database, openDatabase } from "../../../src/storage/database";
import { upsertTaskHistory } from "../../../src/storage/repositories/task-history-repository";
import { runMigrations } from "../../../src/storage/sqlite-migrations";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "../../_helpers/sandbox";

let storage: IsolatedAkmStorage;
let emptyBin: string;
let writer: Database | undefined;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  emptyBin = path.join(storage.root, "bin");
  fs.mkdirSync(emptyBin);
  writeSandboxConfig({
    semanticSearchMode: "off",
    improve: { enabled: false },
    defaultBundle: "fixture",
    bundles: {
      fixture: { path: storage.stashDir, writable: true, components: { main: { root: ".", adapter: "akm" } } },
    },
  });
});
afterEach(() => {
  writer?.close();
  writer = undefined;
  storage.cleanup();
});

async function cli(command: string, args: string[]) {
  const child = Bun.spawn([process.execPath, path.resolve("src/cli.ts"), command, ...args], {
    env: { ...process.env, PATH: emptyBin },
    stdin: "ignore",
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

async function health(command: string, args: string[]) {
  const result = await cli(command, [...args, "--no-probe", "--format", "json", "--quiet"]);
  expect(fs.statSync(path.join(storage.dataDir, "akm", "usage.sqlite")).isFile()).toBe(true);
  return {
    ...result,
    data: JSON.parse(result.stdout) as AkmHealthResult & {
      report?: {
        pendingProposals: Array<{ ref: string }>;
        acceptRateBySource: Array<{ source: string; pending: number }>;
      };
    },
  };
}

/** Inspected-state bytes and filenames; only the separate CLI usage database is exempt.
 * SQLite readers may update SHM read-lock bookkeeping. */
function dataSnapshot() {
  return fs
    .readdirSync(storage.dataDir, { recursive: true, encoding: "utf8" })
    .filter((file) => file !== path.join("akm", "usage.sqlite"))
    .filter((file) => fs.statSync(path.join(storage.dataDir, file)).isFile())
    .sort()
    .map((file) => [
      file,
      file.endsWith("-shm")
        ? "read-lock bookkeeping"
        : createHash("sha256")
            .update(fs.readFileSync(path.join(storage.dataDir, file)))
            .digest("hex"),
    ]);
}

describe.each(["health", "doctor"])("akm %s --read-only", (command) => {
  test("the real command's help advertises the flag", async () => {
    const result = await cli(command, ["--help"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("--read-only");
  });

  test.each([false, true])("a missing database stays missing (report=%s)", async (report) => {
    const before = dataSnapshot();
    const result = await health(command, ["--read-only", ...(report ? ["--report"] : [])]);
    expect(result.code).toBe(1);
    expect(result.data.status).toBe("fail");
    expect(result.data.hardChecks).toMatchObject([{ name: "state-db-readable", status: "fail" }]);
    expect(dataSnapshot()).toEqual(before);
    expect(fs.existsSync(getStateDbPath())).toBe(false);
  });

  test.each([false, true])("current state is read without a write probe (report=%s)", async (report) => {
    // Keep the fixture writer alive: finalizing its last connection can checkpoint
    // WAL during the subprocess wait, independently of the read-only command.
    writer = openStateDatabase();
    const proposal = createProposal(storage.stashDir, {
      ref: "lessons/fixture",
      source: "reflect",
      sourceRun: "fixture",
      payload: { content: "---\ndescription: Fixture guidance\nwhen_to_use: Testing health reports\n---\n\nBody.\n" },
    });
    expect(fs.statSync(`${getStateDbPath()}-wal`).size).toBeGreaterThan(0);
    const before = dataSnapshot();
    Bun.gc(true);
    const result = await health(command, ["--read-only", ...(report ? ["--report"] : [])]);
    expect(result.code).toBe(0);
    expect(result.data.status).toBe("pass");
    expect(result.data.hardChecks.find((check) => check.name === "state-db-round-trip")).toMatchObject({
      status: "unknown",
    });
    expect(result.data.hardChecks.find((check) => check.name === "state-db-migrations")?.evidence?.applied).toEqual([]);
    if (report) {
      expect(result.data.report?.pendingProposals).toEqual([
        { ref: proposal.ref, source: "reflect", createdAt: expect.any(String) },
      ]);
      expect(result.data.report?.acceptRateBySource).toMatchObject([{ source: "reflect", pending: 1 }]);
      expect(result.data.windows).toHaveLength(2);
    }
    expect(dataSnapshot()).toEqual(before);
    if (report) {
      const ordinary = await health(command, ["--report"]);
      expect(ordinary.data.report).toEqual(result.data.report);
    }
  });

  test.each([false, true])("pending migrations are reported, not applied (report=%s)", async (report) => {
    const file = getStateDbPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const db = openDatabase(file);
    runMigrations(
      db,
      STATE_MIGRATIONS.slice(
        0,
        STATE_MIGRATIONS.findIndex((m) => m.id === "018-drop-dead-lane-schema"),
      ),
    );
    db.close();
    const before = dataSnapshot();
    const result = await health(command, ["--read-only", ...(report ? ["--report"] : [])]);
    expect(result.code).toBe(1);
    expect(result.data.status).toBe("fail");
    expect(result.data.hardChecks).toMatchObject([
      {
        name: "state-db-migrations",
        status: "fail",
        evidence: {
          pending: expect.arrayContaining(["018-drop-dead-lane-schema"]),
        },
      },
    ]);
    expect(dataSnapshot()).toEqual(before);
  });

  test.each([false, true])("corrupt state is reported without repair or replacement (report=%s)", async (report) => {
    const file = getStateDbPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "not a sqlite database\n");
    const before = dataSnapshot();
    const result = await health(command, ["--read-only", ...(report ? ["--report"] : [])]);
    expect(result.code).toBe(1);
    expect(result.data.hardChecks).toMatchObject([{ name: "state-db-readable", status: "fail" }]);
    expect(dataSnapshot()).toEqual(before);
  });

  test("warnings retain exit code 4 without modifying state", async () => {
    writer = openStateDatabase();
    const now = new Date().toISOString();
    upsertTaskHistory(writer, {
      task_id: "fixture-failure",
      status: "failed",
      started_at: now,
      completed_at: null,
      failed_at: now,
      log_path: null,
      target_kind: "shell",
      target_ref: null,
      metadata_json: JSON.stringify({ durationMs: 1 }),
    });
    expect(fs.statSync(`${getStateDbPath()}-wal`).size).toBeGreaterThan(0);
    const before = dataSnapshot();
    Bun.gc(true);
    const result = await health(command, ["--read-only"]);
    expect(result.code).toBe(4);
    expect(result.data.status).toBe("warn");
    expect(result.data.advisories.find((check) => check.name === "task-fail-rate")?.status).toBe("warn");
    expect(dataSnapshot()).toEqual(before);
  });

  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "unreadable state is reported without changing permissions",
    async () => {
      const file = getStateDbPath();
      // Isolate the permission failure from WAL checkpoint/sidecar bookkeeping.
      const db = openStateDatabase();
      db.exec("PRAGMA journal_mode = DELETE");
      db.close();
      const before = dataSnapshot();
      fs.chmodSync(file, 0);
      try {
        const result = await health(command, ["--read-only", "--report"]);
        expect(result.code).toBe(1);
        expect(result.data.hardChecks).toMatchObject([{ name: "state-db-readable", status: "fail" }]);
        expect(fs.statSync(file).mode & 0o777).toBe(0);
      } finally {
        fs.chmodSync(file, 0o600);
      }
      expect(dataSnapshot()).toEqual(before);
    },
  );

  test("the default still initializes state and performs its write/read probe", async () => {
    const result = await health(command, []);
    expect(result.code).toBe(0);
    expect(fs.existsSync(getStateDbPath())).toBe(true);
    expect(result.data.hardChecks.find((check) => check.name === "state-db-round-trip")?.status).toBe("pass");
  });
});
