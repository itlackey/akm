import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { narrowToIncrementalCandidates } from "../src/commands/consolidate";

// NOTE: this suite only exercises the two pre-DB branches of
// narrowToIncrementalCandidates (nothing-changed → []; everything-changed →
// full pool returned before any openExistingDatabase() call). It reads file
// mtimes via the MemoryEntry.filePath we pass in and never resolves an AKM
// stash/data dir, so NO AKM env-var isolation is needed — the mkdtemp dir below
// is generic fixture storage for the memory files, nothing more.

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
