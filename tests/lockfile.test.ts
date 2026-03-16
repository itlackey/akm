import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type LockfileEntry, readLockfile, removeLockEntry, upsertLockEntry, writeLockfile } from "../src/lockfile";

// ── Helpers ─────────────────────────────────────────────────────────────────

const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;

let testConfigDir = "";

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "akm-lockfile-test-"));
}

function getLockfilePath(): string {
  return path.join(testConfigDir, "akm", "stash.lock");
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
  testConfigDir = makeTmpDir();
  process.env.XDG_CONFIG_HOME = testConfigDir;
});

afterEach(() => {
  if (originalXdgConfigHome === undefined) {
    delete process.env.XDG_CONFIG_HOME;
  } else {
    process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
  }
  if (testConfigDir) {
    fs.rmSync(testConfigDir, { recursive: true, force: true });
    testConfigDir = "";
  }
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
    expect(result[0].id).toBe("test-entry");
    expect(result[0].source).toBe("npm");
    expect(result[0].ref).toBe("@scope/pkg");
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
    expect(result[0].id).toBe("test-entry");
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
    expect(result[0].resolvedVersion).toBe("1.2.3");
    expect(result[0].resolvedRevision).toBe("abc123");
    expect(result[0].integrity).toBe("sha512-xyz");
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
  test("writes formatted JSON with trailing newline", () => {
    const entries = [validEntry()];
    writeLockfile(entries);
    const raw = fs.readFileSync(getLockfilePath(), "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(JSON.parse(raw)).toEqual(entries);
    expect(raw).toContain("  "); // pretty-printed
  });

  test("creates directory structure if not present", () => {
    const entries = [validEntry()];
    writeLockfile(entries);
    expect(fs.existsSync(getLockfilePath())).toBe(true);
  });

  test("overwrites existing lockfile atomically", () => {
    writeLockfile([validEntry({ id: "first" })]);
    writeLockfile([validEntry({ id: "second" })]);
    const result = readLockfile();
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("second");
  });

  test("does not leave temp file on success", () => {
    writeLockfile([validEntry()]);
    const dir = path.dirname(getLockfilePath());
    const files = fs.readdirSync(dir);
    const tmpFiles = files.filter((f) => f.includes(".tmp."));
    expect(tmpFiles).toHaveLength(0);
  });

  test("writes empty array", () => {
    writeLockfile([]);
    const raw = fs.readFileSync(getLockfilePath(), "utf8");
    expect(JSON.parse(raw)).toEqual([]);
  });

  test("roundtrips with readLockfile", () => {
    const entries = [
      validEntry({ id: "a", source: "github", ref: "owner/repo" }),
      validEntry({ id: "b", source: "npm", ref: "@scope/pkg" }),
    ];
    writeLockfile(entries);
    expect(readLockfile()).toEqual(entries);
  });
});

// ── upsertLockEntry ─────────────────────────────────────────────────────────

describe("upsertLockEntry", () => {
  test("adds entry when lockfile is empty", async () => {
    await upsertLockEntry(validEntry({ id: "new-entry" }));
    const result = readLockfile();
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("new-entry");
  });

  test("adds entry when lockfile does not exist", async () => {
    await upsertLockEntry(validEntry({ id: "first" }));
    expect(readLockfile()).toHaveLength(1);
  });

  test("replaces entry with same id", async () => {
    writeLockfile([validEntry({ id: "pkg", ref: "old-ref" })]);
    await upsertLockEntry(validEntry({ id: "pkg", ref: "new-ref" }));
    const result = readLockfile();
    expect(result).toHaveLength(1);
    expect(result[0].ref).toBe("new-ref");
  });

  test("preserves other entries when upserting", async () => {
    writeLockfile([validEntry({ id: "keep-me", ref: "keep" }), validEntry({ id: "update-me", ref: "old" })]);
    await upsertLockEntry(validEntry({ id: "update-me", ref: "new" }));
    const result = readLockfile();
    expect(result).toHaveLength(2);
    const kept = result.find((e) => e.id === "keep-me");
    const updated = result.find((e) => e.id === "update-me");
    expect(kept?.ref).toBe("keep");
    expect(updated?.ref).toBe("new");
  });

  test("appends new entry when id does not exist", async () => {
    writeLockfile([validEntry({ id: "existing" })]);
    await upsertLockEntry(validEntry({ id: "brand-new" }));
    const result = readLockfile();
    expect(result).toHaveLength(2);
  });
});

// ── removeLockEntry ─────────────────────────────────────────────────────────

describe("removeLockEntry", () => {
  test("removes entry by id", () => {
    writeLockfile([validEntry({ id: "remove-me" }), validEntry({ id: "keep-me" })]);
    removeLockEntry("remove-me");
    const result = readLockfile();
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("keep-me");
  });

  test("no-op when id does not exist", () => {
    writeLockfile([validEntry({ id: "existing" })]);
    removeLockEntry("nonexistent");
    const result = readLockfile();
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("existing");
  });

  test("works when lockfile does not exist", () => {
    // Should not throw
    removeLockEntry("anything");
    expect(readLockfile()).toEqual([]);
  });

  test("removes all entries if all match", () => {
    writeLockfile([validEntry({ id: "only-one" })]);
    removeLockEntry("only-one");
    expect(readLockfile()).toEqual([]);
  });
});
