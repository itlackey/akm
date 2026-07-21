import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { resetConfigCache } from "../../src/core/config/config";
import { getDbPath } from "../../src/core/paths";
import {
  ensurePrimaryIndexForRead,
  ensurePrimaryIndexFromConfig,
  resolveReadSources,
} from "../../src/indexer/read-preflight";
import {
  type IsolatedAkmStorage,
  makeSandboxDir,
  withIsolatedAkmStorage,
  writeSandboxConfig,
} from "../_helpers/sandbox";

describe("read preflight helpers", () => {
  let storage: IsolatedAkmStorage;
  const disposers: Array<() => void> = [];

  beforeEach(() => {
    storage = withIsolatedAkmStorage();
    resetConfigCache();
  });

  afterEach(() => {
    for (const dispose of disposers.splice(0)) {
      dispose();
    }
    storage.cleanup();
  });

  test("resolves configured sources in primary-first order", () => {
    const additional = makeSandboxDir("akm-read-source-");
    disposers.push(additional.cleanup);
    for (const dir of [additional.dir]) {
      fs.mkdirSync(path.join(dir, "skills"), { recursive: true });
    }

    writeSandboxConfig({
      bundles: {
        primary: { path: storage.stashDir },
        library: { path: additional.dir },
      },
      defaultBundle: "primary",
    });
    resetConfigCache();

    const { sources, primarySource } = resolveReadSources();
    expect(primarySource?.path).toBe(storage.stashDir);
    expect(sources[0].path).toBe(storage.stashDir);
    expect(sources.some((source) => source.path === additional.dir)).toBe(true);
  });

  test("ensures primary index bootstrap for current config", async () => {
    const knowledgeFile = path.join(storage.stashDir, "knowledge", "bootstrap.md");
    fs.writeFileSync(knowledgeFile, "# bootstrap\n", "utf8");

    const ensured = await ensurePrimaryIndexFromConfig();
    expect(ensured).toBe(true);
    expect(fs.existsSync(getDbPath())).toBe(true);
  });

  test("returns false when primary source is not provided", async () => {
    const ensured = await ensurePrimaryIndexForRead();
    expect(ensured).toBe(false);
  });
});
