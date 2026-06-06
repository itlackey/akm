import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { narrowToIncrementalCandidates } from "../../../src/commands/consolidate";
import { getDbPath } from "../../../src/core/paths";
import { closeDatabase, openDatabase, upsertEmbedding, upsertEntry } from "../../../src/indexer/db";
import type { StashEntry } from "../../../src/indexer/metadata";
import { type Cleanup, sandboxXdgDataHome } from "../../_helpers/sandbox";

// NOTE: the first `describe` block exercises the two pre-DB branches of
// narrowToIncrementalCandidates (nothing-changed → []; everything-changed →
// full pool returned before any openExistingDatabase() call). It reads file
// mtimes via the MemoryEntry.filePath we pass in and never resolves an AKM
// stash/data dir, so NO AKM env-var isolation is needed — the mkdtemp dir below
// is generic fixture storage for the memory files, nothing more.
//
// The second `describe` block exercises the MIXED branch, which DOES open the
// real index DB via openExistingDatabase() → getDbPath() → getDataDir(). It
// therefore sandboxes XDG_DATA_HOME (via the sandbox helper, not raw
// process.env) so the test never touches real user data and the lint-tests
// isolation guard stays happy. We build a genuine sqlite index with hand-
// crafted unit-vector embeddings so the real searchVec → getNeighborsByEntryId
// path resolves deterministic neighbours offline (no embedding server needed).

// Minimal MemoryEntry shape used by narrowToIncrementalCandidates. Only `name`
// and `filePath` are read by the function under test; the rest satisfy the type.
function makeMemory(
  stashDir: string,
  name: string,
): {
  name: string;
  filePath: string;
  description: string;
  tags: string[];
  stashDir: string;
} {
  const filePath = path.join(stashDir, "memory", `${name}.md`);
  fs.writeFileSync(filePath, `---\nname: ${name}\n---\nbody for ${name}\n`, "utf8");
  return { name, filePath, description: "", tags: [], stashDir };
}

describe("narrowToIncrementalCandidates", () => {
  let tmpDir: string;
  let stashDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-consol-incr-"));
    // Generic fixture dir for the memory files — not resolved as an AKM stash.
    stashDir = path.join(tmpDir, "stash");
    fs.mkdirSync(path.join(stashDir, "memory"), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // Helper: set a file's mtime to an offset (seconds) from `base`.
  function setMtime(filePath: string, epochSeconds: number): void {
    fs.utimesSync(filePath, epochSeconds, epochSeconds);
  }

  it("returns [] when nothing changed (all mtimes <= since) — no DB access", () => {
    const a = makeMemory(stashDir, "alpha");
    const b = makeMemory(stashDir, "beta");
    // since is in the future relative to the files' mtimes.
    const sinceEpoch = 2_000_000_000; // 2033
    setMtime(a.filePath, sinceEpoch - 1000);
    setMtime(b.filePath, sinceEpoch - 1000);
    const since = new Date(sinceEpoch * 1000).toISOString();

    const warnings: string[] = [];
    const result = narrowToIncrementalCandidates([a, b], since, warnings);

    expect(result).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("returns the full array unchanged when everything changed — does NOT open DB", () => {
    const a = makeMemory(stashDir, "alpha");
    const b = makeMemory(stashDir, "beta");
    // since is in the past relative to the files' mtimes.
    const sinceEpoch = 1_000_000_000; // 2001
    setMtime(a.filePath, sinceEpoch + 1000);
    setMtime(b.filePath, sinceEpoch + 1000);
    const since = new Date(sinceEpoch * 1000).toISOString();

    const warnings: string[] = [];
    const input = [a, b];
    const result = narrowToIncrementalCandidates(input, since, warnings);

    // Same reference / identical contents: returns the pool as-is, before any
    // DB access (no index exists in this temp dir, so opening one would either
    // throw — surfacing a warning — or return nothing; neither happens here).
    expect(result).toBe(input);
    expect(warnings).toEqual([]);
  });
});

describe("narrowToIncrementalCandidates — mixed branch (real index DB)", () => {
  // XDG_DATA_HOME sandbox so openExistingDatabase()/getDbPath() resolve into an
  // isolated temp dir under bun test. Uses the sandbox helper (not raw
  // process.env) to satisfy the test-isolation lint.
  let dataCleanup: Cleanup = () => {};
  let tmpDir: string;
  let memDir: string;

  beforeEach(() => {
    const data = sandboxXdgDataHome();
    dataCleanup = data.cleanup;
    // Generic fixture dir for the memory .md files whose mtimes we control.
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-consol-mixed-"));
    memDir = path.join(tmpDir, "memory");
    fs.mkdirSync(memDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    dataCleanup();
    dataCleanup = () => {};
  });

  // The function under test stats each memory's filePath to decide "changed".
  // We write the .md file and set its mtime explicitly.
  function makeMemory(name: string, mtimeEpochSeconds: number) {
    const filePath = path.join(memDir, `${name}.md`);
    fs.writeFileSync(filePath, `---\nname: ${name}\n---\nbody for ${name}\n`, "utf8");
    fs.utimesSync(filePath, mtimeEpochSeconds, mtimeEpochSeconds);
    return { name, filePath, description: "", tags: [] as string[], stashDir: tmpDir };
  }

  // Insert an indexed memory entry + its embedding into the real index DB so
  // findEntryIdByRef("memory:NAME") and getNeighborsByEntryId() resolve it.
  // The dim-4 unit vectors are crafted so cosine similarity (the JS fallback in
  // searchBlobVec, and sqlite-vec when present) ranks neighbours deterministically.
  function indexMemory(db: ReturnType<typeof openDatabase>, name: string, embedding: number[]): number {
    const entry: StashEntry = { type: "memory", name, description: `desc for ${name}` };
    const id = upsertEntry(
      db,
      `memory:${name}`,
      tmpDir,
      path.join(memDir, `${name}.md`),
      tmpDir,
      entry,
      `${name} ${entry.description}`,
    );
    upsertEmbedding(db, id, embedding);
    return id;
  }

  const DIM = 4;

  // narrowToIncrementalCandidates keeps EVERY top-k neighbour of a changed
  // memory (k = NEIGHBORS_PER_CHANGED = 5, queried as k+1 = 6 including self).
  // There is no distance threshold, so to prove B and D are excluded we must
  // index enough closer-to-A "padding" entries to push B and D past rank 6.
  // The padding entries are NOT passed in the loaded pool, so they are ignored
  // by the byName.has() guard — they only consume top-k slots. We craft
  // embeddings on the unit circle in the (x, y) plane by angle: smaller angle
  // to A = higher cosine = closer. C sits just past the padding; B/D sit well
  // beyond rank 6.
  function vecAtAngle(deg: number): number[] {
    const r = (deg * Math.PI) / 180;
    return [Math.cos(r), Math.sin(r), 0, 0];
  }

  it("returns {changed ∪ in-pool neighbours}: A changed, A's nearest is C → {A, C}", () => {
    // A changed (future mtime); B, C, D unchanged (past mtime).
    const sinceEpoch = 1_500_000_000;
    const since = new Date(sinceEpoch * 1000).toISOString();
    const a = makeMemory("alpha", sinceEpoch + 1000);
    const b = makeMemory("beta", sinceEpoch - 1000);
    const c = makeMemory("gamma", sinceEpoch - 1000);
    const d = makeMemory("delta", sinceEpoch - 1000);

    // Angles from A's direction (0°): C at 5° is among A's nearest. Five padding
    // entries at 1°..4.5° are even closer, filling 5 of the 6 top-k slots
    // alongside A itself — so C lands at rank 6 (kept), while B (90°) and
    // D (180°) are ranks 7+ and excluded.
    const db = openDatabase(getDbPath(), { embeddingDim: DIM });
    try {
      indexMemory(db, "alpha", vecAtAngle(0));
      indexMemory(db, "gamma", vecAtAngle(5)); // C — in pool, kept neighbour
      // padding (not in the loaded pool) — closer to A than C, consume top-k slots
      indexMemory(db, "pad1", vecAtAngle(1));
      indexMemory(db, "pad2", vecAtAngle(2));
      indexMemory(db, "pad3", vecAtAngle(3));
      indexMemory(db, "pad4", vecAtAngle(4));
      indexMemory(db, "beta", vecAtAngle(90)); // B — orthogonal, far
      indexMemory(db, "delta", vecAtAngle(180)); // D — opposite, far
    } finally {
      closeDatabase(db);
    }

    const warnings: string[] = [];
    const result = narrowToIncrementalCandidates([a, b, c, d], since, warnings);

    const names = new Set(result.map((m) => m.name));
    expect(names).toEqual(new Set(["alpha", "gamma"]));
    expect(result).toHaveLength(2);
    // beta and delta must be excluded.
    expect(names.has("beta")).toBe(false);
    expect(names.has("delta")).toBe(false);
    // The "N changed + neighbours → M/total" warning is pushed.
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("1 changed + neighbours");
    expect(warnings[0]).toContain("2/4 memories considered");
  });

  it("ignores a neighbour that is NOT in the loaded pool", () => {
    const sinceEpoch = 1_500_000_000;
    const since = new Date(sinceEpoch * 1000).toISOString();
    const a = makeMemory("alpha", sinceEpoch + 1000);
    const b = makeMemory("beta", sinceEpoch - 1000);

    // Index alpha, beta, a "ghost" that is alpha's nearest neighbour, plus
    // padding — all closer to A than beta. ghost and padding are never passed
    // in `memories`, so the byName.has() guard drops them. beta (90°) is far
    // enough that it lands past rank 6 → excluded too. Net: only alpha kept.
    const db = openDatabase(getDbPath(), { embeddingDim: DIM });
    try {
      indexMemory(db, "alpha", vecAtAngle(0));
      indexMemory(db, "ghost", vecAtAngle(5)); // nearest to alpha, not in pool
      indexMemory(db, "pad1", vecAtAngle(1));
      indexMemory(db, "pad2", vecAtAngle(2));
      indexMemory(db, "pad3", vecAtAngle(3));
      indexMemory(db, "pad4", vecAtAngle(4));
      indexMemory(db, "beta", vecAtAngle(90)); // far → outside top-k
    } finally {
      closeDatabase(db);
    }

    const warnings: string[] = [];
    const result = narrowToIncrementalCandidates([a, b], since, warnings);

    const names = new Set(result.map((m) => m.name));
    // Only the changed memory survives — ghost/padding are out-of-pool, beta is far.
    expect(names).toEqual(new Set(["alpha"]));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("1 changed + neighbours");
    expect(warnings[0]).toContain("1/2 memories considered");
  });

  it("fails open to the full pool when the index is absent (empty data dir)", () => {
    // XDG_DATA_HOME is sandboxed to a fresh empty dir and we never create an
    // index.db, so openExistingDatabase() throws → fail-open + warning.
    const sinceEpoch = 1_500_000_000;
    const since = new Date(sinceEpoch * 1000).toISOString();
    const a = makeMemory("alpha", sinceEpoch + 1000);
    const b = makeMemory("beta", sinceEpoch - 1000);

    const warnings: string[] = [];
    const input = [a, b];
    const result = narrowToIncrementalCandidates(input, since, warnings);

    // Mixed branch (1 changed, 1 not) hits the DB path, which throws → full pool.
    expect(result).toBe(input);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("index unavailable");
  });
});
