// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { openUsage, readUsage, type UsageCommand } from "../../src/cli/usage";
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

type Event = {
  timestamp: string;
  sessionId: string;
  eventName: string;
  systemProps: Record<string, unknown>;
  props: Record<string, number>;
};
type Sent = { url: string; init: RequestInit; events: Event[] };
function fakeFetch(reply: () => Response = () => new Response("{}", { status: 200 })) {
  const sent: Sent[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(url), init: init ?? {}, events: JSON.parse(String(init?.body)) });
    return reply();
  }) as unknown as typeof fetch;
  return { fn, sent };
}
const events = (sent: Sent[]) => sent.flatMap((request) => request.events);
const event = (sent: Sent[], name: string) => events(sent).find((each) => each.eventName === name);

/** A command tree like the CLI's: what the report checks every recorded command and flag against. */
const TREE: UsageCommand = {
  args: { format: { type: "string" }, detail: { type: "string" }, quiet: { type: "boolean" } },
  subCommands: {
    search: { args: { query: { type: "positional" }, type: { type: "string" }, limit: { type: "string" } } },
    show: { args: { ref: { type: "positional" } } },
    improve: {},
    health: {},
    run: { args: { ref: { type: "positional" }, prompt: { type: "string" } } },
    doctor: { subCommands: { metrics: {} } },
    task: { subCommands: { run: { args: { mode: { type: "enum", options: ["now", "dry"] } } }, list: {} } },
  },
};

type SeedRow = {
  day: string;
  command: string[];
  invokedCommand?: string[];
  source: string;
  harness?: string;
  terminal?: boolean;
  arguments?: Array<{ name: string; explicit: boolean; value: string | boolean }>;
  attempts: number;
  failures?: number;
  durationMs?: number;
  outcomes?: Record<string, number>;
};
/** Seed the usage store: created on `started`, with aggregate rows for the given days. */
function seed(started: string, rows: SeedRow[] = []) {
  const db = openUsage();
  try {
    db.prepare("UPDATE cli_usage_meta SET value=? WHERE key='collectionStart'").run(`${started}T00:00:00.000Z`);
    for (const [index, row] of rows.entries()) {
      const dimensions = JSON.stringify({
        day: row.day,
        version: "0.10.0",
        source: row.source,
        ...(row.harness ? { harness: row.harness } : {}),
        ...(row.terminal ? { terminal: true } : {}),
        instance: "11111111-1111-1111-1111-111111111111",
        command: row.command,
        invokedCommand: row.invokedCommand ?? row.command,
        arguments: row.arguments ?? [{ name: "query", explicit: true, value: "[redacted]" }],
      });
      db.prepare(
        "INSERT INTO cli_usage_aggregates(key,dimensions,attempts,completed,failures,duration_ms,outcomes) VALUES (?,?,?,?,?,?,?)",
      ).run(
        `${index}`,
        dimensions,
        row.attempts,
        row.attempts,
        row.failures ?? 0,
        row.durationMs ?? 0,
        JSON.stringify(row.outcomes ?? {}),
      );
    }
  } finally {
    db.close();
  }
}
/** Set one `cli_usage_meta` row, as an earlier report would have left it. */
function setRow(key: string, value: string) {
  const db = openUsage();
  try {
    db.prepare("INSERT INTO cli_usage_meta VALUES (?, ?)").run(key, value);
  } finally {
    db.close();
  }
}
const metaRow = (key: string) => {
  const db = openUsage();
  try {
    return (db.prepare("SELECT value FROM cli_usage_meta WHERE key=?").get(key) as { value: string } | undefined)
      ?.value;
  } finally {
    db.close();
  }
};
const lastDay = (surface: string) => metaRow(`report.${surface}.last_day`);

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
  const report = { surface: "cli", version: "0.10.9", commands: TREE } as const;
  expect(await reportUsageIfDue(report, { ...NOW, fetch: fn })).toBe(true);
  expect(await reportUsageIfDue(report, { ...NOW, fetch: fn })).toBe(false);
  expect(sent).toHaveLength(1);
  expect(lastDay("cli")).toBe("2026-11-20");
  // Nothing is counted before the first accepted report: the daily event goes alone.
  expect(events(sent).map((each) => each.eventName)).toEqual(["cli_daily"]);
  expect(event(sent, "cli_daily")?.props).toMatchObject({ period_days: 0, commands: 0 });
  expect(readUsage().report.cli).toMatchObject({ through: "2026-11-19", last_outcome: "sent", last_detail: "" });
  expect(sent[0]?.url).toBe("https://reporting.fwdslsh.dev/api/v0/events");
  expect(sent[0]?.init.method).toBe("POST");
  expect(sent[0]?.init.headers).toEqual({ "App-Key": "A-SH-4111202318", "Content-Type": "application/json" });
  const next = new Date("2026-11-21T00:00:01Z");
  expect(await reportUsageIfDue(report, { ...NOW, now: next, fetch: fn })).toBe(true);
  expect(sent).toHaveLength(2);
});

test("the cli and desktop surfaces claim their own day", async () => {
  sandbox();
  seed("2026-11-01");
  const { fn, sent } = fakeFetch();
  expect(await reportUsageIfDue({ surface: "cli" }, { ...NOW, fetch: fn })).toBe(true);
  expect(await reportUsageIfDue({ surface: "desktop" }, { ...NOW, fetch: fn })).toBe(true);
  expect(events(sent).map((each) => each.eventName)).toEqual(["cli_daily", "desktop_daily"]);
  const { desktop } = readUsage().report;
  expect(desktop).toMatchObject({ last_day: "2026-11-20", last_outcome: "sent" });
  expect(desktop?.through).toBeUndefined(); // Desktop sends a snapshot, not counts of past days
});

test("the install id is a random UUID made for the report: the same on every event, day and surface", async () => {
  sandbox();
  seed("2026-11-01", [{ day: "2026-11-20", command: ["search"], source: "user", attempts: 1 }]);
  const { fn, sent } = fakeFetch();
  await reportUsageIfDue({ surface: "cli", commands: TREE }, { ...NOW, fetch: fn });
  await reportUsageIfDue({ surface: "desktop" }, { ...NOW, fetch: fn });
  const tomorrow = new Date("2026-11-21T08:00:00Z");
  await reportUsageIfDue({ surface: "cli", commands: TREE }, { ...NOW, now: tomorrow, fetch: fn });
  const install = metaRow("report.install") as string;
  expect(install).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(install).not.toBe(metaRow("instance"));
  expect(events(sent).map((each) => each.eventName)).toEqual(["cli_daily", "desktop_daily", "cli_daily", "akm search"]);
  expect(new Set(events(sent).map((each) => each.sessionId))).toEqual(new Set([install]));
  // It is not part of what `akm doctor metrics usage` prints, which people paste into issues.
  expect(JSON.stringify(readUsage())).not.toContain(install);
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

test("a failed send is not retried that day; the next day's report counts the days it missed", async () => {
  sandbox();
  seed("2026-11-01", [
    { day: "2026-11-19", command: ["search"], source: "user", attempts: 2 },
    { day: "2026-11-20", command: ["show"], source: "user", attempts: 3 },
  ]);
  setRow("report.cli.through", "2026-11-18");
  const failing = fakeFetch(() => new Response("nope", { status: 500 }));
  const report = { surface: "cli", commands: TREE } as const;
  expect(await reportUsageIfDue(report, { ...NOW, fetch: failing.fn })).toBe(false);
  expect(readUsage().report.cli).toEqual({
    last_day: "2026-11-20",
    through: "2026-11-18",
    last_outcome: "rejected",
    last_detail: "HTTP 500: nope",
  });
  const sameDay = fakeFetch();
  expect(await reportUsageIfDue(report, { ...NOW, fetch: sameDay.fn })).toBe(false);
  expect(sameDay.sent).toHaveLength(0);
  const next = fakeFetch();
  const tomorrow = new Date("2026-11-21T08:00:00Z");
  expect(await reportUsageIfDue(report, { ...NOW, now: tomorrow, fetch: next.fn })).toBe(true);
  expect(event(next.sent, "cli_daily")?.props).toMatchObject({ period_days: 2, commands: 5 });
  expect(event(next.sent, "akm search")?.props).toMatchObject({ period_days: 2, count: 2 });
  expect(event(next.sent, "akm show")?.props).toMatchObject({ period_days: 2, count: 3 });
  expect(readUsage().report.cli).toMatchObject({ through: "2026-11-20", last_outcome: "sent" });
});

test("a 200 whose body carries an error is a rejection: an App-Key the server does not know", async () => {
  sandbox();
  seed("2026-11-01");
  const error = "Application not found with given app key: X. Events are not being recorded.";
  const { fn } = fakeFetch(() => new Response(JSON.stringify({ error }), { status: 200 }));
  expect(await reportUsageIfDue({ surface: "cli" }, { ...NOW, fetch: fn })).toBe(false);
  expect(readUsage().report.cli).toEqual({ last_day: "2026-11-20", last_outcome: "rejected", last_detail: error });
});

test("the cli report counts the complete UTC days after the last accepted one: totals, and one event per command as typed", async () => {
  sandbox();
  seed("2026-11-01", [
    {
      day: "2026-11-17",
      command: ["search"],
      source: "user",
      attempts: 3,
      failures: 1,
      durationMs: 600,
      arguments: [
        { name: "query", explicit: true, value: "[redacted]" },
        { name: "type", explicit: true, value: "skill" },
        { name: "format", explicit: true, value: "json" },
        { name: "limit", explicit: true, value: "[redacted]" },
        { name: "limit", explicit: true, value: "[redacted]" }, // given twice in one run: one use
        { name: "detail", explicit: false, value: "brief" }, // a default, not a use
      ],
      outcomes: { "success:0:unresolved": 2, "usage:2:unresolved": 1 },
    },
    { day: "2026-11-18", command: ["search"], source: "agent", harness: "claude", attempts: 4 },
    {
      day: "2026-11-18",
      command: ["show"],
      source: "agent",
      harness: "codex",
      attempts: 2,
      outcomes: { "success:0:skill": 1, "general:1:unresolved": 1 },
    },
    // Typed `akm health`, which the store files under `doctor`: the event is the spelling that was typed.
    { day: "2026-11-19", command: ["doctor"], invokedCommand: ["health"], source: "task", attempts: 5 },
    {
      day: "2026-11-19",
      command: ["task", "run"],
      source: "unknown",
      attempts: 1,
      arguments: [{ name: "mode", explicit: true, value: "dry" }],
    },
    // No source and no harness, at a terminal: counted apart from the other unknowns, and not called `user`.
    { day: "2026-11-19", command: ["task", "run"], source: "unknown", terminal: true, attempts: 2 },
    { day: "2026-11-19", command: ["search"], source: "agent", harness: "claude", terminal: true, attempts: 1 },
    { day: "2026-11-20", command: ["search"], source: "user", attempts: 99 }, // today: not complete
    { day: "2026-11-15", command: ["improve"], source: "user", attempts: 50 }, // already accepted
  ]);
  setRow("report.cli.through", "2026-11-15");
  const { fn, sent } = fakeFetch();
  expect(await reportUsageIfDue({ surface: "cli", version: "0.10.9", commands: TREE }, { ...NOW, fetch: fn })).toBe(
    true,
  );
  expect(
    events(sent)
      .map((each) => each.eventName)
      .sort(),
  ).toEqual(["akm health", "akm search", "akm show", "akm task run", "cli_daily"]);
  expect(event(sent, "cli_daily")?.props).toMatchObject({
    period_days: 4,
    commands: 18,
    failures: 1,
    src_user: 3,
    src_agent: 7,
    src_task: 5,
    src_improve: 0,
    src_audit: 0,
    src_unknown: 1,
    src_terminal: 2,
    h_claude: 5,
    h_codex: 2,
  });
  expect(event(sent, "akm search")?.props).toEqual({
    period_days: 4,
    count: 8,
    failures: 1,
    duration_ms: 600,
    src_user: 3,
    src_agent: 5,
    h_claude: 5,
    flag_type: 3,
    flag_type_skill: 3,
    flag_format: 3,
    flag_format_json: 3,
    flag_limit: 3,
    out_usage: 1,
  });
  expect(event(sent, "akm show")?.props).toEqual({
    period_days: 4,
    count: 2,
    failures: 0,
    duration_ms: 0,
    src_agent: 2,
    h_codex: 2,
    out_general: 1,
    type_skill: 1,
  });
  expect(event(sent, "akm health")?.props).toMatchObject({ count: 5, src_task: 5 });
  expect(event(sent, "akm task run")?.props).toMatchObject({
    count: 3,
    src_unknown: 1,
    src_terminal: 2,
    flag_mode: 1,
    flag_mode_dry: 1,
  });
  const daily = event(sent, "cli_daily") as Event;
  expect(daily.timestamp).toBe(TODAY.toISOString());
  expect(daily.systemProps).toMatchObject({
    isDebug: false,
    appVersion: "0.10.9",
    sdkVersion: "akm@0.10.9",
    engineName: process.versions.bun ? "bun" : "node",
  });
  expect(["Linux", "macOS", "Windows"]).toContain(String(daily.systemProps.osName));
  // Only the numbers of the OS release, and only the language, script and region of the locale.
  expect(String(daily.systemProps.osVersion)).toMatch(/^(\d+(\.\d+){0,2})?$/);
  expect(String(daily.systemProps.locale)).toMatch(/^([a-z]{2,3}(-[A-Z][a-z]{3})?(-[A-Z]{2})?)?$/);
});

test("reported every day, each report counts the day before it", async () => {
  sandbox();
  seed("2026-11-01", [
    { day: "2026-11-18", command: ["show"], source: "user", attempts: 9 }, // accepted in the report sent on 2026-11-19
    { day: "2026-11-19", command: ["search"], source: "agent", attempts: 4 },
    { day: "2026-11-19", command: ["improve"], source: "improve", attempts: 2 },
    { day: "2026-11-20", command: ["search"], source: "user", attempts: 99 }, // today: not complete
  ]);
  setRow("report.cli.last_day", "2026-11-19");
  setRow("report.cli.through", "2026-11-18");
  const { fn, sent } = fakeFetch();
  expect(await reportUsageIfDue({ surface: "cli", commands: TREE }, { ...NOW, fetch: fn })).toBe(true);
  expect(event(sent, "cli_daily")?.props).toMatchObject({
    period_days: 1,
    commands: 6,
    src_user: 0,
    src_agent: 4,
    src_improve: 2,
  });
  expect(event(sent, "akm search")?.props).toMatchObject({ period_days: 1, count: 4 });
  expect(event(sent, "akm improve")?.props).toMatchObject({ period_days: 1, count: 2 });
  expect(event(sent, "akm show")).toBeUndefined();
});

test("nothing a person or their library named is sent: only akm's own names, and numbers", async () => {
  const storage = sandbox();
  const other = path.join(storage.root, "acme-other");
  fs.mkdirSync(other);
  writeSandboxConfig({
    bundles: {
      "acme-notes": { path: storage.stashDir },
      "acme-shared": { git: "https://git.acme-corp.example/team/private-notes.git" },
      "acme-off": { path: other, enabled: false },
    },
    connections: { "acme-llm": { endpoint: "https://llm.acme-corp.example/v1" } },
    scheduler: { enabled: ["acme-notes//tasks/nightly-customer-sync"] },
    experimental: { exec: true },
  });
  seed("2026-11-01", [
    {
      day: "2026-11-19",
      command: ["search"],
      source: "acme-source",
      harness: "acme-private-harness",
      attempts: 2,
      arguments: [
        { name: "query", explicit: true, value: "customer acme renewal" },
        { name: "type", explicit: true, value: "acme-notes" }, // a custom type's name: counted, not named
        { name: "acme-input", explicit: true, value: "acme" }, // not a flag akm declares
      ],
      outcomes: { "success:0:acme-type": 1, "acme-category:9:unresolved": 1 },
    },
    { day: "2026-11-19", command: ["acme-internal-tool", "deploy"], source: "user", attempts: 1 },
    { day: "2026-11-19", command: ["task", "acme-nightly"], source: "user", attempts: 1 },
    { day: "2026-11-19", command: ["a-".repeat(40)], source: "user", attempts: 1 },
  ]);
  setRow("report.cli.through", "2026-11-18");
  const { fn, sent } = fakeFetch();
  expect(await reportUsageIfDue({ surface: "cli", commands: TREE }, { ...NOW, fetch: fn })).toBe(true);
  await reportUsageIfDue({ surface: "desktop" }, { ...NOW, fetch: fn });

  const text = JSON.stringify(sent.map((request) => request.events));
  for (const theirs of ["acme", "customer", "nightly", "private", "deploy", storage.root, "1111", "instance"])
    expect(text).not.toContain(theirs);
  expect(new Set(events(sent).map((each) => each.eventName))).toEqual(
    new Set(["cli_daily", "desktop_daily", "akm search", "akm [unknown]", "akm task [unknown]"]),
  );
  expect(event(sent, "akm search")?.props).toEqual({
    period_days: 1,
    count: 2,
    failures: 0,
    duration_ms: 0,
    src_unknown: 2,
    h_other: 2,
    flag_type: 2,
    out_failure: 1,
    type_other: 1,
  });
  expect(event(sent, "akm [unknown]")?.props).toMatchObject({ count: 2 });
  // Within the server's bounds, and every prop a number under a name made of akm's own words.
  for (const each of events(sent)) {
    expect(each.eventName.length).toBeLessThanOrEqual(60);
    expect(each.sessionId).toBe(metaRow("report.install") as string);
    for (const [key, value] of Object.entries(each.props)) {
      expect(key).toMatch(/^[a-z][a-z0-9_-]{0,39}$/);
      expect(typeof value).toBe("number");
    }
  }
  // What is set up, as counts: the disabled bundle is not counted, and no index means no asset counts (none is built).
  expect(event(sent, "desktop_daily")?.props).toEqual({
    bundles: 2,
    bundles_git: 1,
    bundles_website: 0,
    bundles_npm: 0,
    registries: 2, // akm's own two defaults
    connections: 1,
    harnesses: 0,
    projects: 0,
    tasks_enabled: 1,
    semantic_search: 0,
    improve: 1,
    exec: 1,
  });
  expect(event(sent, "cli_daily")?.props).toMatchObject({ bundles: 2, tasks_enabled: 1, commands: 5 });
});

test("a report over 25 events goes in several requests under the one limit, and is accepted only if all are", async () => {
  sandbox();
  const tree: UsageCommand = { subCommands: {} };
  const rows: SeedRow[] = [];
  for (let n = 0; n < 30; n++) {
    (tree.subCommands as Record<string, UsageCommand>)[`c${n}`] = {};
    rows.push({ day: "2026-11-19", command: [`c${n}`], source: "user", attempts: 1 });
  }
  seed("2026-11-01", rows);
  setRow("report.cli.through", "2026-11-18");
  let calls = 0;
  const flaky = fakeFetch(() => new Response(calls++ === 0 ? "{}" : "busy", { status: calls === 1 ? 200 : 503 }));
  expect(await reportUsageIfDue({ surface: "cli", commands: tree }, { ...NOW, fetch: flaky.fn })).toBe(false);
  expect(flaky.sent.map((request) => request.events.length)).toEqual([25, 6]);
  expect(readUsage().report.cli).toMatchObject({ through: "2026-11-18", last_outcome: "rejected" });
  const { fn, sent } = fakeFetch();
  const tomorrow = new Date("2026-11-21T08:00:00Z");
  expect(await reportUsageIfDue({ surface: "cli", commands: tree }, { ...NOW, now: tomorrow, fetch: fn })).toBe(true);
  expect(events(sent)).toHaveLength(31);
  expect(readUsage().report.cli).toMatchObject({ through: "2026-11-20", last_outcome: "sent" });
});

test("the desktop report is one event: what is set up and the library, with no command counts", async () => {
  sandbox();
  seed("2026-11-01", [{ day: "2026-11-19", command: ["search"], source: "user", attempts: 1 }]);
  const { fn, sent } = fakeFetch();
  await reportUsageIfDue({ surface: "desktop" }, { ...NOW, fetch: fn });
  expect(events(sent).map((each) => each.eventName)).toEqual(["desktop_daily"]);
  const props = event(sent, "desktop_daily")?.props as Record<string, number>;
  expect(props.commands).toBeUndefined();
  expect(props.bundles).toBeGreaterThanOrEqual(0);
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
  const props = event(sent, "desktop_daily")?.props as Record<string, number>;
  expect(props).toMatchObject({ assets: 5, assets_skill: 2, assets_memory: 1, assets_other: 2 });
  expect(
    Object.keys(props)
      .filter((key) => key.startsWith("assets_"))
      .sort(),
  ).toEqual(["assets_memory", "assets_other", "assets_skill"]);
  expect(JSON.stringify(sent[0]?.events)).not.toContain("acme");
  expect(JSON.stringify(sent[0]?.events)).not.toContain("Odd");
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

function writeLayers(base: Record<string, unknown>, file: Record<string, unknown>) {
  const storage = sandbox();
  seed("2026-11-01");
  const basePath = path.join(storage.root, "base.json");
  fs.writeFileSync(basePath, JSON.stringify(base));
  writeSandboxConfig({ extends: basePath, ...file });
  resetConfigCache();
}

test("usage.report: false in an extended base turns the report off, and config.get() says so", async () => {
  writeLayers({ usage: { report: false } }, {});
  const { fn, sent } = fakeFetch();
  expect(await reportUsageIfDue({ surface: "cli" }, { ...NOW, fetch: fn })).toBe(false);
  expect(sent).toHaveLength(0);
  expect(lastDay("cli")).toBeUndefined();
  expect(workspace.config.get().config.usage).toMatchObject({ report: false });
});

test("a nearer layer's usage.report: true overrides false in the base", async () => {
  writeLayers({ usage: { report: false } }, { usage: { report: true } });
  const { fn, sent } = fakeFetch();
  expect(await reportUsageIfDue({ surface: "cli" }, { ...NOW, fetch: fn })).toBe(true);
  expect(sent).toHaveLength(1);
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
  expect(readUsage().report.cli).toMatchObject({ last_outcome: "failed", last_detail: "no answer within 100 ms" });
  expect(readUsage().report.cli?.through).toBeUndefined();
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
