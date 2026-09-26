/**
 * Proposal storage consolidation (#578) — the `proposals` table in state.db
 * is the single source of truth.
 *
 * Covers what tests/proposals.test.ts (API behaviour) deliberately does not:
 *   • rows physically land in state.db, and no `.akm/proposals/` tree appears;
 *   • the full lifecycle (create → list → show → diff → accept / reject →
 *     revert) round-trips through the table;
 *   • concurrent create + list safety under WAL (a second open connection
 *     reads while the command-path connection writes);
 *   • UUID-prefix resolution + stash_dir partitioning against the table.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { computeAcceptRateBySource } from "../../../src/commands/health/accept-rate";
import {
  akmProposalAccept,
  akmProposalDiff,
  akmProposalRevert,
  akmProposalShow,
} from "../../../src/commands/proposal/proposal";
import {
  archiveProposal,
  createProposal as createProposalImpl,
  getProposal,
  listProposals,
  type Proposal,
  resolveProposalId,
} from "../../../src/commands/proposal/repository";
import { getStateDbPath, openStateDatabase } from "../../../src/core/state-db";
import { makeConfig } from "../../_helpers/factories";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../../_helpers/sandbox";

const tempDirs: string[] = [];
let storage: IsolatedAkmStorage;

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeStashDir(): string {
  const stash = makeTempDir("akm-prop-sql-stash-");
  for (const dir of ["lessons", "skills", "memories"]) {
    fs.mkdirSync(path.join(stash, dir), { recursive: true });
  }
  return stash;
}

/** The durable `proposals.ref` item_ref (WI-8.5a): `<bundle>//<conceptId>`. */
function durableRef(stashDir: string, type: string, name: string): string {
  void stashDir;
  const directories: Record<string, string> = { lesson: "lessons", skill: "skills", memory: "memories" };
  return `stash//${directories[type] ?? type}/${name}`;
}

const createProposal: typeof createProposalImpl = (stashDir, input, ctx) =>
  createProposalImpl(
    stashDir,
    { ...input, target: input.target ?? { source: "stash", root: path.resolve(stashDir) } },
    ctx,
  );

beforeEach(() => {
  storage = withIsolatedAkmStorage();
});

afterEach(() => {
  storage.cleanup();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const VALID_LESSON = `---\ndescription: Use ripgrep before grep\nwhen_to_use: Searching large repos for patterns\n---\n\nPrefer rg over grep when scanning large code repos.\n`;

function mustCreate(stashDir: string, ref: string, source = "reflect", content = VALID_LESSON): Proposal {
  const result = createProposal(stashDir, { ref, source, payload: { content } });
  return result;
}

/** Count proposals rows for one stash straight off the table. */
function countRows(stashDir: string, status?: string): number {
  const db = openStateDatabase(getStateDbPath());
  try {
    const sql = status
      ? "SELECT COUNT(*) AS c FROM proposals WHERE stash_dir = ? AND status = ?"
      : "SELECT COUNT(*) AS c FROM proposals WHERE stash_dir = ?";
    const row = (status ? db.prepare(sql).get(stashDir, status) : db.prepare(sql).get(stashDir)) as { c: number };
    return row.c;
  } finally {
    db.close();
  }
}

interface WorkerHandle<T> {
  ready: Promise<void>;
  result: Promise<T>;
  release: () => void;
}

function startProposalWorker<T>(payload: Record<string, unknown>): WorkerHandle<T> {
  const scriptDir = makeTempDir("akm-prop-worker-");
  const scriptPath = path.join(scriptDir, "worker.mts");
  const moduleHref = proposalsModuleHref();
  fs.writeFileSync(
    scriptPath,
    `
      import { parentPort } from "node:worker_threads";
      import {
        archiveProposal,
        createProposal,
        recordGateDecision,
      } from ${JSON.stringify(moduleHref)};

      if (!parentPort) throw new Error("Proposal worker requires a parent port");
      parentPort.on("message", (message) => {
        const { signalBuffer, action, payload } = message;
        const signal = new Int32Array(signalBuffer);
        parentPort.postMessage({ type: "ready" });
        Atomics.wait(signal, 0, 0);

        if (action === "create") {
          const result = createProposal(payload.stashDir, payload.input, { dbPath: payload.dbPath });
          parentPort.postMessage({
            type: "result",
            result: { kind: "created", id: result.id },
          });
          return;
        }

        if (action === "archive") {
          const updated = archiveProposal(payload.stashDir, payload.id, payload.status, payload.reason, {
            dbPath: payload.dbPath,
          });
          parentPort.postMessage({ type: "result", result: { kind: "archived", status: updated.status } });
          return;
        }

        if (action === "gate") {
          const updated = recordGateDecision(payload.stashDir, payload.id, payload.decision, { dbPath: payload.dbPath });
          parentPort.postMessage({ type: "result", result: { kind: "gate", updated: updated !== undefined } });
        }
      });
    `,
    "utf8",
  );

  const worker = new Worker(pathToFileURL(scriptPath));
  const signal = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  let resolveReady: (() => void) | undefined;
  let resolveResult: ((value: T) => void) | undefined;
  let rejectResult: ((error: unknown) => void) | undefined;
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  const result = new Promise<T>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });

  worker.on("message", (message) => {
    if (message?.type === "ready") {
      resolveReady?.();
      return;
    }
    if (message?.type === "result") {
      resolveResult?.(message.result as T);
      void worker.terminate();
    }
  });
  worker.once("error", (error) => {
    rejectResult?.(error);
    void worker.terminate();
  });
  worker.postMessage({ signalBuffer: signal.buffer, ...payload });

  return {
    ready,
    result,
    release: () => {
      Atomics.store(signal, 0, 1);
      Atomics.notify(signal, 0);
    },
  };
}

function proposalsModuleHref(): string {
  return pathToFileURL(path.join(import.meta.dir, "../../../src/commands/proposal/repository.ts")).href;
}

// ── canonical store ──────────────────────────────────────────────────────────

describe("state.db is the canonical proposal store", () => {
  test("createProposal writes a row to the proposals table and no .akm/proposals tree", () => {
    const stash = makeStashDir();
    const created = mustCreate(stash, "lessons/sqlite-canonical");

    expect(countRows(stash, "pending")).toBe(1);
    const db = openStateDatabase(getStateDbPath());
    try {
      const row = db.prepare("SELECT ref, status, content FROM proposals WHERE id = ?").get(created.id) as {
        ref: string;
        status: string;
        content: string;
      };
      expect(row.ref).toBe(durableRef(stash, "lesson", "sqlite-canonical"));
      expect(row.status).toBe("pending");
      expect(row.content).toContain("Prefer rg over grep");
    } finally {
      db.close();
    }

    // The legacy filesystem tree must NOT appear.
    expect(fs.existsSync(path.join(stash, ".akm", "proposals"))).toBe(false);
  });

  test("full lifecycle round-trips through the table: list → show → diff → accept → revert", async () => {
    const stash = makeStashDir();
    const config = makeConfig(stash);
    // Pre-existing asset so accept captures a backup for revert.
    const lessonPath = path.join(stash, "lessons", "sqlite-cycle.md");
    fs.writeFileSync(lessonPath, `---\ndescription: Old\nwhen_to_use: Old\n---\n\nORIGINAL.\n`, "utf8");

    const created = mustCreate(stash, "lessons/sqlite-cycle", "distill");

    expect(listProposals(stash).map((p) => p.id)).toEqual([created.id]);
    expect(akmProposalShow({ stashDir: stash, id: created.id }).proposal.status).toBe("pending");
    expect(akmProposalDiff({ stashDir: stash, id: created.id, config }).isNew).toBe(false);

    await akmProposalAccept({ stashDir: stash, id: created.id, config });
    expect(countRows(stash, "accepted")).toBe(1);
    expect(getProposal(stash, created.id).backupContent).toContain("ORIGINAL.");
    expect(fs.readFileSync(lessonPath, "utf8")).toContain("Prefer rg over grep");

    await akmProposalRevert({ stashDir: stash, id: created.id, config });
    expect(countRows(stash, "reverted")).toBe(1);
    expect(countRows(stash, "pending")).toBe(0);
    expect(fs.readFileSync(lessonPath, "utf8")).toContain("ORIGINAL.");
    // Still no filesystem queue artifacts after the whole cycle.
    expect(fs.existsSync(path.join(stash, ".akm", "proposals"))).toBe(false);
  });

  test("ctx.dbPath seam routes the store to an explicit database file", () => {
    const stash = makeStashDir();
    const dbPath = path.join(makeTempDir("akm-prop-sql-db-"), "alt-state.db");
    const created = createProposal(
      stash,
      { ref: "lessons/seam", source: "reflect", payload: { content: VALID_LESSON } },
      { dbPath },
    );

    // Visible through the same seam, invisible through the default path.
    expect(listProposals(stash, {}, { dbPath }).map((p) => p.id)).toEqual([created.id]);
    expect(listProposals(stash)).toHaveLength(0);
    expect(fs.existsSync(dbPath)).toBe(true);
  });

  test("stash_dir partitions queues: proposals in one stash are invisible to another", () => {
    const stashA = makeStashDir();
    const stashB = makeStashDir();
    const a = mustCreate(stashA, "lessons/partition");

    expect(listProposals(stashA).map((p) => p.id)).toEqual([a.id]);
    expect(listProposals(stashB)).toHaveLength(0);
    // Cross-stash id lookups must miss too.
    expect(() => getProposal(stashB, a.id)).toThrow(/not found/i);
  });

  test("UUID-prefix resolution queries the pending queue and rejects ambiguity", () => {
    const stash = makeStashDir();
    const a = mustCreate(stash, "lessons/prefix-a");
    const b = mustCreate(stash, "lessons/prefix-b");

    expect(resolveProposalId(stash, a.id.slice(0, 12)).id).toBe(a.id);

    const common = commonPrefix(a.id, b.id);
    if (common.length > 0) {
      expect(() => resolveProposalId(stash, common)).toThrow(/Ambiguous prefix/);
    }
  });
});

function commonPrefix(a: string, b: string): string {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  return a.slice(0, i);
}

// ── WAL concurrency ──────────────────────────────────────────────────────────

describe("concurrent create + list safety (WAL)", () => {
  test(
    "proposal worker remains functional after local inference replaces the ambient Worker",
    async () => {
      const child = Bun.spawn(
        [
          process.execPath,
          "test",
          "--timeout=120000",
          "-t",
          "akmSearch includes explainability reasons for indexed hits|concurrent duplicate proposal creation serializes",
          path.join(import.meta.dir, "../../../tests/source.test.ts"),
          path.join(import.meta.dir, "proposal-storage-sqlite.test.ts"),
        ],
        {
          cwd: path.resolve(import.meta.dir, "../../.."),
          env: { ...process.env },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      if (exitCode !== 0) {
        throw new Error(`Semantic-to-proposal isolation probe failed (${exitCode}):\n${stderr || stdout}`);
      }
    },
    { timeout: 120_000 },
  );

  test("a second open connection reads consistently while the command path writes", () => {
    const stash = makeStashDir();
    // Hold an independent reader connection open for the whole test — WAL mode
    // must let the command-path writes (each on their own connection) land
    // without SQLITE_BUSY, and the reader must see them after commit.
    const reader = openStateDatabase(getStateDbPath());
    try {
      for (let i = 0; i < 5; i += 1) {
        mustCreate(stash, `lessons/wal-${i}`);
        const row = reader.prepare("SELECT COUNT(*) AS c FROM proposals WHERE stash_dir = ?").get(stash) as {
          c: number;
        };
        expect(row.c).toBe(i + 1);
        expect(listProposals(stash)).toHaveLength(i + 1);
      }
    } finally {
      reader.close();
    }
  });

  test("interleaved creates from parallel async callers all land exactly once", async () => {
    const stash = makeStashDir();
    const refs = Array.from({ length: 10 }, (_, i) => `lessons/parallel-${i}`);
    await Promise.all(refs.map((ref) => Promise.resolve().then(() => mustCreate(stash, ref))));
    const listed = listProposals(stash);
    const expectedStored = Array.from({ length: 10 }, (_, i) => durableRef(stash, "lesson", `parallel-${i}`));
    expect(listed.map((p) => p.ref).sort()).toEqual([...expectedStored].sort());
    expect(countRows(stash, "pending")).toBe(10);
  });

  test(
    "concurrent proposal creation for one ref serializes on state.db: both mints commit, one ledger row",
    async () => {
      const stash = makeStashDir();
      const dbPath = path.join(makeTempDir("akm-prop-sql-concurrency-db-"), "state.db");
      openStateDatabase(dbPath).close();

      const ref = "lessons/concurrent-duplicate";
      const source = "reflect";
      const workerA = startProposalWorker<Record<string, unknown>>({
        action: "create",
        payload: {
          stashDir: stash,
          dbPath,
          input: {
            ref,
            source,
            sourceRun: "run-concurrency-a",
            target: { source: "stash", root: stash },
            payload: { content: `${VALID_LESSON}\nA` },
          },
        },
      });
      const workerB = startProposalWorker<Record<string, unknown>>({
        action: "create",
        payload: {
          stashDir: stash,
          dbPath,
          input: {
            ref,
            source,
            sourceRun: "run-concurrency-b",
            target: { source: "stash", root: stash },
            payload: { content: `${VALID_LESSON}\nB` },
          },
        },
      });
      await Promise.all([workerA.ready, workerB.ready]);
      workerA.release();
      workerB.release();

      const parsed = await Promise.all([workerA.result, workerB.result]);
      // Whether a ref may be proposed again is candidate selection's call
      // (the improve ledger), not the mint's: both writers commit.
      expect(parsed.filter((entry) => entry.kind === "created")).toHaveLength(2);
      expect(listProposals(stash, {}, { dbPath })).toHaveLength(2);

      const db = openStateDatabase(dbPath);
      try {
        const rows = db
          .prepare("SELECT proposal_id FROM improve_ledger WHERE stash_dir = ? AND source = 'reflect'")
          .all(stash) as Array<{ proposal_id: string }>;
        expect(rows).toHaveLength(1);
        expect(parsed.map((entry) => entry.id)).toContain(rows[0]?.proposal_id);
      } finally {
        db.close();
      }
    },
    { timeout: 30_000 },
  );

  test(
    "concurrent reject + gate-decision mutation cannot revive a pending row",
    async () => {
      const stash = makeStashDir();
      const dbPath = path.join(makeTempDir("akm-prop-sql-mutation-db-"), "state.db");
      openStateDatabase(dbPath).close();
      const created = createProposal(
        stash,
        { ref: "lessons/mutation-race", source: "reflect", payload: { content: VALID_LESSON } },
        { dbPath },
      );

      const archiveWorker = startProposalWorker<{ kind: string; status: string }>({
        action: "archive",
        payload: { stashDir: stash, dbPath, id: created.id, status: "rejected", reason: "race reject" },
      });
      const gateWorker = startProposalWorker<{ kind: string; updated: boolean }>({
        action: "gate",
        payload: {
          stashDir: stash,
          dbPath,
          id: created.id,
          decision: { outcome: "deferred", reason: "race-gate", gate: "triage:test" },
        },
      });
      await Promise.all([archiveWorker.ready, gateWorker.ready]);
      archiveWorker.release();
      gateWorker.release();

      const [, gateOutcome] = await Promise.all([archiveWorker.result, gateWorker.result]);
      const finalProposal = getProposal(stash, created.id, { dbPath });
      expect(finalProposal.status).toBe("rejected");
      expect(finalProposal.review?.reason).toBe("race reject");
      if (gateOutcome.updated) {
        expect(finalProposal.gateDecision?.reason).toBe("race-gate");
      } else {
        expect(finalProposal.gateDecision).toBeUndefined();
      }
    },
    { timeout: 30_000 },
  );
});

describe("listProposals resilience to malformed archive rows (#858/#859)", () => {
  // #858: `health --report` (and any other reader of the accepted/rejected
  // archive) crashed outright the moment a single row failed to parse —
  // originally hit by pre-feature rows with no persisted `changes`, but the
  // same bare `.map()` would abort on any other row-level corruption too.
  // `storedToChanges` tolerates the "no changes key at all" legacy shape,
  // and (#859 reopening) so does an absent `proposedTarget` — both are
  // envelope metadata real archived rows predate, not corruption (see
  // proposals-repository.ts). This test corrupts a field with a malformed
  // *present* value instead (`proposedTarget` of the wrong shape) to prove
  // listProposals is still resilient to genuine row-level corruption, not
  // just the tolerated legacy-absence cases.
  test("a row with genuinely corrupt metadata is skipped, not thrown, and other rows still list", () => {
    const stash = makeStashDir();
    const good = mustCreate(stash, "lessons/archive-good", "reflect");
    const corrupt = mustCreate(stash, "lessons/archive-corrupt", "reflect");
    archiveProposal(stash, good.id, "accepted", undefined);
    archiveProposal(stash, corrupt.id, "accepted", undefined);

    const db = openStateDatabase(getStateDbPath());
    try {
      const row = db.prepare("SELECT metadata_json FROM proposals WHERE id = ?").get(corrupt.id) as {
        metadata_json: string;
      };
      const metadata = JSON.parse(row.metadata_json) as Record<string, unknown>;
      // Present but malformed (missing `root`) — genuine corruption, distinct
      // from the field being absent entirely.
      metadata.proposedTarget = { source: "team" };
      db.prepare("UPDATE proposals SET metadata_json = ? WHERE id = ?").run(JSON.stringify(metadata), corrupt.id);
    } finally {
      db.close();
    }

    const results = listProposals(stash, { status: "accepted", includeArchive: true });
    expect(results.map((p) => p.id)).toEqual([good.id]);
  });

  // #859: two of the three real callers of the accepted/rejected archive
  // (accept-rate.ts, proposal/repository.ts's listProposals) had no
  // try/catch and crashed outright; the third (improve/preparation.ts) had a
  // try/catch around the whole query and silently fell back to zero
  // accepted-counts for every ref. Legacy rows represent real, genuinely
  // accepted proposals, so undercounting them (by skipping or zeroing them
  // out) corrupts outcome-score salience and accept-rate reporting. Decision
  // (documented in storedToChanges): a row missing `changes` entirely is
  // treated as a legacy proposal with an empty change list, not dropped —
  // so it counts here.
  test("accepted-counts include legacy rows that have no persisted changes", () => {
    const stash = makeStashDir();
    const normal = mustCreate(stash, "lessons/legacy-normal", "reflect");
    const legacy = mustCreate(stash, "lessons/legacy-gap", "reflect");
    archiveProposal(stash, normal.id, "accepted", undefined);
    archiveProposal(stash, legacy.id, "accepted", undefined);

    const db = openStateDatabase(getStateDbPath());
    try {
      const row = db.prepare("SELECT metadata_json FROM proposals WHERE id = ?").get(legacy.id) as {
        metadata_json: string;
      };
      const metadata = JSON.parse(row.metadata_json) as Record<string, unknown>;
      delete metadata.changes;
      delete metadata.beforeHash;
      db.prepare("UPDATE proposals SET metadata_json = ? WHERE id = ?").run(JSON.stringify(metadata), legacy.id);
    } finally {
      db.close();
    }

    const result = computeAcceptRateBySource(stash);
    const reflect = result.find((r) => r.source === "reflect");
    expect(reflect?.accepted).toBe(2);
  });
});
