// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { openUsage } from "../../src/cli/usage";
import { reportUsageIfDue } from "../../src/cli/usage-report";
import { resetConfigCache } from "../../src/core/config/config";
import { getDbPath } from "../../src/core/paths";
import { deriveEntryProvenance } from "../../src/indexer/installations";
import { closeDatabase, openIndexDatabase } from "../../src/storage/repositories/index-connection";
import { upsertEntry } from "../../src/storage/repositories/index-entries-repository";
import * as workspace from "../../src/workspace";
import { withIsolatedAkmStorage, writeSandboxConfig } from "../_helpers/sandbox";

let cleanup = () => {};
afterEach(() => cleanup());
function sandbox() {
  const storage = withIsolatedAkmStorage();
  cleanup = storage.cleanup;
  return storage;
}

const TODAY = new Date("2026-11-20T10:00:00Z");
const NOW = { now: TODAY, env: {} as NodeJS.ProcessEnv };

type Sent = { url: string; init: RequestInit; body: Record<string, unknown> };
function fakeFetch(reply: () => Response = () => new Response("{}", { status: 200 })) {
  const sent: Sent[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(url), init: init ?? {}, body: JSON.parse(String(init?.body)) });
    return reply();
  }) as unknown as typeof fetch;
  return { fn, sent };
}

/** Seed the usage store: created on `started`, with aggregate rows for the given days. */
function seed(
  started: string,
  rows: Array<{ day: string; command: string[]; source: string; attempts: number; failures?: number }> = [],
) {
  const db = openUsage();
  try {
    db.prepare("UPDATE cli_usage_meta SET value=? WHERE key='collectionStart'").run(`${started}T00:00:00.000Z`);
    for (const row of rows) {
      const dimensions = JSON.stringify({
        day: row.day,
        version: "0.10.0",
        source: row.source,
        instance: "11111111-1111-1111-1111-111111111111",
        command: row.command,
        arguments: [{ name: "query", explicit: true, value: "[redacted]" }],
      });
      db.prepare("INSERT INTO cli_usage_aggregates(key,dimensions,attempts,completed,failures) VALUES (?,?,?,?,?)").run(
        dimensions + row.day + row.source,
        dimensions,
        row.attempts,
        row.attempts,
        row.failures ?? 0,
      );
    }
  } finally {
    db.close();
  }
}
const lastDay = (surface: string) => {
  const db = openUsage();
  try {
    return (
      db.prepare("SELECT value FROM cli_usage_meta WHERE key=?").get(`report.${surface}.last_day`) as
        | { value: string }
        | undefined
    )?.value;
  } finally {
    db.close();
  }
};

test("a store created today sends nothing; it reports from the next UTC day", async () => {
  sandbox();
  const { fn, sent } = fakeFetch();
  expect(await reportUsageIfDue({ surface: "cli" }, { env: {}, fetch: fn })).toBe(false);
  expect(sent).toHaveLength(0);
  expect(lastDay("cli")).toBeUndefined();
});

test("the first report is due once, claims the day, and the same day sends nothing more", async () => {
  sandbox();
  seed("2026-11-01");
  const { fn, sent } = fakeFetch();
  expect(await reportUsageIfDue({ surface: "cli", version: "0.10.9" }, { ...NOW, fetch: fn })).toBe(true);
  expect(await reportUsageIfDue({ surface: "cli", version: "0.10.9" }, { ...NOW, fetch: fn })).toBe(false);
  expect(sent).toHaveLength(1);
  expect(lastDay("cli")).toBe("2026-11-20");
  expect(sent[0]?.url).toBe("https://reporting.fwdslsh.dev/api/v0/event");
  expect(sent[0]?.init.method).toBe("POST");
  expect(sent[0]?.init.headers).toEqual({ "App-Key": "A-SH-4111202318", "Content-Type": "application/json" });
  const next = new Date("2026-11-21T00:00:01Z");
  expect(await reportUsageIfDue({ surface: "cli" }, { ...NOW, now: next, fetch: fn })).toBe(true);
  expect(sent).toHaveLength(2);
});

test("the cli and desktop surfaces claim their own day", async () => {
  sandbox();
  seed("2026-11-01");
  const { fn, sent } = fakeFetch();
  expect(await reportUsageIfDue({ surface: "cli" }, { ...NOW, fetch: fn })).toBe(true);
  expect(await reportUsageIfDue({ surface: "desktop" }, { ...NOW, fetch: fn })).toBe(true);
  expect(sent.map((s) => s.body.eventName)).toEqual(["cli_daily", "desktop_daily"]);
});

test("concurrent callers send once", async () => {
  sandbox();
  seed("2026-11-01");
  const { fn, sent } = fakeFetch();
  const results = await Promise.all(
    Array.from({ length: 5 }, () => reportUsageIfDue({ surface: "cli" }, { ...NOW, fetch: fn })),
  );
  expect(results.filter(Boolean)).toHaveLength(1);
  expect(sent).toHaveLength(1);
});

test("a failed send is not retried that day", async () => {
  sandbox();
  seed("2026-11-01");
  const failing = fakeFetch(() => new Response("nope", { status: 500 }));
  expect(await reportUsageIfDue({ surface: "cli" }, { ...NOW, fetch: failing.fn })).toBe(false);
  const next = fakeFetch();
  expect(await reportUsageIfDue({ surface: "cli" }, { ...NOW, fetch: next.fn })).toBe(false);
  expect(next.sent).toHaveLength(0);
});

test("a 200 whose body carries an error is a rejection", async () => {
  sandbox();
  seed("2026-11-01");
  const { fn } = fakeFetch(() => new Response(JSON.stringify({ error: "bad" }), { status: 200 }));
  expect(await reportUsageIfDue({ surface: "cli" }, { ...NOW, fetch: fn })).toBe(false);
});

test("the cli event counts the complete UTC days since the last report, and carries nothing identifying", async () => {
  sandbox();
  seed("2026-11-01", [
    { day: "2026-11-17", command: ["search"], source: "user", attempts: 3, failures: 1 },
    { day: "2026-11-18", command: ["search"], source: "agent", attempts: 4 },
    { day: "2026-11-18", command: ["show"], source: "agent", attempts: 2 },
    { day: "2026-11-19", command: ["doctor", "metrics"], source: "task", attempts: 5 },
    { day: "2026-11-20", command: ["search"], source: "user", attempts: 99 }, // today: not complete
    { day: "2026-11-16", command: ["add"], source: "user", attempts: 50 }, // before the last report
  ]);
  const db = openUsage();
  db.prepare("INSERT INTO cli_usage_meta VALUES ('report.cli.last_day', '2026-11-16')").run();
  db.close();
  const { fn, sent } = fakeFetch();
  expect(await reportUsageIfDue({ surface: "cli", version: "0.10.9" }, { ...NOW, fetch: fn })).toBe(true);
  const { props, systemProps, eventName, sessionId, timestamp } = sent[0]?.body as {
    props: Record<string, number>;
    systemProps: Record<string, unknown>;
    eventName: string;
    sessionId: string;
    timestamp: string;
  };
  expect(eventName).toBe("cli_daily");
  expect(props).toMatchObject({
    period_days: 3,
    commands: 14,
    failures: 1,
    src_user: 3,
    src_agent: 6,
    src_task: 5,
    src_improve: 0,
    cmd_search: 7,
    cmd_show: 2,
    cmd_doctor: 5,
  });
  expect(props.cmd_add).toBeUndefined();
  expect(timestamp).toBe(TODAY.toISOString());
  expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);
  expect(systemProps).toMatchObject({
    isDebug: false,
    appVersion: "0.10.9",
    sdkVersion: "akm@0.10.9",
    engineName: process.versions.bun ? "bun" : "node",
  });
  expect(["Linux", "macOS", "Windows"]).toContain(String(systemProps.osName));
  const text = JSON.stringify(sent[0]?.body);
  expect(text).not.toContain("1111");
  expect(text).not.toContain("query");
  expect(text).not.toContain("instance");
});

test("payload limits: flat, string-or-number props, names within the server's bounds", async () => {
  const storage = sandbox();
  seed("2026-11-01", [{ day: "2026-11-19", command: ["a-".repeat(40)], source: "user", attempts: 1 }]);
  const other = path.join(storage.root, "other-bundle");
  fs.mkdirSync(other);
  writeSandboxConfig({ bundles: { one: { path: storage.stashDir }, two: { path: other, enabled: false } } });
  const { fn, sent } = fakeFetch();
  await reportUsageIfDue({ surface: "cli" }, { ...NOW, fetch: fn });
  const body = sent[0]?.body as { eventName: string; sessionId: string; props: Record<string, unknown> };
  expect(body.eventName.length).toBeLessThanOrEqual(60);
  expect(body.sessionId.length).toBeLessThanOrEqual(36);
  for (const [key, value] of Object.entries(body.props)) {
    expect(key.length).toBeLessThanOrEqual(40);
    expect(["string", "number"]).toContain(typeof value);
  }
  expect(body.props.bundles).toBe(1); // the disabled bundle is not counted
  expect(body.props.assets).toBeUndefined(); // no index: the snapshot is omitted, and none is built
});

test("the desktop event carries the library snapshot and no command counts", async () => {
  sandbox();
  seed("2026-11-01", [{ day: "2026-11-19", command: ["search"], source: "user", attempts: 1 }]);
  const { fn, sent } = fakeFetch();
  await reportUsageIfDue({ surface: "desktop" }, { ...NOW, fetch: fn });
  const props = sent[0]?.body.props as Record<string, unknown>;
  expect(props.commands).toBeUndefined();
  expect(Object.keys(props).some((key) => key.startsWith("cmd_"))).toBe(false);
});

test("asset counts are named only for akm's own types; every other type is counted as assets_other", async () => {
  const storage = sandbox();
  seed("2026-11-01");
  const db = openIndexDatabase(getDbPath());
  try {
    for (const [name, type] of [
      ["a", "skill"],
      ["b", "skill"],
      ["c", "memory"],
      ["d", "acme-private-notes"],
      ["e", "Odd Type/with.stuff"],
    ] as const) {
      upsertEntry(
        db,
        path.join(storage.stashDir, `${name}.md`),
        { name, type },
        deriveEntryProvenance({ bundleId: "stash", componentId: "stash", adapterId: "akm" }, type, name),
      );
    }
  } finally {
    closeDatabase(db);
  }
  const { fn, sent } = fakeFetch();
  await reportUsageIfDue({ surface: "desktop" }, { ...NOW, fetch: fn });
  const props = sent[0]?.body.props as Record<string, number>;
  expect(props).toMatchObject({ assets: 5, assets_skill: 2, assets_memory: 1, assets_other: 2 });
  expect(
    Object.keys(props)
      .filter((key) => key.startsWith("assets_"))
      .sort(),
  ).toEqual(["assets_memory", "assets_other", "assets_skill"]);
  expect(JSON.stringify(sent[0]?.body)).not.toContain("acme");
  expect(JSON.stringify(sent[0]?.body)).not.toContain("Odd");
});

test("usage.report: false sends nothing and claims nothing", async () => {
  sandbox();
  seed("2026-11-01");
  writeSandboxConfig({ usage: { report: false } });
  const { fn, sent } = fakeFetch();
  expect(await reportUsageIfDue({ surface: "cli" }, { ...NOW, fetch: fn })).toBe(false);
  expect(sent).toHaveLength(0);
  expect(lastDay("cli")).toBeUndefined();
});

test("a config that cannot be parsed sends nothing, and the command still succeeds", () => {
  sandbox();
  seed("2026-11-01");
  const configPath = path.join(process.env.XDG_CONFIG_HOME ?? "", "akm", "config.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, "{ not json");
  const { NODE_ENV: _n, BUN_TEST: _b, CI: _c, ...base } = process.env;
  const result = spawnSync("bun", [CLI, "--version"], { encoding: "utf8", timeout: 30000, env: base });
  expect(result.status).toBe(0);
  expect(lastDay("cli")).toBeUndefined();
});

test("a usage.report value that is not a boolean makes the config unloadable, so nothing is sent", async () => {
  sandbox();
  seed("2026-11-01");
  writeSandboxConfig({ usage: { report: "no" } });
  const { fn, sent } = fakeFetch();
  expect(await reportUsageIfDue({ surface: "cli" }, { ...NOW, fetch: fn })).toBe(false);
  expect(sent).toHaveLength(0);
});

test("CI and test runs never reach the network, even with a due day", async () => {
  sandbox();
  seed("2026-11-01");
  const { fn, sent } = fakeFetch();
  for (const env of [{ CI: "true" }, { NODE_ENV: "test" }, { BUN_TEST: "1" }]) {
    expect(await reportUsageIfDue({ surface: "cli" }, { now: TODAY, env, fetch: fn })).toBe(false);
  }
  // No injected env: this very process is a `bun test` run.
  expect(await reportUsageIfDue({ surface: "cli" }, { now: TODAY, fetch: fn })).toBe(false);
  expect(sent).toHaveLength(0);
  expect(lastDay("cli")).toBeUndefined();
});

test("a send that hangs is cut off at the timeout", async () => {
  sandbox();
  seed("2026-11-01");
  const hanging = ((_url: string, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    })) as unknown as typeof fetch;
  const started = Date.now();
  expect(await reportUsageIfDue({ surface: "cli" }, { ...NOW, fetch: hanging, timeoutMs: 100 })).toBe(false);
  expect(Date.now() - started).toBeLessThan(1500);
});

// Spawned children can replace the environment, so the day claim is the proof that nothing would be sent.
const CLI = path.resolve(import.meta.dir, "../../src/cli.ts");
test("a spawned CLI with a bare environment in a fresh data directory reports nothing, silently", () => {
  const storage = sandbox();
  const result = spawnSync("bun", [CLI, "--version"], {
    encoding: "utf8",
    timeout: 30000,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: storage.root,
      XDG_CONFIG_HOME: path.join(storage.root, "xdg-config"),
      XDG_DATA_HOME: path.join(storage.root, "xdg-data"),
      XDG_CACHE_HOME: path.join(storage.root, "xdg-cache"),
    },
  });
  expect(result.status).toBe(0);
  expect(result.stderr).toBe("");
  const db = openUsage(path.join(storage.root, "xdg-data", "akm", "metrics.db"));
  try {
    expect(db.prepare("SELECT 1 FROM cli_usage_meta WHERE key LIKE 'report.%'").get()).toBeFalsy();
  } finally {
    db.close();
  }
});

test("Desktop's operation is the same report: it sends nothing under test", async () => {
  sandbox();
  seed("2026-11-01");
  expect(await workspace.activity.reportUsage()).toBe(false);
  expect(lastDay("desktop")).toBeUndefined();
});

test("a spawned CLI in a due store claims nothing under CI or the test environment", () => {
  sandbox();
  seed("2026-11-01");
  const run = (env: NodeJS.ProcessEnv) =>
    spawnSync("bun", [CLI, "--version"], { encoding: "utf8", timeout: 30000, env });
  const { NODE_ENV: _n, BUN_TEST: _b, CI: _c, ...base } = process.env;
  for (const env of [
    { ...base, NODE_ENV: "test" },
    { ...base, CI: "1" },
  ]) {
    const result = run(env);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(lastDay("cli")).toBeUndefined();
  }
});
