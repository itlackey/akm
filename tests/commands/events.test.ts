import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { akmEventsList, akmEventsTail } from "../../src/commands/events";
import { saveConfig } from "../../src/core/config";
import { appendEvent, getEventsPath, readEvents, tailEvents } from "../../src/core/events";

const CLI = path.join(__dirname, "..", "..", "src", "cli.ts");

const tempDirs: string[] = [];
const savedEnv = {
  AKM_STASH_DIR: process.env.AKM_STASH_DIR,
  XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
};

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function runCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("bun", [CLI, ...args], {
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env },
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

beforeEach(() => {
  process.env.XDG_CACHE_HOME = makeTempDir("akm-events-cache-");
  process.env.XDG_CONFIG_HOME = makeTempDir("akm-events-config-");
});

afterEach(() => {
  if (savedEnv.AKM_STASH_DIR === undefined) delete process.env.AKM_STASH_DIR;
  else process.env.AKM_STASH_DIR = savedEnv.AKM_STASH_DIR;
  if (savedEnv.XDG_CACHE_HOME === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = savedEnv.XDG_CACHE_HOME;
  if (savedEnv.XDG_CONFIG_HOME === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = savedEnv.XDG_CONFIG_HOME;
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("appendEvent / readEvents", () => {
  test("appends events as newline-delimited JSON", () => {
    const filePath = path.join(makeTempDir("akm-events-"), "events.jsonl");
    let now = 1_700_000_000_000;
    const ctx = { filePath, now: () => now };

    appendEvent({ eventType: "remember", ref: "memory:alpha", metadata: { tagCount: 2 } }, ctx);
    now += 1000;
    appendEvent({ eventType: "feedback", ref: "memory:alpha", metadata: { signal: "positive" } }, ctx);

    const content = fs.readFileSync(filePath, "utf8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0] as string);
    expect(first.eventType).toBe("remember");
    expect(first.ref).toBe("memory:alpha");
    expect(first.schemaVersion).toBe(1);
    expect(typeof first.ts).toBe("string");
  });

  test("readEvents returns parsed envelopes with monotonic byte offsets", () => {
    const filePath = path.join(makeTempDir("akm-events-"), "events.jsonl");
    const ctx = { filePath };
    appendEvent({ eventType: "add", metadata: { target: "user/repo" } }, ctx);
    appendEvent({ eventType: "remove", metadata: { target: "user/repo" } }, ctx);

    const result = readEvents({}, ctx);
    expect(result.events).toHaveLength(2);
    expect(result.events[0]?.eventType).toBe("add");
    expect(result.events[1]?.eventType).toBe("remove");
    // ids are byte offsets; second must be larger than first
    expect((result.events[1]?.id ?? 0) > (result.events[0]?.id ?? 0)).toBe(true);
    expect(result.nextOffset).toBe(fs.statSync(filePath).size);
  });

  test("--since (byte offset) is durable across processes", () => {
    const filePath = path.join(makeTempDir("akm-events-"), "events.jsonl");
    const ctx = { filePath };
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
    const cacheDir = makeTempDir("akm-events-xproc-cache-");
    const configDir = makeTempDir("akm-events-xproc-config-");
    const cursorFile = path.join(makeTempDir("akm-events-xproc-state-"), "cursor.txt");
    // Drive both processes through the same XDG_CACHE_HOME so they share
    // the same events.jsonl path (see env-isolation note in core/events.ts).
    const childEnv = {
      ...process.env,
      XDG_CACHE_HOME: cacheDir,
      XDG_CONFIG_HOME: configDir,
    };
    const eventsPath = path.join(cacheDir, "akm", "events.jsonl");
    const ctx = { filePath: eventsPath };

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
    const child = spawnSync("bun", [CLI, "events", "list", "--since", `@offset:${persisted}`, "--format=json"], {
      encoding: "utf8",
      timeout: 30_000,
      env: childEnv,
    });
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
    const filePath = path.join(makeTempDir("akm-events-"), "events.jsonl");
    const ctx = { filePath };
    expect(() => akmEventsList({ since: "@offset:not-a-number", ctx })).toThrow(/Invalid --since byte offset/);
    expect(() => akmEventsList({ since: "@offset:-3", ctx })).toThrow(/Invalid --since/);
  });

  test("--since (timestamp) filter is monotonic across processes", () => {
    const filePath = path.join(makeTempDir("akm-events-"), "events.jsonl");
    let now = 1_700_000_000_000;
    const ctx = { filePath, now: () => now };
    appendEvent({ eventType: "remember", ref: "memory:a" }, ctx);
    const cutoff = new Date(now + 500).toISOString();
    now += 1000;
    appendEvent({ eventType: "remember", ref: "memory:b" }, ctx);

    const result = akmEventsList({ since: cutoff, ctx });
    expect(result.totalCount).toBe(1);
    expect(result.events[0]?.ref).toBe("memory:b");
  });

  test("--type and --ref filters work in combination", () => {
    const filePath = path.join(makeTempDir("akm-events-"), "events.jsonl");
    const ctx = { filePath };
    appendEvent({ eventType: "remember", ref: "memory:a" }, ctx);
    appendEvent({ eventType: "feedback", ref: "memory:a", metadata: { signal: "positive" } }, ctx);
    appendEvent({ eventType: "feedback", ref: "memory:b", metadata: { signal: "negative" } }, ctx);

    const filtered = akmEventsList({ type: "feedback", ref: "memory:a", ctx });
    expect(filtered.totalCount).toBe(1);
    expect(filtered.events[0]?.eventType).toBe("feedback");
    expect(filtered.events[0]?.ref).toBe("memory:a");
  });

  test("malformed lines are skipped, valid ones still parse", () => {
    const filePath = path.join(makeTempDir("akm-events-"), "events.jsonl");
    const ctx = { filePath };
    appendEvent({ eventType: "remember", ref: "memory:a" }, ctx);
    fs.appendFileSync(filePath, "this is not json\n");
    appendEvent({ eventType: "remember", ref: "memory:b" }, ctx);

    const result = readEvents({}, ctx);
    expect(result.events.map((e) => e.ref)).toEqual(["memory:a", "memory:b"]);
  });
});

describe("tailEvents", () => {
  test("emits historical events, then follows new appends until maxEvents", async () => {
    const filePath = path.join(makeTempDir("akm-events-"), "events.jsonl");
    const ctx = { filePath };
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
    const filePath = path.join(makeTempDir("akm-events-"), "events.jsonl");
    const ctx = { filePath };
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
    const filePath = path.join(makeTempDir("akm-events-"), "events.jsonl");
    const ctx = { filePath };
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 80);
    const result = await tailEvents({ intervalMs: 20, signal: ac.signal, maxDurationMs: 1_000 }, ctx);
    expect(result.reason).toBe("signal");
  });
});

describe("akm CLI mutation events", () => {
  test("remember, feedback, and add each emit an event to events.jsonl", async () => {
    const stashDir = makeTempDir("akm-events-stash-");
    process.env.AKM_STASH_DIR = stashDir;
    saveConfig({ semanticSearchMode: "off" });

    // ─ remember ──────────────────────────────────────────────────────────
    const remember = runCli(["remember", "first event captured", "--name", "alpha", "--format=json"]);
    expect(remember.status).toBe(0);

    // index so feedback can find the ref
    const indexResult = runCli(["index", "--full", "--format=json"]);
    expect(indexResult.status).toBe(0);

    // ─ feedback ──────────────────────────────────────────────────────────
    const feedback = runCli(["feedback", "memory:alpha", "--positive", "--format=json"]);
    expect(feedback.status).toBe(0);

    // ─ add (local directory source) ──────────────────────────────────────
    const localSource = makeTempDir("akm-events-local-");
    writeFile(path.join(localSource, "skills", "demo.md"), "# demo\n\nA demo skill.\n");
    const add = runCli(["add", localSource, "--format=json"]);
    expect(add.status).toBe(0);

    // Confirm events.jsonl contains all three event types in order.
    const eventsPath = getEventsPath();
    expect(fs.existsSync(eventsPath)).toBe(true);
    const lines = fs.readFileSync(eventsPath, "utf8").trim().split("\n");
    const types = lines.map((line) => (JSON.parse(line) as { eventType: string }).eventType);
    expect(types).toContain("remember");
    expect(types).toContain("feedback");
    expect(types).toContain("add");
  });

  test("`akm events list` returns the captured events in JSON envelope shape", async () => {
    const stashDir = makeTempDir("akm-events-stash-");
    process.env.AKM_STASH_DIR = stashDir;
    saveConfig({ semanticSearchMode: "off" });

    // Create a remember event via the CLI so events.jsonl exists.
    const remember = runCli(["remember", "another event captured", "--name", "beta", "--format=json"]);
    expect(remember.status).toBe(0);

    const list = runCli(["events", "list", "--format=json"]);
    expect(list.status).toBe(0);
    const parsed = JSON.parse(list.stdout) as Record<string, unknown>;
    expect(parsed.totalCount).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(parsed.events)).toBe(true);
    const events = parsed.events as Array<Record<string, unknown>>;
    expect(events.some((e) => e.eventType === "remember")).toBe(true);
  });

  test("`akm events list --type feedback` filters by event type", async () => {
    const stashDir = makeTempDir("akm-events-stash-");
    process.env.AKM_STASH_DIR = stashDir;
    saveConfig({ semanticSearchMode: "off" });

    const remember = runCli(["remember", "filter test", "--name", "gamma", "--format=json"]);
    expect(remember.status).toBe(0);
    runCli(["index", "--full", "--format=json"]);
    runCli(["feedback", "memory:gamma", "--positive", "--format=json"]);

    const filtered = runCli(["events", "list", "--type", "feedback", "--format=json"]);
    expect(filtered.status).toBe(0);
    const parsed = JSON.parse(filtered.stdout) as Record<string, unknown>;
    const events = parsed.events as Array<Record<string, unknown>>;
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events.every((e) => e.eventType === "feedback")).toBe(true);
  });
});

describe("akmEventsTail", () => {
  test("--since timestamp emits only events at or after the cutoff", async () => {
    const filePath = path.join(makeTempDir("akm-events-"), "events.jsonl");
    let now = 1_700_000_000_000;
    const ctx = { filePath, now: () => now };

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

  test("--format jsonl writes a discriminated trailer row to stdout", () => {
    const cacheDir = makeTempDir("akm-events-trailer-jsonl-cache-");
    const configDir = makeTempDir("akm-events-trailer-jsonl-config-");
    const eventsPath = path.join(cacheDir, "akm", "events.jsonl");
    const ctx = { filePath: eventsPath };
    appendEvent({ eventType: "remember", ref: "memory:t1" }, ctx);
    appendEvent({ eventType: "remember", ref: "memory:t2" }, ctx);

    const child = spawnSync(
      "bun",
      [
        CLI,
        "events",
        "tail",
        "--format=jsonl",
        "--max-events",
        "2",
        "--max-duration-ms",
        "2000",
        "--interval-ms",
        "20",
      ],
      {
        encoding: "utf8",
        timeout: 30_000,
        env: { ...process.env, XDG_CACHE_HOME: cacheDir, XDG_CONFIG_HOME: configDir },
      },
    );
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

  test("--format text writes a trailer line to stderr (stdout stays pristine)", () => {
    const cacheDir = makeTempDir("akm-events-trailer-text-cache-");
    const configDir = makeTempDir("akm-events-trailer-text-config-");
    const eventsPath = path.join(cacheDir, "akm", "events.jsonl");
    const ctx = { filePath: eventsPath };
    appendEvent({ eventType: "remember", ref: "memory:tx1" }, ctx);

    const child = spawnSync(
      "bun",
      [CLI, "events", "tail", "--format=text", "--max-events", "1", "--max-duration-ms", "2000", "--interval-ms", "20"],
      {
        encoding: "utf8",
        timeout: 30_000,
        env: { ...process.env, XDG_CACHE_HOME: cacheDir, XDG_CONFIG_HOME: configDir },
      },
    );
    expect(child.status).toBe(0);
    // stdout: pristine event lines, no trailer mixed in.
    expect(child.stdout).not.toContain("[events-tail]");
    // stderr: the trailer with reason + nextOffset + total.
    expect(child.stderr).toMatch(/\[events-tail\] reason=\S+ nextOffset=\d+ total=\d+/);
  });
});
