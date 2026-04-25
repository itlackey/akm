import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveSourceProviderFactory } from "../../src/source-provider-factory";

// Trigger self-registration
import "../../src/source-providers/filesystem";

const createdTmpDirs: string[] = [];

function createTmpDir(prefix = "akm-fs-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  createdTmpDirs.push(dir);
  return dir;
}

const originalAkmStashDir = process.env.AKM_STASH_DIR;

beforeEach(() => {
  process.env.AKM_STASH_DIR = createTmpDir("akm-fs-stash-");
});

afterEach(() => {
  if (originalAkmStashDir === undefined) delete process.env.AKM_STASH_DIR;
  else process.env.AKM_STASH_DIR = originalAkmStashDir;
});

afterAll(() => {
  for (const dir of createdTmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("FilesystemSourceProvider", () => {
  test("self-registers as 'filesystem'", () => {
    expect(resolveSourceProviderFactory("filesystem")).toBeTruthy();
  });

  test("init resolves and path returns the configured path", async () => {
    const factory = resolveSourceProviderFactory("filesystem");
    expect(factory).toBeTruthy();
    if (!factory) throw new Error("expected filesystem factory to be registered");

    const stashDir = createTmpDir("akm-fs-init-");
    const provider = factory({ type: "filesystem", path: stashDir, name: "mine" });

    await provider.init({
      name: "mine",
      options: {},
      cacheDir: stashDir,
      resolveOption: (v) => (typeof v === "string" ? v : undefined),
    });

    expect(provider.kind).toBe("filesystem");
    expect(provider.name).toBe("mine");
    expect(provider.path()).toBe(stashDir);
  });

  test("path() returns the same value across calls (lifetime stability)", () => {
    const factory = resolveSourceProviderFactory("filesystem");
    expect(factory).toBeTruthy();
    if (!factory) throw new Error("expected filesystem factory to be registered");

    const stashDir = createTmpDir("akm-fs-stable-");
    const provider = factory({ type: "filesystem", path: stashDir, name: "stable" });
    const first = provider.path();
    const second = provider.path();
    expect(second).toBe(first);
  });

  test("filesystem providers have no sync() (content is user-managed)", () => {
    const factory = resolveSourceProviderFactory("filesystem");
    expect(factory).toBeTruthy();
    if (!factory) throw new Error("expected filesystem factory to be registered");

    const stashDir = createTmpDir("akm-fs-nosync-");
    const provider = factory({ type: "filesystem", path: stashDir, name: "nosync" });
    expect(provider.sync).toBeUndefined();
  });

  test("provider exposes only the v1 SourceProvider surface", () => {
    const factory = resolveSourceProviderFactory("filesystem");
    expect(factory).toBeTruthy();
    if (!factory) throw new Error("expected filesystem factory to be registered");

    const stashDir = createTmpDir("akm-fs-iface-");
    const provider = factory({ type: "filesystem", path: stashDir });
    expect((provider as unknown as { search?: unknown }).search).toBeUndefined();
    expect((provider as unknown as { show?: unknown }).show).toBeUndefined();
    expect((provider as unknown as { canShow?: unknown }).canShow).toBeUndefined();
    expect((provider as unknown as { getContentDir?: unknown }).getContentDir).toBeUndefined();
  });
});
