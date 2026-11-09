// Classification: opens a real state.db (the proposal queue and the extract ledger) and spawns no process.
//
// #1290: an extraction whose candidate writes fail says so in its result, in the enclosing improve result and
// in `akm health`, while a no-op, a validator refusal and a full success stay plain successes.

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { akmHealth } from "../../src/commands/health";
import { akmExtract } from "../../src/commands/improve/extract";
import { akmImprove } from "../../src/commands/improve/improve";
import * as proposalRepository from "../../src/commands/proposal/repository";
import { listProposals } from "../../src/commands/proposal/repository";
import type { AkmConfig } from "../../src/core/config/config";
import { getStateDbPath, openStateDatabase } from "../../src/core/state-db";
import type { SessionData, SessionLogHarness } from "../../src/integrations/session-logs/types";
import { getExtractedSession } from "../../src/storage/repositories/extract-sessions-repository";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "../_helpers/sandbox";

let storage: IsolatedAkmStorage;
const tempDirs: string[] = [];
beforeEach(() => {
  storage = withIsolatedAkmStorage();
});
afterEach(() => {
  storage.cleanup();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function makeStash(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-extract-failures-"));
  tempDirs.push(dir);
  for (const sub of ["memories", "lessons", "knowledge"]) fs.mkdirSync(path.join(dir, sub), { recursive: true });
  return dir;
}

function config(stash: string, endpoint = "http://localhost:11434/v1/chat/completions"): AkmConfig {
  return {
    configVersion: "0.9.0",
    semanticSearchMode: "off",
    bundles: { stash: { path: stash, writable: true } },
    defaultBundle: "stash",
    connections: { default: { endpoint, models: { fast: "test-model" } } },
    improve: {
      strategy: "extract",
      strategies: {
        extract: {
          processes: {
            extract: { enabled: true, indexSessions: false, triage: { enabled: false } },
            consolidate: { enabled: false },
          },
        },
      },
    },
  } as unknown as AkmConfig;
}

function session(id: string): SessionData {
  const filePath = `/tmp/fake/${id}.jsonl`;
  const endedAt = Date.now() - 60_000;
  const ref = { harness: "claude", sessionId: id, filePath, startedAt: endedAt - 3_600_000, endedAt, title: id };
  const event = (role: "user" | "assistant", text: string, ts: number) => ({
    harness: "claude",
    text,
    ts,
    sessionId: id,
    role,
    filePath,
  });
  return {
    ref,
    events: [
      event("user", "user message: explain how to recover from VPN-disconnect during deploy", endedAt - 3_000_000),
      event("assistant", "agent: deploy.sh hangs without VPN. The error message is misleading.", endedAt - 2_000_000),
    ],
    inlineRefs: [],
  };
}

function harness(sessions: SessionData[]): SessionLogHarness {
  return {
    name: "claude",
    isAvailable: () => true,
    listSessions: () => sessions.map((s) => s.ref),
    readSession: (ref) => {
      const found = sessions.find((s) => s.ref.sessionId === ref.sessionId);
      if (!found) throw new Error(`session not found: ${ref.sessionId}`);
      return found;
    },
  };
}

const candidate = (name: string) => ({
  type: "memory",
  name,
  description: "Deployment requires a working VPN connection before starting.",
  body: `Connect the corporate VPN before running deploy.sh (${name}), which otherwise stalls while pushing to stage.`,
  confidence: 0.9,
  evidence: "The session demonstrated the deployment failure without VPN.",
});

const pendingRefs = (stash: string) =>
  listProposals(stash, { status: "pending" }, { dbPath: getStateDbPath() })
    .map((row) => row.ref.split("//").pop())
    .sort();

const realCreateProposal = proposalRepository.createProposal;

async function extract(
  db: ReturnType<typeof openStateDatabase>,
  stash: string,
  sessions: SessionData[],
  names: string[],
  calls = { count: 0 },
) {
  const cfg = config(stash);
  writeSandboxConfig(cfg as unknown as Record<string, unknown>);
  return akmExtract({
    type: "claude",
    stashDir: stash,
    config: cfg,
    harnesses: [harness(sessions)],
    stateDb: db,
    eventsCtx: { db },
    chat: async () => {
      calls.count += 1;
      return JSON.stringify({ candidates: names.map(candidate) });
    },
  });
}

/** Every write of a candidate named `broken` fails the way a busy or full state.db does. */
const breakWrites = (db: ReturnType<typeof openStateDatabase>) =>
  db.exec(`CREATE TRIGGER fail_extract_proposal BEFORE INSERT ON proposals
    WHEN NEW.ref LIKE '%/broken' BEGIN SELECT RAISE(ABORT, 'scripted write failure'); END`);

describe("extract reports write failures beside ok: true (#1290)", () => {
  test("all writes fail: incomplete, counted and explained, still ok", async () => {
    const stash = makeStash();
    const db = openStateDatabase();
    try {
      breakWrites(db);
      const result = await extract(db, stash, [session("s1")], ["broken"]);
      expect(result.ok).toBe(true);
      expect(result.proposals).toEqual([]);
      expect(result.writeFailures).toMatchObject({ candidates: 1, sessions: 1 });
      expect(result.writeFailures?.causes.join(" ")).toContain("scripted write failure");
      expect(result.warnings.join(" ")).toMatch(/1 candidate write\(s\) failed in 1 session\(s\)/);
      expect(getExtractedSession(db, "claude", "s1")?.content_hash).toBeNull();
    } finally {
      db.close();
    }
  });

  test("partial success keeps the queued proposal and counts the failed one", async () => {
    const stash = makeStash();
    const db = openStateDatabase();
    try {
      breakWrites(db);
      const result = await extract(db, stash, [session("s1")], ["saved", "broken"]);
      expect(result.ok).toBe(true);
      expect(result.candidatesCreated).toBe(1);
      expect(result.writeFailures).toMatchObject({ candidates: 1, sessions: 1 });
      expect(pendingRefs(stash)).toEqual(["memories/saved"]);
    } finally {
      db.close();
    }
  });

  test("failures in several sessions sum, and the causes stay bounded", async () => {
    const stash = makeStash();
    const db = openStateDatabase();
    try {
      db.exec(`CREATE TRIGGER fail_extract_proposal BEFORE INSERT ON proposals
        WHEN NEW.ref LIKE '%/broken%' BEGIN
          SELECT RAISE(ABORT, 'scripted write failure ' || NEW.ref || ' ' || printf('%.300c', 'x'));
        END`);
      const names = ["broken1", "broken2", "broken3", "broken4", "broken5"];
      const result = await extract(db, stash, [session("s1"), session("s2")], names);
      expect(result.writeFailures).toMatchObject({ candidates: 10, sessions: 2 });
      // Five distinct causes, each over 300 characters: the first three, each cut to 200.
      expect(result.writeFailures?.causes).toHaveLength(3);
      for (const cause of result.writeFailures?.causes ?? []) {
        expect(cause).toStartWith("scripted write failure");
        expect(cause).toHaveLength(200);
      }
      for (const s of result.sessions) expect(s).not.toHaveProperty("failedCauses");
    } finally {
      db.close();
    }
  });

  test("a validator refusal is not a write failure", async () => {
    const stash = makeStash();
    spyOn(proposalRepository, "createProposal").mockImplementation((stashDir, input, ctx) =>
      realCreateProposal(
        stashDir,
        input.ref.endsWith("/refused") ? { ...input, payload: { ...input.payload, content: " " } } : input,
        ctx,
      ),
    );
    const db = openStateDatabase();
    try {
      const result = await extract(db, stash, [session("s1")], ["refused"]);
      expect(result.ok).toBe(true);
      expect(result.sessions[0]).toMatchObject({ failedCount: 1, failedRejectedCount: 1 });
      expect(result.writeFailures).toBeUndefined();
      expect(result.warnings.join(" ")).not.toMatch(/write\(s\) failed/);
    } finally {
      db.close();
    }
  });

  test("a no-op run, an unchanged session and a full success carry no failure field", async () => {
    const stash = makeStash();
    const db = openStateDatabase();
    try {
      const none = await extract(db, stash, [], ["saved"]);
      expect(none).toMatchObject({ ok: true, sessionsProcessed: 0 });
      expect(none.writeFailures).toBeUndefined();

      const empty = await extract(db, stash, [session("s1")], []);
      expect(empty.ok).toBe(true);
      expect(empty.writeFailures).toBeUndefined();

      const full = await extract(db, stash, [session("s2")], ["saved"]);
      expect(full).toMatchObject({ ok: true, candidatesCreated: 1 });
      expect(full.writeFailures).toBeUndefined();

      const again = await extract(db, stash, [session("s2")], ["saved"]);
      expect(again.sessions[0]?.skipReason).toBe("already_extracted");
      expect(again.writeFailures).toBeUndefined();
    } finally {
      db.close();
    }
  });

  test("later recovery queues the failed candidate once and the result is clean again", async () => {
    const stash = makeStash();
    const db = openStateDatabase();
    try {
      breakWrites(db);
      const first = await extract(db, stash, [session("s1")], ["saved", "broken"]);
      expect(first.writeFailures?.candidates).toBe(1);
      db.exec("DROP TRIGGER fail_extract_proposal");

      const retry = await extract(db, stash, [session("s1")], ["saved", "broken"]);
      expect(retry.ok).toBe(true);
      expect(retry.writeFailures).toBeUndefined();
      expect(pendingRefs(stash)).toEqual(["memories/broken", "memories/saved"]);
      expect(getExtractedSession(db, "claude", "s1")?.content_hash).not.toBeNull();
    } finally {
      db.close();
    }
  });
});

describe("the enclosing improve run carries the extract write failures (#1290)", () => {
  test("improve returns the extract result with writeFailures and stays ok", async () => {
    const stash = makeStash();
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        Response.json({
          choices: [{ message: { role: "assistant", content: JSON.stringify({ candidates: [candidate("broken")] }) } }],
        }),
    });
    const db = openStateDatabase();
    try {
      const cfg = config(stash, `http://127.0.0.1:${server.port}/v1/chat/completions`);
      writeSandboxConfig(cfg as unknown as Record<string, unknown>);
      breakWrites(db);
      const result = await akmImprove({
        scope: "memory",
        config: cfg,
        stashDir: stash,
        ensureIndexFn: async () => false,
        reindexFn: async () => ({ schemaVersion: 1, ok: true, indexed: 0, warnings: [], errors: [], durationMs: 0 }),
        extractHarnesses: [harness([session("s1")])],
      });
      expect(result.ok).toBe(true);
      expect(result.extract?.[0]?.writeFailures).toMatchObject({ candidates: 1, sessions: 1 });
      expect(result.extract?.[0]?.ok).toBe(true);
    } finally {
      db.close();
      server.stop(true);
    }
  });
});

describe("health reports mixed-outcome extraction failures (#1290)", () => {
  const advisory = async () =>
    (await akmHealth({ since: "7d" })).advisories.find((c) => c.name === "session-extraction");

  test("a failed write beside a good session warns, and recovery clears it", async () => {
    const stash = makeStash();
    const db = openStateDatabase();
    try {
      await extract(db, stash, [session("good")], ["saved"]);
      breakWrites(db);
      await extract(db, stash, [session("bad")], ["broken"]);
      const warned = await advisory();
      expect(warned?.status).toBe("warn");
      expect(warned?.message).toMatch(/1 of 2 sessions .*proposal_write_failed/);

      db.exec("DROP TRIGGER fail_extract_proposal");
      await extract(db, stash, [session("bad")], ["broken"]);
      expect((await advisory())?.status).toBe("pass");
    } finally {
      db.close();
    }
  });

  test("a partly failed session beside a good one warns", async () => {
    const stash = makeStash();
    const db = openStateDatabase();
    try {
      await extract(db, stash, [session("good")], ["saved"]);
      breakWrites(db);
      await extract(db, stash, [session("part")], ["other", "broken"]);
      expect((await advisory())?.status).toBe("warn");
    } finally {
      db.close();
    }
  });

  test("a validator refusal beside a good session does not warn", async () => {
    const stash = makeStash();
    spyOn(proposalRepository, "createProposal").mockImplementation((stashDir, input, ctx) =>
      realCreateProposal(
        stashDir,
        input.ref.endsWith("/refused") ? { ...input, payload: { ...input.payload, content: " " } } : input,
        ctx,
      ),
    );
    const db = openStateDatabase();
    try {
      await extract(db, stash, [session("good")], ["saved"]);
      await extract(db, stash, [session("refused")], ["refused"]);
      expect((await advisory())?.status).toBe("pass");
    } finally {
      db.close();
    }
  });

  test("sessions that queued nothing are not a failure", async () => {
    const stash = makeStash();
    const db = openStateDatabase();
    try {
      await extract(db, stash, [session("good")], ["saved"]);
      await extract(db, stash, [session("quiet")], []);
      expect((await advisory())?.status).toBe("pass");
    } finally {
      db.close();
    }
  });
});
