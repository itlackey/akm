import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { getLockfileLockPath } from "../../src/core/paths";
import {
  type LockfileEntry,
  readLockfile,
  removeLockEntry,
  upsertLockEntry,
  writeLockfile,
} from "../../src/integrations/lockfile";
import { type Cleanup, sandboxXdgDataHome } from "../_helpers/sandbox";

// ── Helpers ─────────────────────────────────────────────────────────────────

// akm.lock lives in getDataDir() = $XDG_DATA_HOME/akm/akm.lock
let testDataDir = "";
let envCleanup: Cleanup = () => {};

function getLockfilePath(): string {
  return path.join(testDataDir, "akm", "akm.lock");
}

function writeRawLockfile(content: string): void {
  const lockPath = getLockfilePath();
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, content, "utf8");
}

function validEntry(overrides?: Partial<LockfileEntry>): LockfileEntry {
  return {
    id: "test-entry",
    source: "npm",
    ref: "@scope/pkg",
    ...overrides,
  };
}

beforeEach(() => {
  const dataResult = sandboxXdgDataHome();
  testDataDir = dataResult.dir;
  envCleanup = dataResult.cleanup;
});

afterEach(() => {
  envCleanup();
  envCleanup = () => {};
  testDataDir = "";
});

// ── readLockfile ────────────────────────────────────────────────────────────

describe("readLockfile", () => {
  test("returns empty array when lockfile does not exist", () => {
    expect(readLockfile()).toEqual([]);
  });

  test("returns empty array for corrupted JSON", () => {
    writeRawLockfile("not valid json {{{");
    expect(readLockfile()).toEqual([]);
  });

  test("returns empty array for non-array JSON", () => {
    writeRawLockfile('{"key": "value"}');
    expect(readLockfile()).toEqual([]);
  });

  test("returns empty array for JSON string value", () => {
    writeRawLockfile('"just a string"');
    expect(readLockfile()).toEqual([]);
  });

  test("reads valid entries", () => {
    const entries = [validEntry()];
    writeRawLockfile(JSON.stringify(entries));
    const result = readLockfile();
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("test-entry");
    expect(result[0]!.source).toBe("npm");
    expect(result[0]!.ref).toBe("@scope/pkg");
  });

  test("filters out invalid entries from the array", () => {
    const raw = [
      validEntry(),
      { id: "", source: "npm", ref: "pkg" }, // empty id
      { id: "x", source: "invalid-source", ref: "y" }, // bad source
      { id: "y", source: "github", ref: "" }, // empty ref
      null,
      42,
      "string",
      { source: "npm", ref: "no-id" }, // missing id
    ];
    writeRawLockfile(JSON.stringify(raw));
    const result = readLockfile();
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("test-entry");
  });

  test("preserves optional fields on valid entries", () => {
    const entry = validEntry({
      resolvedVersion: "1.2.3",
      resolvedRevision: "abc123",
      integrity: "sha512-xyz",
    });
    writeRawLockfile(JSON.stringify([entry]));
    const result = readLockfile();
    expect(result).toHaveLength(1);
    expect(result[0]!.resolvedVersion).toBe("1.2.3");
    expect(result[0]!.resolvedRevision).toBe("abc123");
    expect(result[0]!.integrity).toBe("sha512-xyz");
  });

  test("preserves the §10.2 bundle-lock fields (localRoot, manifestDigest, adapterIds, installedAt)", () => {
    const entry = validEntry({
      localRoot: "/cache/kit/content",
      manifestDigest: "sha256-manifest",
      adapterIds: ["akm", "okf"],
      installedAt: "2026-07-20T00:00:00Z",
    });
    writeRawLockfile(JSON.stringify([entry]));
    const result = readLockfile();
    expect(result).toHaveLength(1);
    expect(result[0]!.localRoot).toBe("/cache/kit/content");
    expect(result[0]!.manifestDigest).toBe("sha256-manifest");
    expect(result[0]!.adapterIds).toEqual(["akm", "okf"]);
    expect(result[0]!.installedAt).toBe("2026-07-20T00:00:00Z");
  });

  test("reads a pre-cutover per-source entry unchanged (shape-tolerant read)", () => {
    // The old shape had only id/source/ref (+ resolved*). It stays valid and the
    // absent §10.2 fields are simply undefined until the next upsert.
    writeRawLockfile(JSON.stringify([{ id: "old", source: "git", ref: "owner/repo", resolvedRevision: "deadbeef" }]));
    const result = readLockfile();
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: "old", source: "git", ref: "owner/repo", resolvedRevision: "deadbeef" });
    expect(result[0]!.localRoot).toBeUndefined();
  });

  test("accepts all valid source types", () => {
    const entries = [
      validEntry({ id: "a", source: "npm" }),
      validEntry({ id: "b", source: "github" }),
      validEntry({ id: "c", source: "git" }),
      validEntry({ id: "d", source: "local" }),
    ];
    writeRawLockfile(JSON.stringify(entries));
    const result = readLockfile();
    expect(result).toHaveLength(4);
  });
});

// ── writeLockfile ───────────────────────────────────────────────────────────

describe("writeLockfile", () => {
  test("writes formatted JSON with trailing newline", async () => {
    const entries = [validEntry()];
    await writeLockfile(entries);
    const raw = fs.readFileSync(getLockfilePath(), "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(JSON.parse(raw)).toEqual(entries);
    expect(raw).toContain("  "); // pretty-printed
  });

  test("creates directory structure if not present", async () => {
    const entries = [validEntry()];
    await writeLockfile(entries);
    expect(fs.existsSync(getLockfilePath())).toBe(true);
  });

  test("overwrites existing lockfile atomically", async () => {
    await writeLockfile([validEntry({ id: "first" })]);
    await writeLockfile([validEntry({ id: "second" })]);
    const result = readLockfile();
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("second");
  });

  test("does not leave temp file on success", async () => {
    await writeLockfile([validEntry()]);
    const dir = path.dirname(getLockfilePath());
    const files = fs.readdirSync(dir);
    const tmpFiles = files.filter((f) => f.includes(".tmp."));
    expect(tmpFiles).toHaveLength(0);
  });

  test("writes empty array", async () => {
    await writeLockfile([]);
    const raw = fs.readFileSync(getLockfilePath(), "utf8");
    expect(JSON.parse(raw)).toEqual([]);
  });

  test("roundtrips with readLockfile", async () => {
    const entries = [
      validEntry({ id: "a", source: "github", ref: "owner/repo" }),
      validEntry({ id: "b", source: "npm", ref: "@scope/pkg" }),
    ];
    await writeLockfile(entries);
    expect(readLockfile()).toEqual(entries);
  });

  test("fails closed when another live writer owns the sentinel", async () => {
    await writeLockfile([validEntry({ id: "original" })]);
    fs.writeFileSync(getLockfileLockPath(), String(process.pid), { flag: "wx" });

    await expect(writeLockfile([validEntry({ id: "forbidden" })])).rejects.toThrow(
      /refusing to write without exclusive ownership/,
    );
    expect(readLockfile().map((entry) => entry.id)).toEqual(["original"]);
  });
});

// ── upsertLockEntry ─────────────────────────────────────────────────────────

describe("upsertLockEntry", () => {
  test("adds entry when lockfile is empty", async () => {
    await upsertLockEntry(validEntry({ id: "new-entry" }));
    const result = readLockfile();
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("new-entry");
  });

  test("adds entry when lockfile does not exist", async () => {
    await upsertLockEntry(validEntry({ id: "first" }));
    expect(readLockfile()).toHaveLength(1);
  });

  test("replaces entry with same id", async () => {
    await writeLockfile([validEntry({ id: "pkg", ref: "old-ref" })]);
    await upsertLockEntry(validEntry({ id: "pkg", ref: "new-ref" }));
    const result = readLockfile();
    expect(result).toHaveLength(1);
    expect(result[0]!.ref).toBe("new-ref");
  });

  test("preserves other entries when upserting", async () => {
    await writeLockfile([validEntry({ id: "keep-me", ref: "keep" }), validEntry({ id: "update-me", ref: "old" })]);
    await upsertLockEntry(validEntry({ id: "update-me", ref: "new" }));
    const result = readLockfile();
    expect(result).toHaveLength(2);
    const kept = result.find((e) => e.id === "keep-me");
    const updated = result.find((e) => e.id === "update-me");
    expect(kept?.ref).toBe("keep");
    expect(updated?.ref).toBe("new");
  });

  test("appends new entry when id does not exist", async () => {
    await writeLockfile([validEntry({ id: "existing" })]);
    await upsertLockEntry(validEntry({ id: "brand-new" }));
    const result = readLockfile();
    expect(result).toHaveLength(2);
  });
});

// ── removeLockEntry ─────────────────────────────────────────────────────────

describe("removeLockEntry", () => {
  test("removes entry by id", async () => {
    await writeLockfile([validEntry({ id: "remove-me" }), validEntry({ id: "keep-me" })]);
    await removeLockEntry("remove-me");
    const result = readLockfile();
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("keep-me");
  });

  test("no-op when id does not exist", async () => {
    await writeLockfile([validEntry({ id: "existing" })]);
    await removeLockEntry("nonexistent");
    const result = readLockfile();
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("existing");
  });

  test("works when lockfile does not exist", async () => {
    // Should not throw
    await removeLockEntry("anything");
    expect(readLockfile()).toEqual([]);
  });

  test("removes all entries if all match", async () => {
    await writeLockfile([validEntry({ id: "only-one" })]);
    await removeLockEntry("only-one");
    expect(readLockfile()).toEqual([]);
  });
});
