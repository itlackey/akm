import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { akmEventsList, akmEventsTail } from "../../src/commands/events";
import { saveConfig } from "../../src/core/config";
import { appendEvent, readEvents, tailEvents } from "../../src/core/events";
import { getDbPath } from "../../src/core/paths";
import { runCliCapture } from "../_helpers/cli";
import { type Cleanup, sandboxStashDir } from "../_helpers/sandbox";

// Migrated from per-test spawnSync("bun", [CLI, ...]) to the in-process harness
// (tests/_helpers/cli.ts) where faithful. The pure appendEvent/readEvents/
// tailEvents/akmEventsList/akmEventsTail tests use an explicit dbPath ctx and
// are untouched. The "akm CLI mutation events" and "events tail (streaming
// trailer)" tests now drive the CLI in-process: they seed state.db at the
// sandboxed getDbPath() and the harness captures the streamed stdout/stderr
// trailer.
//
// KEPT AS A SUBPROCESS: "events list --since @offset resumes across a real
// process boundary". Its entire contract is a real exec boundary — a producer
// persists a cursor, appends MORE events, then a SEPARATE process reads from the
// cursor. In-process there is no second process, so it stays spawning via the
// local spawnCli helper (which passes env to spawnSync rather than mutating
// process.env, so it does not affect the in-process tests).

const CLI = path.join(__dirname, "..", "..", "src", "cli.ts");

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

/**
 * Subprocess runner, retained only for the cross-process @offset durability
 * test. It passes env to spawnSync rather than mutating process.env, so it does
 * not affect the in-process tests.
 */
function spawnCli(
  args: string[],
  env: Record<string, string | undefined>,
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("bun", [CLI, ...args], {
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, ...env },
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
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

  test("--since (byte offset) is durable across processes", () => {
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

  test("`akm events list --since @offset:N` resumes across a real process boundary", () => {
    // This is the cross-process durability contract: a producer writes N
    // events, persists nextOffset to a temp file, appends MORE events, and
    // then a SECOND `bun src/cli.ts events list` invocation reads the cursor
    // from the file and must emit only the post-cursor events with no
    // duplicates and no losses.
    const dataDir = makeTempDir("akm-events-xproc-data-");
    const cacheDir = makeTempDir("akm-events-xproc-cache-");
    const configDir = makeTempDir("akm-events-xproc-config-");
    const stateDir = makeTempDir("akm-events-xproc-statedir-");
    const cursorFile = path.join(makeTempDir("akm-events-xproc-state-"), "cursor.txt");
    // Drive both processes through the same XDG_DATA_HOME so they share
    // the same state.db path (events now live in state.db, not events.jsonl).
    const childEnv = {
      XDG_DATA_HOME: dataDir,
      XDG_CACHE_HOME: cacheDir,
      XDG_CONFIG_HOME: configDir,
      XDG_STATE_HOME: stateDir,
    };
    // The dbPath for the writer must match what the CLI child process resolves.
    // The CLI resolves state.db as <XDG_DATA_HOME>/akm/state.db.
    const dbPath = path.join(dataDir, "akm", "state.db");
    const ctx = { dbPath };

    // 1. Producer writes events 0..2 (the "first batch").
    appendEvent({ eventType: "remember", ref: "memory:e0" }, ctx);
    appendEvent({ eventType: "remember", ref: "memory:e1" }, ctx);
    appendEvent({ eventType: "remember", ref: "memory:e2" }, ctx);

    // 2. Producer persists nextOffset to a temp file.
    const cursor = readEvents({}, ctx).nextOffset;
    fs.writeFileSync(cursorFile, String(cursor));

    // 3. Producer appends MORE events (3..5) BEFORE the second process reads.
    appendEvent({ eventType: "remember", ref: "memory:e3" }, ctx);
    appendEvent({ eventType: "remember", ref: "memory:e4" }, ctx);
    appendEvent({ eventType: "remember", ref: "memory:e5" }, ctx);

    // 4. Spawn a SECOND bun process; it reads the cursor from the temp file
    //    and asks the CLI for events with `--since @offset:<cursor>`. This
    //    exercises a real exec boundary, not just in-process arithmetic.
    const persisted = fs.readFileSync(cursorFile, "utf8").trim();
    const child = spawnCli(["events", "list", "--since", `@offset:${persisted}`, "--format=json"], childEnv);
    expect(child.status).toBe(0);
    const parsed = JSON.parse(child.stdout) as {
      events: Array<{ ref: string }>;
      totalCount: number;
      nextOffset: number;
      sinceOffset?: number;
    };

    // 5. Assert: exactly the post-cursor events, in order, no duplicates,
    //    no losses. The pre-cursor events MUST NOT appear.
    expect(parsed.events.map((e) => e.ref)).toEqual(["memory:e3", "memory:e4", "memory:e5"]);
    expect(parsed.totalCount).toBe(3);
    expect(parsed.sinceOffset).toBe(Number(persisted));
    expect(parsed.nextOffset).toBeGreaterThan(Number(persisted));
  });

  test("`akm events list --since @offset:` rejects malformed byte cursors", () => {
    const dbPath = path.join(makeTempDir("akm-events-"), "state.db");
    const ctx = { dbPath };
    expect(() => akmEventsList({ since: "@offset:not-a-number", ctx })).toThrow(/Invalid --since byte offset/);
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
    appendEvent({ eventType: "remember", ref: "memory:a" }, ctx);
    appendEvent({ eventType: "feedback", ref: "memory:a", metadata: { signal: "positive" } }, ctx);
    appendEvent({ eventType: "feedback", ref: "memory:b", metadata: { signal: "negative" } }, ctx);

    const filtered = akmEventsList({ type: "feedback", ref: "memory:a", ctx });
    expect(filtered.totalCount).toBe(1);
    expect(filtered.events[0]?.eventType).toBe("feedback");
    expect(filtered.events[0]?.ref).toBe("memory:a");
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

describe("tailEvents", () => {
  test("emits historical events, then follows new appends until maxEvents", async () => {
    const dbPath = path.join(makeTempDir("akm-events-"), "state.db");
    const ctx = { dbPath };
    appendEvent({ eventType: "remember", ref: "memory:1" }, ctx);

    const tailPromise = tailEvents({ intervalMs: 25, maxEvents: 3, maxDurationMs: 2_000 }, ctx);
    // Give the tail loop a chance to start polling
    await new Promise((r) => setTimeout(r, 50));
    appendEvent({ eventType: "remember", ref: "memory:2" }, ctx);
    await new Promise((r) => setTimeout(r, 50));
    appendEvent({ eventType: "remember", ref: "memory:3" }, ctx);

    const result = await tailPromise;
    expect(result.events.map((e) => e.ref)).toEqual(["memory:1", "memory:2", "memory:3"]);
    expect(result.reason).toBe("maxEvents");
  });

  test("tail keeps up with a concurrent writer without losing events", async () => {
    const dbPath = path.join(makeTempDir("akm-events-"), "state.db");
    const ctx = { dbPath };
    const TOTAL = 50;

    // Writer: append TOTAL events with small jitter so the tail polling
    // intervals span multiple writes. Run concurrently with the tail.
    const writerPromise = (async () => {
      for (let i = 0; i < TOTAL; i += 1) {
        appendEvent({ eventType: "remember", ref: `memory:${i}`, metadata: { i } }, ctx);
        if (i % 5 === 0) await new Promise((r) => setTimeout(r, 5));
      }
    })();

    // Tail with maxEvents = TOTAL so we resolve as soon as we've seen
    // every event the writer produced.
    const tailPromise = tailEvents({ intervalMs: 20, maxEvents: TOTAL, maxDurationMs: 5_000 }, ctx);

    await writerPromise;
    const result = await tailPromise;

    expect(result.events).toHaveLength(TOTAL);
    // Event order matches write order (each event has a unique `i`).
    const indices = result.events.map((e) => (e.metadata as { i: number } | undefined)?.i);
    expect(indices).toEqual(Array.from({ length: TOTAL }, (_, idx) => idx));
    expect(result.reason).toBe("maxEvents");
  });

  test("tail terminates on AbortSignal", async () => {
    const dbPath = path.join(makeTempDir("akm-events-"), "state.db");
    const ctx = { dbPath };
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 80);
    const result = await tailEvents({ intervalMs: 20, signal: ac.signal, maxDurationMs: 1_000 }, ctx);
    expect(result.reason).toBe("signal");
  });
});

describe("akm CLI mutation events", () => {
  test("remember, feedback, and add each emit an event to state.db", async () => {
    sandboxStash();
    saveConfig({ semanticSearchMode: "off" });

    // ─ remember ──────────────────────────────────────────────────────────
    const remember = await runCli(["remember", "first event captured", "--name", "alpha", "--format=json"]);
    expect(remember.status).toBe(0);

    // index so feedback can find the ref
    const indexResult = await runCli(["index", "--full", "--format=json"]);
    expect(indexResult.status).toBe(0);

    // ─ feedback ──────────────────────────────────────────────────────────
    const feedback = await runCli(["feedback", "memory:alpha", "--positive", "--format=json"]);
    expect(feedback.status).toBe(0);

    // ─ add (local directory source) ──────────────────────────────────────
    const localSource = makeTempDir("akm-events-local-");
    writeFile(path.join(localSource, "skills", "demo.md"), "# demo\n\nA demo skill.\n");
    const add = await runCli(["add", localSource, "--format=json"]);
    expect(add.status).toBe(0);

    // Confirm events are in state.db by querying through the CLI.
    const list = await runCli(["events", "list", "--format=json"]);
    expect(list.status).toBe(0);
    const parsed = JSON.parse(list.stdout) as { events: Array<{ eventType: string }> };
    const types = parsed.events.map((e) => e.eventType);
    expect(types).toContain("remember");
    expect(types).toContain("feedback");
    expect(types).toContain("add");
  });

  test("`akm events list` returns the captured events in JSON envelope shape", async () => {
    sandboxStash();
    saveConfig({ semanticSearchMode: "off" });

    // Create a remember event via the CLI so state.db gets populated.
    const remember = await runCli(["remember", "another event captured", "--name", "beta", "--format=json"]);
    expect(remember.status).toBe(0);

    const list = await runCli(["events", "list", "--format=json"]);
    expect(list.status).toBe(0);
    const parsed = JSON.parse(list.stdout) as Record<string, unknown>;
    expect(parsed.totalCount).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(parsed.events)).toBe(true);
    const events = parsed.events as Array<Record<string, unknown>>;
    expect(events.some((e) => e.eventType === "remember")).toBe(true);
  });

  test("`akm events list --type feedback` filters by event type", async () => {
    sandboxStash();
    saveConfig({ semanticSearchMode: "off" });

    const remember = await runCli(["remember", "filter test", "--name", "gamma", "--format=json"]);
    expect(remember.status).toBe(0);
    await runCli(["index", "--full", "--format=json"]);
    await runCli(["feedback", "memory:gamma", "--positive", "--format=json"]);

    const filtered = await runCli(["events", "list", "--type", "feedback", "--format=json"]);
    expect(filtered.status).toBe(0);
    const parsed = JSON.parse(filtered.stdout) as Record<string, unknown>;
    const events = parsed.events as Array<Record<string, unknown>>;
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events.every((e) => e.eventType === "feedback")).toBe(true);
  });
});

describe("akmEventsTail", () => {
  test("--since timestamp emits only events at or after the cutoff", async () => {
    const dbPath = path.join(makeTempDir("akm-events-"), "state.db");
    let now = 1_700_000_000_000;
    const ctx = { dbPath, now: () => now };

    appendEvent({ eventType: "remember", ref: "memory:before" }, ctx);
    const cutoff = new Date(now + 500).toISOString();
    now += 1000;
    appendEvent({ eventType: "remember", ref: "memory:after" }, ctx);

    const result = await akmEventsTail({
      since: cutoff,
      ctx,
      intervalMs: 20,
      maxEvents: 1,
      maxDurationMs: 500,
    });
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.ref).toBe("memory:after");
  });
});

describe("akm events tail (streaming trailer)", () => {
  // Blocker fix: `--format text|jsonl` previously dropped the resumable
  // cursor entirely. After the streaming loop ends we must emit a single
  // trailer line so callers can resume from `nextOffset`.

  test("--format jsonl writes a discriminated trailer row to stdout", async () => {
    // Seed events into the same state.db the in-process CLI will read from
    // (getDbPath() resolves to <sandboxed XDG_DATA_HOME>/akm/state.db).
    const dbPath = getDbPath();
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const ctx = { dbPath };
    appendEvent({ eventType: "remember", ref: "memory:t1" }, ctx);
    appendEvent({ eventType: "remember", ref: "memory:t2" }, ctx);

    const child = await runCli([
      "events",
      "tail",
      "--format=jsonl",
      "--max-events",
      "2",
      "--max-duration-ms",
      "2000",
      "--interval-ms",
      "20",
    ]);
    expect(child.status).toBe(0);
    const lines = child.stdout.trim().split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(3); // 2 events + trailer
    const last = JSON.parse(lines[lines.length - 1] as string) as Record<string, unknown>;
    expect(last._kind).toBe("trailer");
    expect(last.schemaVersion).toBe(1);
    expect(typeof last.nextOffset).toBe("number");
    expect(last.totalCount).toBe(2);
    expect(["maxEvents", "signal", "maxDuration"]).toContain(last.reason as string);
  });

  test("--format text writes a trailer line to stderr (stdout stays pristine)", async () => {
    // Seed events into the same state.db the in-process CLI will read from.
    const dbPath = getDbPath();
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const ctx = { dbPath };
    appendEvent({ eventType: "remember", ref: "memory:tx1" }, ctx);

    const child = await runCli([
      "events",
      "tail",
      "--format=text",
      "--max-events",
      "1",
      "--max-duration-ms",
      "2000",
      "--interval-ms",
      "20",
    ]);
    expect(child.status).toBe(0);
    // stdout: pristine event lines, no trailer mixed in.
    expect(child.stdout).not.toContain("[events-tail]");
    // stderr: the trailer with reason + nextOffset + total.
    expect(child.stderr).toMatch(/\[events-tail\] reason=\S+ nextOffset=\d+ total=\d+/);
  });
});
