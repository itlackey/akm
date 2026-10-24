import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { akmEventsList } from "../../../src/commands/log";
import { saveConfig } from "../../../src/core/config/config";
import { appendEvent, readEvents } from "../../../src/core/events";
import { getStateDbPath } from "../../../src/core/state-db";
import { runCliCapture } from "../../_helpers/cli";
import { type Cleanup, sandboxStashDir, sandboxXdgDataHome } from "../../_helpers/sandbox";

// Migrated from per-test spawnSync("bun", [CLI, ...]) to the in-process harness
// (tests/_helpers/cli.ts) where faithful. The pure appendEvent/readEvents/
// akmEventsList tests use an explicit dbPath ctx and are untouched. The
// "akm CLI mutation events" tests now drive the CLI in-process: they seed
// state.db at the sandboxed getDbPath() and the harness captures stdout/stderr.
//
// The one test whose contract is a real exec boundary ("log --since
// @offset:N resumes across a real process boundary") lives in
// tests/integration/events-offset-crossproc.test.ts.
//
// 0.9.0 CLI overhaul (S3): `log tail` (and `akmEventsTail`/`tailEvents`) was
// dropped — a foreground polling daemon in a one-shot CLI. `log` is now a
// leaf command (this file's `["log", ...]` invocations no longer pass a
// `list` subcommand token).

const tempDirs: string[] = [];
let stashCleanup: Cleanup = () => {};

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function sandboxStash(): string {
  const stash = sandboxStashDir();
  stashCleanup = stash.cleanup;
  saveConfig({
    semanticSearchMode: "off",
    bundles: { stash: { path: stash.dir, writable: true } },
    defaultBundle: "stash",
  });
  return stash.dir;
}

/**
 * Like {@link sandboxStash}, but also isolates `XDG_DATA_HOME` (and so
 * `state.db`, per `src/core/paths.ts`'s `getDataDir`). `sandboxStash` alone
 * only sandboxes `AKM_BUNDLE_DIR`, so the tests above that use it tolerate
 * events accumulating across tests in this file (they assert `.toContain(...)`
 * / `>= 1`, never exact counts). The `--limit` tests below assert EXACT
 * counts and exact "most recent N" contents, so they need a state.db that
 * starts empty every time.
 */
function sandboxIsolatedStash(): string {
  const stash = sandboxStashDir();
  const data = sandboxXdgDataHome(stash.cleanup);
  stashCleanup = data.cleanup;
  saveConfig({
    semanticSearchMode: "off",
    bundles: { stash: { path: stash.dir, writable: true } },
    defaultBundle: "stash",
  });
  return stash.dir;
}

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

async function runCli(args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const { code, stdout, stderr } = await runCliCapture(args);
  return { status: code, stdout, stderr };
}

afterEach(() => {
  stashCleanup();
  stashCleanup = () => {};
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("appendEvent / readEvents", () => {
  test("appends events readable via readEvents (state.db backend)", () => {
    const dbPath = path.join(makeTempDir("akm-events-"), "state.db");
    let now = 1_700_000_000_000;
    const ctx = { dbPath, now: () => now };

    appendEvent({ eventType: "remember", ref: "memory:alpha", metadata: { tagCount: 2 } }, ctx);
    now += 1000;
    appendEvent({ eventType: "feedback", ref: "memory:alpha", metadata: { signal: "positive" } }, ctx);

    // Events are now stored in state.db — read back via readEvents().
    const result = readEvents({}, ctx);
    expect(result.events).toHaveLength(2);
    const first = result.events[0];
    expect(first?.eventType).toBe("remember");
    expect(first?.ref).toBe("memory:alpha");
    expect(first?.schemaVersion).toBe(1);
    expect(typeof first?.ts).toBe("string");
  });

  test("readEvents returns parsed envelopes with monotonic rowid cursors", () => {
    const dbPath = path.join(makeTempDir("akm-events-"), "state.db");
    const ctx = { dbPath };
    appendEvent({ eventType: "add", metadata: { target: "user/repo" } }, ctx);
    appendEvent({ eventType: "remove", metadata: { target: "user/repo" } }, ctx);

    const result = readEvents({}, ctx);
    expect(result.events).toHaveLength(2);
    expect(result.events[0]?.eventType).toBe("add");
    expect(result.events[1]?.eventType).toBe("remove");
    // ids are monotonic SQLite rowids; second must be larger than first
    expect((result.events[1]?.id ?? 0) > (result.events[0]?.id ?? 0)).toBe(true);
    // nextOffset is the max rowid seen — always >= the last event's id
    expect(result.nextOffset).toBeGreaterThanOrEqual(result.events[1]?.id ?? 0);
  });

  test("--since offset is durable across processes", () => {
    const dbPath = path.join(makeTempDir("akm-events-"), "state.db");
    const ctx = { dbPath };
    appendEvent({ eventType: "remember", ref: "memory:a" }, ctx);
    const cursor = readEvents({}, ctx).nextOffset;
    // Simulate "another process" appending more events
    appendEvent({ eventType: "remember", ref: "memory:b" }, ctx);
    appendEvent({ eventType: "remember", ref: "memory:c" }, ctx);

    const next = readEvents({ sinceOffset: cursor }, ctx);
    expect(next.events.map((e) => e.ref)).toEqual(["memory:b", "memory:c"]);

    // Resuming from the new cursor yields no events when nothing was added.
    const empty = readEvents({ sinceOffset: next.nextOffset }, ctx);
    expect(empty.events).toEqual([]);
    expect(empty.nextOffset).toBe(next.nextOffset);
  });

  test("`akm log list --since @offset:` rejects malformed cursors", () => {
    const dbPath = path.join(makeTempDir("akm-events-"), "state.db");
    const ctx = { dbPath };
    expect(() => akmEventsList({ since: "@offset:not-a-number", ctx })).toThrow(/Invalid --since offset/);
    expect(() => akmEventsList({ since: "@offset:-3", ctx })).toThrow(/Invalid --since/);
  });

  test("--since (timestamp) filter is monotonic across processes", () => {
    const dbPath = path.join(makeTempDir("akm-events-"), "state.db");
    let now = 1_700_000_000_000;
    const ctx = { dbPath, now: () => now };
    appendEvent({ eventType: "remember", ref: "memory:a" }, ctx);
    const cutoff = new Date(now + 500).toISOString();
    now += 1000;
    appendEvent({ eventType: "remember", ref: "memory:b" }, ctx);

    const result = akmEventsList({ since: cutoff, ctx });
    expect(result.totalCount).toBe(1);
    expect(result.events[0]?.ref).toBe("memory:b");
  });

  test("--type and --ref filters work in combination", () => {
    const dbPath = path.join(makeTempDir("akm-events-"), "state.db");
    const ctx = { dbPath };
    appendEvent({ eventType: "remember", ref: "memories/a" }, ctx);
    appendEvent({ eventType: "feedback", ref: "memories/a", metadata: { signal: "positive" } }, ctx);
    appendEvent({ eventType: "feedback", ref: "memories/b", metadata: { signal: "negative" } }, ctx);

    const filtered = akmEventsList({ type: "feedback", ref: "memories/a", ctx });
    expect(filtered.totalCount).toBe(1);
    expect(filtered.events[0]?.eventType).toBe("feedback");
    expect(filtered.events[0]?.ref).toBe("memories/a");
  });

  // D-38: `akm log list --limit` was documented (docs/reference/data-and-telemetry.md)
  // but silently ignored — citty swallows unrecognized flags, and there was no
  // limiting mechanism anywhere in the read path (no `--limit` arg on the
  // command, no `limit` field threaded through `akmEventsList`/`readEvents`,
  // and `readStateEvents`'s SQL had no LIMIT clause at all). These tests pin
  // the real fix at every layer that plumbs it: `readStateEvents` (SQL
  // LIMIT), `readEvents` (the tag-post-filter interaction), and
  // `akmEventsList` (the CLI-facing option). CLI-level coverage (the actual
  // `akm log --limit` invocation, and the stale doc-comment this closes)
  // lives in the "log --limit (D-38)" describe block below.
  test("--limit returns the MOST RECENT N events, not the first N", () => {
    const dbPath = path.join(makeTempDir("akm-events-"), "state.db");
    const ctx = { dbPath };
    for (let i = 0; i < 10; i += 1) {
      appendEvent({ eventType: "remember", ref: `memory:${i}` }, ctx);
    }

    const result = readEvents({ limit: 3 }, ctx);
    // Most recent 3 of 10, in ascending id order (the function's documented
    // contract) — i.e. memory:7, memory:8, memory:9, NOT memory:0..2.
    expect(result.events.map((e) => e.ref)).toEqual(["memory:7", "memory:8", "memory:9"]);
    // nextOffset still reflects the true max id, unaffected by the display
    // truncation — same value an unbounded read of the same filter would
    // report, so a subsequent `--since @offset:<nextOffset>` resumes
    // correctly instead of re-serving events this call already showed.
    const unbounded = readEvents({}, ctx);
    expect(result.nextOffset).toBe(unbounded.nextOffset);
  });

  test("--limit larger than the available count returns everything (no error)", () => {
    const dbPath = path.join(makeTempDir("akm-events-"), "state.db");
    const ctx = { dbPath };
    appendEvent({ eventType: "remember", ref: "memory:a" }, ctx);
    appendEvent({ eventType: "remember", ref: "memory:b" }, ctx);

    const result = readEvents({ limit: 50 }, ctx);
    expect(result.events.map((e) => e.ref)).toEqual(["memory:a", "memory:b"]);
  });

  test("no --limit is unchanged: unlimited, full history returned", () => {
    const dbPath = path.join(makeTempDir("akm-events-"), "state.db");
    const ctx = { dbPath };
    for (let i = 0; i < 8; i += 1) {
      appendEvent({ eventType: "remember", ref: `memory:${i}` }, ctx);
    }

    const result = readEvents({}, ctx);
    expect(result.events).toHaveLength(8);
  });

  test("--limit combined with --include-tags returns N MATCHING events, not N pre-filter rows", () => {
    // This is the exact hazard the fix has to avoid: a naive SQL `LIMIT 2`
    // applied BEFORE the tag post-filter would grab the 2 most recent rows
    // regardless of tags, then filter them — which could return 0 or 1
    // tagged events even though 2+ tagged events exist further back. The fix
    // must read enough to apply the tag filter first, THEN take the most
    // recent 2 of the events that actually match.
    const dbPath = path.join(makeTempDir("akm-events-"), "state.db");
    const ctx = { dbPath };
    appendEvent({ eventType: "remember", ref: "memory:tagged-1", metadata: { tags: ["keep"] } }, ctx);
    appendEvent({ eventType: "remember", ref: "memory:untagged-1" }, ctx);
    appendEvent({ eventType: "remember", ref: "memory:tagged-2", metadata: { tags: ["keep"] } }, ctx);
    appendEvent({ eventType: "remember", ref: "memory:untagged-2" }, ctx);
    appendEvent({ eventType: "remember", ref: "memory:untagged-3" }, ctx);

    const result = readEvents({ includeTags: ["keep"], limit: 2 }, ctx);
    expect(result.events.map((e) => e.ref)).toEqual(["memory:tagged-1", "memory:tagged-2"]);
  });

  test("akmEventsList echoes `limit` in the envelope only when it was passed", () => {
    const dbPath = path.join(makeTempDir("akm-events-"), "state.db");
    const ctx = { dbPath };
    appendEvent({ eventType: "remember", ref: "memory:a" }, ctx);
    appendEvent({ eventType: "remember", ref: "memory:b" }, ctx);

    const limited = akmEventsList({ limit: 1, ctx });
    expect(limited.limit).toBe(1);
    expect(limited.totalCount).toBe(1);
    expect(limited.events.map((e) => e.ref)).toEqual(["memory:b"]);

    const unlimited = akmEventsList({ ctx });
    expect(unlimited.limit).toBeUndefined();
    expect(unlimited.totalCount).toBe(2);
  });

  test("all valid appends are readable (SQLite enforces schema integrity)", () => {
    const dbPath = path.join(makeTempDir("akm-events-"), "state.db");
    const ctx = { dbPath };
    appendEvent({ eventType: "remember", ref: "memory:a" }, ctx);
    appendEvent({ eventType: "remember", ref: "memory:b" }, ctx);

    // Unlike JSONL, SQLite guarantees no malformed rows can be inserted.
    // Both events must be present and in insertion order.
    const result = readEvents({}, ctx);
    expect(result.events.map((e) => e.ref)).toEqual(["memory:a", "memory:b"]);
  });
});

describe("akm CLI mutation events", () => {
  test("remember, feedback, and add each emit an event to state.db", async () => {
    sandboxStash();

    // ─ remember ──────────────────────────────────────────────────────────
    const remember = await runCli(["remember", "first event captured", "--name", "alpha", "--format=json"]);
    expect(remember.status).toBe(0);

    // index so feedback can find the ref
    const indexResult = await runCli(["index", "--full", "--format=json"]);
    expect(indexResult.status).toBe(0);

    // ─ feedback ──────────────────────────────────────────────────────────
    const feedback = await runCli(["feedback", "memories/alpha", "--positive", "--format=json"]);
    expect(feedback.status).toBe(0);

    // ─ bundle add (local directory source) ────────────────────────────────
    const localSource = makeTempDir("akm-events-local-");
    writeFile(path.join(localSource, "skills", "demo.md"), "# demo\n\nA demo skill.\n");
    const add = await runCli(["bundle", "add", localSource, "--format=json"]);
    expect(add.status).toBe(0);

    // Confirm events are in state.db by querying through the CLI.
    const list = await runCli(["log", "--format=json"]);
    expect(list.status).toBe(0);
    const parsed = JSON.parse(list.stdout) as { events: Array<{ eventType: string }> };
    const types = parsed.events.map((e) => e.eventType);
    expect(types).toContain("remember");
    expect(types).toContain("feedback");
    expect(types).toContain("add");
  });

  test("`akm log` returns the captured events in JSON envelope shape", async () => {
    sandboxStash();

    // Create a remember event via the CLI so state.db gets populated.
    const remember = await runCli(["remember", "another event captured", "--name", "beta", "--format=json"]);
    expect(remember.status).toBe(0);

    const list = await runCli(["log", "--format=json"]);
    expect(list.status).toBe(0);
    const parsed = JSON.parse(list.stdout) as Record<string, unknown>;
    expect(parsed.totalCount).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(parsed.events)).toBe(true);
    const events = parsed.events as Array<Record<string, unknown>>;
    expect(events.some((e) => e.eventType === "remember")).toBe(true);
  });

  test("`akm log` is the canonical command; `akm events` is no longer a command", async () => {
    sandboxStash();

    const remember = await runCli(["remember", "log is canonical", "--name", "delta", "--format=json"]);
    expect(remember.status).toBe(0);

    // 0.9.0: `log` is primary; the old `events` command was removed.
    const list = await runCli(["log", "--format=json"]);
    expect(list.status).toBe(0);
    const parsed = JSON.parse(list.stdout) as { events: Array<{ eventType: string }> };
    expect(parsed.events.some((e) => e.eventType === "remember")).toBe(true);

    // `akm events` is no longer a registered command.
    const removed = await runCli(["events", "--format=json"]);
    expect(removed.status).toBe(2);
    expect(JSON.parse(removed.stderr)).toMatchObject({ ok: false, code: "UNKNOWN_COMMAND" });
  });

  test("`akm log --type feedback` filters by event type", async () => {
    sandboxStash();

    const remember = await runCli(["remember", "filter test", "--name", "gamma", "--format=json"]);
    expect(remember.status).toBe(0);
    await runCli(["index", "--full", "--format=json"]);
    await runCli(["feedback", "memories/gamma", "--positive", "--format=json"]);

    const filtered = await runCli(["log", "--type", "feedback", "--ref", "memories/gamma", "--format=json"]);
    expect(filtered.status).toBe(0);
    const parsed = JSON.parse(filtered.stdout) as Record<string, unknown>;
    const events = parsed.events as Array<Record<string, unknown>>;
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events.every((e) => e.eventType === "feedback")).toBe(true);
  });
});

describe("log --limit (D-38)", () => {
  // The verified-live repro this closes: 26 events seeded, `akm log --limit 5
  // --format json` used to return all 26 — citty silently swallows an
  // unrecognized flag, and there was no limiting mechanism in the read path
  // at all (docs/reference/data-and-telemetry.md:267 documented `--limit`
  // for years while the CLI ignored it).
  test("`akm log --limit 5` with 26 events returns exactly 5, the most recent", async () => {
    sandboxIsolatedStash();
    const dbPath = getStateDbPath();
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const ctx = { dbPath };
    for (let i = 0; i < 26; i += 1) {
      appendEvent({ eventType: "remember", ref: `memory:${i}` }, ctx);
    }

    const result = await runCli(["log", "--limit", "5", "--format=json"]);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as { events: Array<{ ref?: string }>; totalCount: number; limit: number };
    expect(parsed.events).toHaveLength(5);
    expect(parsed.totalCount).toBe(5);
    expect(parsed.limit).toBe(5);
    // The most recent 5 of 26 (memory:0..25) are memory:21..25.
    expect(parsed.events.map((e) => e.ref)).toEqual(["memory:21", "memory:22", "memory:23", "memory:24", "memory:25"]);
  });

  test("without --limit, all 26 events are still returned (default stays unlimited)", async () => {
    sandboxIsolatedStash();
    const dbPath = getStateDbPath();
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const ctx = { dbPath };
    for (let i = 0; i < 26; i += 1) {
      appendEvent({ eventType: "remember", ref: `memory:${i}` }, ctx);
    }

    const result = await runCli(["log", "--format=json"]);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as { events: unknown[]; limit?: number };
    expect(parsed.events).toHaveLength(26);
    expect(parsed.limit).toBeUndefined();
  });

  test("`--limit 0` and `--limit -1` are rejected as usage errors, matching every other --limit flag", async () => {
    sandboxStash();

    const zero = await runCli(["log", "--limit", "0", "--format=json"]);
    expect(zero.status).toBe(2);
    expect(JSON.parse(zero.stderr)).toMatchObject({ ok: false, code: "INVALID_FLAG_VALUE" });

    const negative = await runCli(["log", "--limit", "-1", "--format=json"]);
    expect(negative.status).toBe(2);
    expect(JSON.parse(negative.stderr)).toMatchObject({ ok: false, code: "INVALID_FLAG_VALUE" });
  });
});
