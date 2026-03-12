import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { saveConfig } from "../src/config";
import {
  findSourceForPath,
  getPrimarySource,
  isEditable,
  resolveAllStashDirs,
  resolveStashSources,
} from "../src/stash-source";

const originalStashDir = process.env.AKM_STASH_DIR;
const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
let testConfigDir = "";
let stashDir = "";

beforeEach(() => {
  testConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-source-config-"));
  stashDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-source-stash-"));
  for (const sub of ["scripts", "skills", "commands", "agents", "knowledge"]) {
    fs.mkdirSync(path.join(stashDir, sub), { recursive: true });
  }
  process.env.XDG_CONFIG_HOME = testConfigDir;
  process.env.AKM_STASH_DIR = stashDir;
});

afterEach(() => {
  process.env.AKM_STASH_DIR = originalStashDir ?? undefined;
  if (originalXdgConfigHome === undefined) {
    delete process.env.XDG_CONFIG_HOME;
  } else {
    process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
  }
  if (testConfigDir) fs.rmSync(testConfigDir, { recursive: true, force: true });
  if (stashDir) fs.rmSync(stashDir, { recursive: true, force: true });
});

describe("resolveStashSources", () => {
  test("returns primary stash as first source", () => {
    saveConfig({ semanticSearch: false, searchPaths: [] });
    const sources = resolveStashSources();
    expect(sources.length).toBeGreaterThanOrEqual(1);
    expect(sources[0].path).toBe(stashDir);
    expect(sources[0].registryId).toBeUndefined();
  });

  test("includes valid search paths", () => {
    const extraDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-extra-"));
    try {
      saveConfig({ semanticSearch: false, searchPaths: [extraDir] });
      const sources = resolveStashSources();
      expect(sources.length).toBe(2);
      expect(sources[1].path).toBe(extraDir);
      expect(sources[1].registryId).toBeUndefined();
    } finally {
      fs.rmSync(extraDir, { recursive: true, force: true });
    }
  });

  test("skips non-existent search paths", () => {
    saveConfig({ semanticSearch: false, searchPaths: ["/nonexistent/path/should/not/exist"] });
    const sources = resolveStashSources();
    expect(sources.length).toBe(1);
  });

  test("includes installed registry entries with registryId", () => {
    const installedDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-installed-"));
    try {
      saveConfig({
        semanticSearch: false,
        searchPaths: [],
        installed: [
          {
            id: "npm:test-pkg",
            source: "npm",
            ref: "npm:test-pkg@1.0.0",
            artifactUrl: "https://example.test/test-pkg.tgz",
            stashRoot: installedDir,
            cacheDir: installedDir,
            installedAt: new Date().toISOString(),
          },
        ],
      });
      const sources = resolveStashSources();
      const installed = sources.find((s) => s.registryId === "npm:test-pkg");
      expect(installed).toBeDefined();
      expect(installed?.path).toBe(installedDir);
    } finally {
      fs.rmSync(installedDir, { recursive: true, force: true });
    }
  });

  test("preserves ordering: primary, search paths, installed", () => {
    const extraDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-extra-"));
    const installedDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-installed-"));
    try {
      saveConfig({
        semanticSearch: false,
        searchPaths: [extraDir],
        installed: [
          {
            id: "npm:test-pkg",
            source: "npm",
            ref: "npm:test-pkg@1.0.0",
            artifactUrl: "https://example.test/test-pkg.tgz",
            stashRoot: installedDir,
            cacheDir: installedDir,
            installedAt: new Date().toISOString(),
          },
        ],
      });
      const sources = resolveStashSources();
      expect(sources[0].path).toBe(stashDir);
      expect(sources[0].registryId).toBeUndefined();
      expect(sources[1].path).toBe(extraDir);
      expect(sources[1].registryId).toBeUndefined();
      expect(sources[2].path).toBe(installedDir);
      expect(sources[2].registryId).toBe("npm:test-pkg");
    } finally {
      fs.rmSync(extraDir, { recursive: true, force: true });
      fs.rmSync(installedDir, { recursive: true, force: true });
    }
  });

  test("accepts overrideStashDir parameter", () => {
    const overrideDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-override-"));
    try {
      saveConfig({ semanticSearch: false, searchPaths: [] });
      const sources = resolveStashSources(overrideDir);
      expect(sources[0].path).toBe(overrideDir);
    } finally {
      fs.rmSync(overrideDir, { recursive: true, force: true });
    }
  });
});

describe("resolveAllStashDirs", () => {
  test("returns just paths in correct order", () => {
    saveConfig({ semanticSearch: false, searchPaths: [] });
    const dirs = resolveAllStashDirs();
    expect(dirs[0]).toBe(stashDir);
  });
});

describe("getPrimarySource", () => {
  test("returns first source from list", () => {
    const sources = [{ path: stashDir }, { path: "/other/dir" }];
    const primary = getPrimarySource(sources);
    expect(primary).toBeDefined();
    expect(primary?.path).toBe(stashDir);
  });

  test("returns undefined for empty list", () => {
    expect(getPrimarySource([])).toBeUndefined();
  });
});

describe("findSourceForPath", () => {
  test("finds correct source for file inside primary stash", () => {
    const sources = [{ path: stashDir }, { path: "/other/dir" }];
    const filePath = path.join(stashDir, "scripts", "deploy.sh");
    const result = findSourceForPath(filePath, sources);
    expect(result).toBeDefined();
    expect(result?.path).toBe(stashDir);
  });

  test("finds correct source for file inside search path", () => {
    const extraDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-extra-"));
    try {
      const sources = [{ path: stashDir }, { path: extraDir }];
      const filePath = path.join(extraDir, "scripts", "test.sh");
      const result = findSourceForPath(filePath, sources);
      expect(result).toBeDefined();
      expect(result?.path).toBe(extraDir);
    } finally {
      fs.rmSync(extraDir, { recursive: true, force: true });
    }
  });

  test("returns undefined for file not in any source", () => {
    const sources = [{ path: stashDir }];
    const result = findSourceForPath("/completely/unrelated/path.sh", sources);
    expect(result).toBeUndefined();
  });
});

describe("isEditable", () => {
  test("files in primary stash are editable", () => {
    saveConfig({ semanticSearch: false, searchPaths: [] });
    const filePath = path.join(stashDir, "scripts", "deploy.sh");
    expect(isEditable(filePath)).toBe(true);
  });

  test("files in search paths are editable", () => {
    const extraDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-extra-"));
    try {
      saveConfig({ semanticSearch: false, searchPaths: [extraDir] });
      const filePath = path.join(extraDir, "scripts", "deploy.sh");
      expect(isEditable(filePath)).toBe(true);
    } finally {
      fs.rmSync(extraDir, { recursive: true, force: true });
    }
  });

  test("files in cache-managed dirs are NOT editable", () => {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-cache-"));
    try {
      saveConfig({
        semanticSearch: false,
        searchPaths: [],
        installed: [
          {
            id: "npm:test-pkg",
            source: "npm",
            ref: "npm:test-pkg@1.0.0",
            artifactUrl: "https://example.test/test-pkg.tgz",
            stashRoot: cacheDir,
            cacheDir: cacheDir,
            installedAt: new Date().toISOString(),
          },
        ],
      });
      const filePath = path.join(cacheDir, "scripts", "deploy.sh");
      expect(isEditable(filePath)).toBe(false);
    } finally {
      fs.rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  test("files outside any known path are editable", () => {
    saveConfig({ semanticSearch: false, searchPaths: [] });
    expect(isEditable("/some/random/path/file.sh")).toBe(true);
  });
});
