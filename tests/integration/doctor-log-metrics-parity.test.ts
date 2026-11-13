// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * #1624/#1625: each `akm doctor` report returns what the command it replaces returns.
 * Subprocess runs against one isolated storage, with task history seeded directly.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { openStateDatabase } from "../../src/core/state-db";
import { upsertTaskHistory } from "../../src/storage/repositories/task-history-repository";
import { withIsolatedAkmStorage, writeSandboxConfig } from "../_helpers/sandbox";

const CLI = path.resolve(import.meta.dir, "../../src/cli.ts");
let storage: ReturnType<typeof withIsolatedAkmStorage>;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  writeSandboxConfig({
    semanticSearchMode: "off",
    bundles: { stash: { path: storage.stashDir, writable: true } },
    defaultBundle: "stash",
    connections: { test: { endpoint: "https://example.test/v1/chat/completions", models: { fast: "test" } } },
  });
});
afterEach(() => storage.cleanup());

function akm(args: string[]) {
  const result = spawnSync("bun", [CLI, ...args, "--format", "json"], {
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, NO_COLOR: "1", AKM_EVENT_SOURCE: undefined },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** Old and new commands give the same stdout and exit code; only the old one prints the notice. */
function expectParity(oldArgs: string[], newArgs: string[]) {
  const old = akm(oldArgs);
  const replacement = akm(newArgs);
  expect(replacement.status).toBe(old.status);
  // `--since` echoes the moment it was resolved, which differs between two processes.
  const stable = (stdout: string) => stdout.replace(/"since":\s*"[^"]*"/, '"since":"<now>"');
  expect(stable(replacement.stdout)).toBe(stable(old.stdout));
  expect(replacement.stderr).not.toContain("[deprecated]");
  expect(old.stderr).toContain("[deprecated]");
  expect(old.stderr).toContain(newArgs.slice(0, 3).join(" "));
  return old;
}

function seedTaskHistory() {
  const db = openStateDatabase();
  try {
    const row = (task_id: string, started_at: string, trigger: "schedule" | "manual") =>
      upsertTaskHistory(db, {
        task_id,
        status: "completed",
        started_at,
        completed_at: started_at,
        failed_at: null,
        log_path: null,
        target_kind: "command",
        target_ref: null,
        metadata_json: JSON.stringify({ metadataVersion: 2, durationMs: 5, detail: null, trigger }),
      });
    row("nightly", "2025-01-01T00:00:01.000Z", "schedule");
    row("nightly", "2025-01-01T00:00:02.000Z", "manual");
    row("other", "2025-01-01T00:00:03.000Z", "manual");
  } finally {
    db.close();
  }
}

test("doctor log --task returns the runs task history returns, including trigger", () => {
  seedTaskHistory();
  const old = expectParity(["task", "history", "nightly"], ["doctor", "log", "--task", "nightly"]);
  const rows = JSON.parse(old.stdout).rows as Array<{ id: string; trigger?: string }>;
  expect(rows.map((r) => r.id)).toEqual(["nightly", "nightly"]);
  expect(rows.map((r) => r.trigger).sort()).toEqual(["manual", "schedule"]);
  expectParity(["task", "history", "nightly", "--limit", "1"], ["doctor", "log", "--task", "nightly", "--limit", "1"]);
});

test("doctor log --task accepts a bundle-qualified id and --bundle", () => {
  seedTaskHistory();
  const name = "stash";
  const qualified = `${name}//tasks/nightly`;
  const old = expectParity(["task", "history", qualified], ["doctor", "log", "--task", qualified]);
  expect(JSON.parse(old.stdout).rows).toHaveLength(2);
  expectParity(
    ["task", "history", "nightly", "--bundle", name],
    ["doctor", "log", "--task", "nightly", "--bundle", name],
  );
});

test("doctor log without --task is the events stream", () => {
  const events = akm(["doctor", "log", "--limit", "1"]);
  expect(events.status).toBe(0);
  expect(JSON.parse(events.stdout)).toHaveProperty("events");
});

test("doctor log --task with an empty or blank id is a usage error, not every task's runs", () => {
  seedTaskHistory();
  for (const id of ["", "  "]) {
    const result = akm(["doctor", "log", "--task", id]);
    expect(result.status, id).toBe(2);
    expect(result.stderr).toContain("--task <id>");
    expect(result.stdout).not.toContain("runs");
  }
});

test("doctor metrics improve matches improve report for the latest run, --run and --since", () => {
  const live = akm(["improve", "--json-to-stdout"]);
  expect(live.status).toBe(0);
  const runId = String(JSON.parse(live.stdout).runId);
  expectParity(["improve", "report"], ["doctor", "metrics", "improve"]);
  expectParity(["improve", "report", "--run", runId], ["doctor", "metrics", "improve", "--run", runId]);
  expectParity(["improve", "report", "--since", "24h"], ["doctor", "metrics", "improve", "--since", "24h"]);
  const missing = akm(["doctor", "metrics", "improve", "--run", "nope"]);
  expect(missing.status).toBe(akm(["improve", "report", "--run", "nope"]).status);
  expect(akm(["doctor", "metrics", "improve", "--run", "x", "--since", "24h"]).status).toBe(2);
});

test("doctor metrics assets matches search --by-usage, with the same scope flags", () => {
  fs.writeFileSync(path.join(storage.stashDir, "knowledge", "alpha.md"), "---\ndescription: Alpha\n---\nalpha\n");
  fs.writeFileSync(path.join(storage.stashDir, "knowledge", "beta.md"), "---\ndescription: Beta\n---\nbeta\n");
  expect(akm(["index"]).status).toBe(0);
  for (const ref of ["alpha", "beta", "beta"]) expect(akm(["show", `knowledge/${ref}`]).status).toBe(0);
  const old = expectParity(["search", "--by-usage"], ["doctor", "metrics", "assets"]);
  expect((JSON.parse(old.stdout).results as Array<{ ref: string }>).map((h) => h.ref)).toEqual([
    "knowledge/beta",
    "knowledge/alpha",
  ]);
  expectParity(
    ["search", "--by-usage", "--limit", "1", "--detail", "normal", "--project", "none"],
    ["doctor", "metrics", "assets", "--limit", "1", "--detail", "normal", "--project", "none"],
  );
  expectParity(["search", "--by-usage", "--type", "memory"], ["doctor", "metrics", "assets", "--type", "memory"]);
});

test("-q silences the notices", () => {
  expect(akm(["task", "history", "-q"]).stderr).not.toContain("[deprecated]");
});
