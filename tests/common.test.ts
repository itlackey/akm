import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  hasErrnoCode,
  isAssetType,
  isWithin,
  jsonWithByteCap,
  ResponseTooLargeError,
  readBodyWithByteCap,
  resolveStashDir,
  toPosix,
} from "../src/common";

// ── resolveStashDir ──────────────────────────────────────────────────────────

describe("resolveStashDir", () => {
  const origEnv = process.env.AKM_STASH_DIR;
  const origXdgConfigHome = process.env.XDG_CONFIG_HOME;
  const origHome = process.env.HOME;
  let testConfigHome: string;

  beforeEach(() => {
    testConfigHome = fs.mkdtempSync(path.join(os.tmpdir(), "akm-common-test-config-"));
    process.env.XDG_CONFIG_HOME = testConfigHome;
  });

  afterEach(() => {
    if (origEnv === undefined) {
      delete process.env.AKM_STASH_DIR;
    } else {
      process.env.AKM_STASH_DIR = origEnv;
    }
    if (origXdgConfigHome === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = origXdgConfigHome;
    }
    if (origHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = origHome;
    }
    if (testConfigHome) {
      fs.rmSync(testConfigHome, { recursive: true, force: true });
    }
  });

  test("throws when no stash dir is configured and default does not exist", () => {
    delete process.env.AKM_STASH_DIR;
    // Point HOME to a tmp dir without an akm subdirectory
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "akm-common-test-home-"));
    process.env.HOME = tmpHome;
    try {
      expect(() => resolveStashDir()).toThrow("No stash directory found");
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  test("throws when AKM_STASH_DIR points to nonexistent path", () => {
    process.env.AKM_STASH_DIR = "/nonexistent/path/that/does/not/exist";
    expect(() => resolveStashDir()).toThrow("Unable to read");
  });

  test("throws when AKM_STASH_DIR path is a file, not a directory", () => {
    const tmpFile = path.join(os.tmpdir(), `akm-common-test-file-${Date.now()}`);
    fs.writeFileSync(tmpFile, "not a directory");
    try {
      process.env.AKM_STASH_DIR = tmpFile;
      expect(() => resolveStashDir()).toThrow("must point to a directory");
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });

  test("returns resolved path for valid AKM_STASH_DIR", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-common-test-"));
    try {
      process.env.AKM_STASH_DIR = tmpDir;
      const result = resolveStashDir();
      expect(result).toBe(path.resolve(tmpDir));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("reads stashDir from config.json when env var is not set", () => {
    delete process.env.AKM_STASH_DIR;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-common-test-stash-"));
    try {
      const configDir = path.join(testConfigHome, "akm");
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ stashDir: tmpDir }));
      const result = resolveStashDir();
      expect(result).toBe(path.resolve(tmpDir));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("uses default stash dir when it exists", () => {
    delete process.env.AKM_STASH_DIR;
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "akm-common-test-home-"));
    const defaultStash = path.join(tmpHome, "akm");
    fs.mkdirSync(defaultStash, { recursive: true });
    process.env.HOME = tmpHome;
    try {
      const result = resolveStashDir();
      expect(result).toBe(defaultStash);
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  test("env var takes precedence over config.json stashDir", () => {
    const envDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-common-test-env-"));
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-common-test-cfg-"));
    try {
      process.env.AKM_STASH_DIR = envDir;

      const configRoot = path.join(testConfigHome, "akm");
      fs.mkdirSync(configRoot, { recursive: true });
      fs.writeFileSync(path.join(configRoot, "config.json"), JSON.stringify({ stashDir: configDir }));

      const result = resolveStashDir();
      expect(result).toBe(path.resolve(envDir));
    } finally {
      fs.rmSync(envDir, { recursive: true, force: true });
      fs.rmSync(configDir, { recursive: true, force: true });
    }
  });
});

// ── toPosix ──────────────────────────────────────────────────────────────────

describe("toPosix", () => {
  test("already-posix paths are unchanged", () => {
    expect(toPosix("foo/bar/baz")).toBe("foo/bar/baz");
  });

  test("backslash paths are converted to forward slashes", () => {
    expect(toPosix("foo\\bar\\baz")).toBe("foo/bar/baz");
  });

  test("mixed separators are normalized", () => {
    expect(toPosix("foo\\bar/baz")).toBe("foo/bar/baz");
  });

  test("empty string returns empty string", () => {
    expect(toPosix("")).toBe("");
  });
});

// ── hasErrnoCode ─────────────────────────────────────────────────────────────

describe("hasErrnoCode", () => {
  test("returns true for error with matching code", () => {
    const err = Object.assign(new Error("fail"), { code: "ENOENT" });
    expect(hasErrnoCode(err, "ENOENT")).toBe(true);
  });

  test("returns false for error with non-matching code", () => {
    const err = Object.assign(new Error("fail"), { code: "EACCES" });
    expect(hasErrnoCode(err, "ENOENT")).toBe(false);
  });

  test("returns false for string error", () => {
    expect(hasErrnoCode("some string error", "ENOENT")).toBe(false);
  });

  test("returns false for null", () => {
    expect(hasErrnoCode(null, "ENOENT")).toBe(false);
  });

  test("returns false for object without code property", () => {
    expect(hasErrnoCode({ message: "fail" }, "ENOENT")).toBe(false);
  });

  test("returns false for undefined", () => {
    expect(hasErrnoCode(undefined, "ENOENT")).toBe(false);
  });
});

// ── isAssetType ──────────────────────────────────────────────────────────────

describe("isAssetType", () => {
  test("returns true for all valid types", () => {
    expect(isAssetType("skill")).toBe(true);
    expect(isAssetType("command")).toBe(true);
    expect(isAssetType("agent")).toBe(true);
    expect(isAssetType("knowledge")).toBe(true);
    expect(isAssetType("script")).toBe(true);
  });

  test("returns false for invalid strings", () => {
    expect(isAssetType("widget")).toBe(false);
    expect(isAssetType("")).toBe(false);
    expect(isAssetType("tool")).toBe(false);
    expect(isAssetType("plugin")).toBe(false);
  });
});

// ── isWithin ────────────────────────────────────────────────────────────────

describe("isWithin", () => {
  test("returns true for path inside root", () => {
    expect(isWithin("/root/sub/file.txt", "/root")).toBe(true);
  });

  test("returns true for path equal to root", () => {
    expect(isWithin("/root", "/root")).toBe(true);
  });

  test("returns false for path outside root", () => {
    expect(isWithin("/other/file.txt", "/root")).toBe(false);
  });

  test("returns false for parent traversal", () => {
    expect(isWithin("/root/../etc/passwd", "/root")).toBe(false);
  });

  test("returns true for nested subdirectory", () => {
    expect(isWithin("/root/a/b/c/d.txt", "/root")).toBe(true);
  });

  test("returns false for sibling directory with similar prefix", () => {
    expect(isWithin("/root-other/file.txt", "/root")).toBe(false);
  });
});

// ── readBodyWithByteCap / jsonWithByteCap ────────────────────────────────────

describe("readBodyWithByteCap", () => {
  function makeResponse(body: BodyInit, init?: { headers?: HeadersInit; url?: string }): Response {
    const res = new Response(body, { headers: init?.headers });
    if (init?.url) Object.defineProperty(res, "url", { value: init.url });
    return res;
  }

  test("reads small bodies verbatim", async () => {
    const text = await readBodyWithByteCap(makeResponse("hello world"), 1024);
    expect(text).toBe("hello world");
  });

  test("handles empty bodies", async () => {
    const text = await readBodyWithByteCap(makeResponse(""), 1024);
    expect(text).toBe("");
  });

  test("refuses before reading if Content-Length exceeds cap", async () => {
    const body = "x".repeat(1000);
    const response = makeResponse(body, {
      headers: { "content-length": "1000" },
      url: "http://example.invalid/too-big",
    });
    await expect(readBodyWithByteCap(response, 100)).rejects.toBeInstanceOf(ResponseTooLargeError);
  });

  test("aborts mid-stream when Content-Length is absent but body exceeds cap", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        // 5 chunks of 1000 bytes each = 5000 bytes; cap at 2500.
        for (let i = 0; i < 5; i++) {
          controller.enqueue(new TextEncoder().encode("x".repeat(1000)));
        }
        controller.close();
      },
    });
    const response = new Response(stream);
    await expect(readBodyWithByteCap(response, 2500)).rejects.toBeInstanceOf(ResponseTooLargeError);
  });

  test("accepts body right at the cap", async () => {
    const body = "x".repeat(100);
    const text = await readBodyWithByteCap(makeResponse(body), 100);
    expect(text.length).toBe(100);
  });

  test("decodes multi-chunk UTF-8 bodies correctly", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("hello "));
        controller.enqueue(new TextEncoder().encode("world"));
        controller.close();
      },
    });
    const response = new Response(stream);
    const text = await readBodyWithByteCap(response, 1024);
    expect(text).toBe("hello world");
  });
});

describe("jsonWithByteCap", () => {
  test("parses small JSON bodies", async () => {
    const data = await jsonWithByteCap<{ hello: string }>(new Response(JSON.stringify({ hello: "world" })), 1024);
    expect(data.hello).toBe("world");
  });

  test("rejects oversized JSON before parse", async () => {
    const big = JSON.stringify({ data: "x".repeat(2000) });
    const response = new Response(big, { headers: { "content-length": String(big.length) } });
    await expect(jsonWithByteCap(response, 500)).rejects.toBeInstanceOf(ResponseTooLargeError);
  });

  test("propagates JSON.parse errors for malformed input", async () => {
    const response = new Response("{not json");
    await expect(jsonWithByteCap(response, 1024)).rejects.toThrow();
  });
});
