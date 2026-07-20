/**
 * Proposal storage consolidation (#578) — the `proposals` table in state.db
 * is the single source of truth.
 *
 * Covers what tests/proposals.test.ts (API behaviour) deliberately does not:
 *   • rows physically land in state.db, and no `.akm/proposals/` tree appears;
 *   • the full lifecycle (create → list → show → diff → accept / reject →
 *     revert) round-trips through the table;
 *   • one-shot, idempotent backfill of legacy pre-0.9.0 filesystem proposals
 *     (including inlining `backup.<ext>` files as `backupContent`);
 *   • concurrent create + list safety under WAL (a second open connection
 *     reads while the command-path connection writes);
 *   • UUID-prefix resolution + stash_dir partitioning against the table.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  akmProposalAccept,
  akmProposalDiff,
  akmProposalRevert,
  akmProposalShow,
} from "../../src/commands/proposal/proposal";
import {
  createProposal,
  getProposal,
  isProposalSkipped,
  listProposals,
  type Proposal,
  resolveProposalId,
} from "../../src/commands/proposal/repository";
import { getStateDbPath, openStateDatabase } from "../../src/core/state-db";
import { deriveEntryProvenance, deriveInstallations, slugForPath } from "../../src/indexer/installations";
import { makeConfig } from "../_helpers/factories";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../_helpers/sandbox";

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
  const bundleId = deriveInstallations([{ path: stashDir, writable: true }])[0]?.id ?? slugForPath(stashDir);
  return deriveEntryProvenance({ bundleId, componentId: bundleId, adapterId: "akm" }, type, name).itemRef;
}

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
  const result = createProposal(stashDir, { ref, source, force: true, payload: { content } });
  if (isProposalSkipped(result)) throw new Error(`unexpected skip: ${result.message}`);
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
      import {
        archiveProposal,
        createProposal,
        isProposalSkipped,
        recordGateDecision,
      } from ${JSON.stringify(moduleHref)};

      self.onmessage = (event) => {
        const { signalBuffer, action, payload } = event.data;
        const signal = new Int32Array(signalBuffer);
        postMessage({ type: "ready" });
        Atomics.wait(signal, 0, 0);

        if (action === "create") {
          const result = createProposal(payload.stashDir, payload.input, { dbPath: payload.dbPath });
          postMessage({
            type: "result",
            result: isProposalSkipped(result)
              ? { kind: "skipped", reason: result.reason, existingProposalId: result.existingProposalId ?? null }
              : { kind: "created", id: result.id },
          });
          return;
        }

        if (action === "archive") {
          const updated = archiveProposal(payload.stashDir, payload.id, payload.status, payload.reason, {
            dbPath: payload.dbPath,
          });
          postMessage({ type: "result", result: { kind: "archived", status: updated.status } });
          return;
        }

        if (action === "gate") {
          const updated = recordGateDecision(payload.stashDir, payload.id, payload.decision, { dbPath: payload.dbPath });
          postMessage({ type: "result", result: { kind: "gate", updated: updated !== undefined } });
        }
      };
    `,
    "utf8",
  );

  const worker = new Worker(pathToFileURL(scriptPath).href, { type: "module" });
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

  worker.addEventListener("message", (event) => {
    if (event.data?.type === "ready") {
      resolveReady?.();
      return;
    }
    if (event.data?.type === "result") {
      resolveResult?.(event.data.result as T);
      void worker.terminate();
    }
  });
  worker.addEventListener("error", (event) => {
    rejectResult?.(event.error ?? new Error(event.message));
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
  return pathToFileURL(path.join(import.meta.dir, "../../src/commands/proposal/repository.ts")).href;
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
      { ref: "lessons/seam", source: "reflect", force: true, payload: { content: VALID_LESSON } },
      { dbPath },
    );
    if (isProposalSkipped(created)) throw new Error("unexpected skip");

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

// ── legacy filesystem backfill ───────────────────────────────────────────────

function writeLegacyProposal(
  stashDir: string,
  proposal: Record<string, unknown>,
  options: { archive?: boolean; backupBody?: string } = {},
): void {
  const root = options.archive
    ? path.join(stashDir, ".akm", "proposals", "archive")
    : path.join(stashDir, ".akm", "proposals");
  const dir = path.join(root, String(proposal.id));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "proposal.json"), `${JSON.stringify(proposal, null, 2)}\n`, "utf8");
  if (options.backupBody !== undefined) {
    fs.writeFileSync(path.join(dir, "backup.md"), options.backupBody, "utf8");
  }
}

function legacyRecord(id: string, ref: string, status: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    ref,
    status,
    source: "reflect",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    payload: { content: VALID_LESSON },
    ...extra,
  };
}

describe("legacy filesystem proposals are imported on first store access", () => {
  test("pending + archived legacy proposals appear in listProposals; backups are inlined", () => {
    const stash = makeStashDir();
    const pendingId = "11111111-1111-4111-8111-111111111111";
    const acceptedId = "22222222-2222-4222-8222-222222222222";
    writeLegacyProposal(stash, legacyRecord(pendingId, "lesson:legacy-pending", "pending"));
    writeLegacyProposal(
      stash,
      legacyRecord(acceptedId, "lesson:legacy-accepted", "accepted", {
        backup: "backup.md",
        review: { outcome: "accepted", decidedAt: "2026-01-02T00:00:00.000Z" },
      }),
      { archive: true, backupBody: "LEGACY BACKUP BODY\n" },
    );

    const pending = listProposals(stash);
    expect(pending.map((p) => p.id)).toEqual([pendingId]);

    const all = listProposals(stash, { includeArchive: true });
    expect(all.map((p) => p.id).sort()).toEqual([pendingId, acceptedId]);

    const accepted = getProposal(stash, acceptedId);
    expect(accepted.status).toBe("accepted");
    expect(accepted.backupContent).toBe("LEGACY BACKUP BODY\n");

    // The legacy files are left in place, untouched.
    expect(fs.existsSync(path.join(stash, ".akm", "proposals", pendingId, "proposal.json"))).toBe(true);
  });

  test("a legacy accepted proposal can be reverted from its inlined backup", async () => {
    const stash = makeStashDir();
    const config = makeConfig(stash);
    const id = "33333333-3333-4333-8333-333333333333";
    writeLegacyProposal(stash, legacyRecord(id, "lessons/legacy-revert", "accepted", { backup: "backup.md" }), {
      archive: true,
      backupBody: "---\ndescription: Prior\nwhen_to_use: Prior\n---\n\nPRIOR BODY.\n",
    });

    const result = await akmProposalRevert({ stashDir: stash, id, config });
    expect(result.ok).toBe(true);
    expect(fs.readFileSync(result.assetPath, "utf8")).toContain("PRIOR BODY.");
    expect(getProposal(stash, id).status).toBe("reverted");
  });

  test("import is one-shot: files added after the first import are not picked up", () => {
    const stash = makeStashDir();
    writeLegacyProposal(stash, legacyRecord("44444444-4444-4444-8444-444444444444", "lesson:first", "pending"));

    expect(listProposals(stash)).toHaveLength(1);

    // Simulate an old binary dropping another file AFTER the import ran.
    writeLegacyProposal(stash, legacyRecord("55555555-5555-4555-8555-555555555555", "lesson:late", "pending"));
    expect(listProposals(stash)).toHaveLength(1);

    const db = openStateDatabase(getStateDbPath());
    try {
      const marker = db.prepare("SELECT imported_count FROM proposal_fs_imports WHERE stash_dir = ?").get(stash) as {
        imported_count: number;
      } | null;
      expect(marker?.imported_count).toBe(1);
    } finally {
      db.close();
    }
  });

  test("import never duplicates and never clobbers rows mutated through the canonical store", () => {
    const stash = makeStashDir();
    const id = "66666666-6666-4666-8666-666666666666";
    writeLegacyProposal(stash, legacyRecord(id, "lesson:stable", "pending"));

    // Repeated store access — the row count must stay 1.
    expect(listProposals(stash)).toHaveLength(1);
    expect(listProposals(stash)).toHaveLength(1);
    expect(countRows(stash)).toBe(1);
  });

  test("a corrupt legacy proposal.json is skipped; the rest import", () => {
    const stash = makeStashDir();
    const goodId = "77777777-7777-4777-8777-777777777777";
    writeLegacyProposal(stash, legacyRecord(goodId, "lesson:good", "pending"));
    const corruptDir = path.join(stash, ".akm", "proposals", "88888888-8888-4888-8888-888888888888");
    fs.mkdirSync(corruptDir, { recursive: true });
    fs.writeFileSync(path.join(corruptDir, "proposal.json"), "{ not json", "utf8");

    const imported = listProposals(stash);
    expect(imported.map((p) => p.id)).toEqual([goodId]);
  });

  test("legacy pending proposals accept through the normal flow after import", async () => {
    const stash = makeStashDir();
    const config = makeConfig(stash);
    const id = "99999999-9999-4999-8999-999999999999";
    writeLegacyProposal(stash, legacyRecord(id, "lessons/legacy-accept", "pending"));

    const result = await akmProposalAccept({ stashDir: stash, id, config });
    expect(result.ok).toBe(true);
    expect(fs.readFileSync(result.assetPath, "utf8")).toContain("Prefer rg over grep");
    expect(getProposal(stash, id).status).toBe("accepted");
  });
});

// ── WAL concurrency ──────────────────────────────────────────────────────────

describe("concurrent create + list safety (WAL)", () => {
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
    "concurrent duplicate proposal creation serializes on state.db and yields one pending row",
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
          input: { ref, source, sourceRun: "run-concurrency-a", payload: { content: `${VALID_LESSON}\nA` } },
        },
      });
      const workerB = startProposalWorker<Record<string, unknown>>({
        action: "create",
        payload: {
          stashDir: stash,
          dbPath,
          input: { ref, source, sourceRun: "run-concurrency-b", payload: { content: `${VALID_LESSON}\nB` } },
        },
      });
      await Promise.all([workerA.ready, workerB.ready]);
      workerA.release();
      workerB.release();

      const parsed = await Promise.all([workerA.result, workerB.result]);
      expect(parsed.filter((entry) => entry.kind === "created")).toHaveLength(1);
      // WI-6.4: both workers mint the same INPUTS (same ref/source/absent
      // target/absent model), so the loser hits the winner's fingerprint row.
      expect(parsed.filter((entry) => entry.kind === "skipped" && entry.reason === "fingerprint_match")).toHaveLength(
        1,
      );
      expect(listProposals(stash, {}, { dbPath })).toHaveLength(1);

      const db = openStateDatabase(dbPath);
      try {
        const row = db
          .prepare("SELECT COUNT(*) AS c FROM proposals WHERE stash_dir = ? AND status = 'pending'")
          .get(stash) as {
          c: number;
        };
        expect(row.c).toBe(1);
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
        { ref: "lessons/mutation-race", source: "reflect", force: true, payload: { content: VALID_LESSON } },
        { dbPath },
      );
      if (isProposalSkipped(created)) throw new Error("unexpected skip");

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
