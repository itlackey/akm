import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  BodyReadTimeoutError,
  hasErrnoCode,
  isWithin,
  jsonWithByteCap,
  ResponseTooLargeError,
  readBodyWithByteCap,
  resolveStashDir,
  toPosix,
} from "../../src/core/common";
import { writeResponseToFileCapped } from "../../src/runtime";
import { type Cleanup, sandboxHome, sandboxXdgConfigHome } from "../_helpers/sandbox";

// ── resolveStashDir ──────────────────────────────────────────────────────────

describe("resolveStashDir", () => {
  let envCleanup: Cleanup = () => {};
  let testConfigHome: string;

  beforeEach(() => {
    const homeResult = sandboxHome();
    const cfgResult = sandboxXdgConfigHome(homeResult.cleanup);
    testConfigHome = cfgResult.dir;
    envCleanup = cfgResult.cleanup;
    // Delete AKM_STASH_DIR so each test starts with a clean slate
    delete process.env.AKM_STASH_DIR;
  });

  afterEach(() => {
    envCleanup();
    envCleanup = () => {};
    testConfigHome = "";
  });

  test("throws when no stash dir is configured and default does not exist", () => {
    // HOME is already sandboxed (no akm subdir), AKM_STASH_DIR is deleted in beforeEach
    expect(() => resolveStashDir()).toThrow("No stash directory found");
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

  test("refuses an unmigrated stashDir-only config with the migrate hint", () => {
    // 0.9.0 cutover: a retired top-level `stashDir` (no bundles) is no longer
    // silently honoured — resolveStashDir refuses it with the same `akm migrate
    // apply` hint the schema hard-reject uses, instead of split-brain success.
    delete process.env.AKM_STASH_DIR;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-common-test-stash-"));
    try {
      const configDir = path.join(testConfigHome, "akm");
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ stashDir: tmpDir }));
      expect(() => resolveStashDir()).toThrow(/migrate apply/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("reads the primary stash from the migrated bundles/defaultBundle shape", () => {
    delete process.env.AKM_STASH_DIR;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-common-test-bundle-"));
    try {
      const configDir = path.join(testConfigHome, "akm");
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(
        path.join(configDir, "config.json"),
        JSON.stringify({ defaultBundle: "main", bundles: { main: { path: tmpDir } } }),
      );
      const result = resolveStashDir();
      expect(result).toBe(path.resolve(tmpDir));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("uses default stash dir when it exists", () => {
    // HOME is already sandboxed to a fresh temp dir; create akm subdir there
    const defaultStash = path.join(process.env.HOME as string, "akm");
    fs.mkdirSync(defaultStash, { recursive: true });
    const result = resolveStashDir();
    expect(result).toBe(defaultStash);
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

// isAssetType (the closed-union validation gate) was deleted in chunk 1.5 —
// `common.ts` no longer owns a type-taxonomy predicate at all. Its successor,
// `isKnownType` (a HINT, not a validation gate — unknown types are valid
// data), lives in `core/recognition-util.ts` and is covered by
// `tests/core/type-token-contract.test.ts`.

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

// ── readBodyWithByteCap body-phase deadline / caller abort ───────────────────

describe("readBodyWithByteCap body-phase limits", () => {
  // A server that sends headers + a partial body chunk, then holds the body
  // stream open forever — the mid-body stall fetchWithTimeout does NOT bound.
  function startStallingBodyServer(): { url: string; stop: () => void } {
    const server = Bun.serve({
      port: 0,
      fetch() {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("partial-body-then-stall"));
            // Intentionally never close/enqueue again → body stalls mid-stream.
          },
        });
        return new Response(stream, { headers: { "content-type": "text/plain" } });
      },
    });
    return { url: `http://127.0.0.1:${server.port}/`, stop: () => server.stop(true) };
  }

  test("aborts with BodyReadTimeoutError when the body stalls past bodyTimeoutMs", async () => {
    const server = startStallingBodyServer();
    try {
      const response = await fetch(server.url);
      await expect(readBodyWithByteCap(response, 1024 * 1024, { bodyTimeoutMs: 60 })).rejects.toBeInstanceOf(
        BodyReadTimeoutError,
      );
    } finally {
      server.stop();
    }
  });

  test("propagates the caller's abort reason when the signal fires mid-body", async () => {
    const server = startStallingBodyServer();
    try {
      const response = await fetch(server.url);
      const controller = new AbortController();
      const reason = new Error("caller cancelled");
      const timer = setTimeout(() => controller.abort(reason), 20);
      try {
        await expect(readBodyWithByteCap(response, 1024 * 1024, { signal: controller.signal })).rejects.toBe(reason);
      } finally {
        clearTimeout(timer);
      }
    } finally {
      server.stop();
    }
  });

  test("rejects immediately when the signal is already aborted", async () => {
    const response = new Response("hello world");
    const controller = new AbortController();
    const reason = new Error("pre-aborted");
    controller.abort(reason);
    await expect(readBodyWithByteCap(response, 1024, { signal: controller.signal })).rejects.toBe(reason);
  });

  test("reads a fast body normally even with a generous deadline set", async () => {
    const text = await readBodyWithByteCap(new Response("quick body"), 1024, { bodyTimeoutMs: 10_000 });
    expect(text).toBe("quick body");
  });
});

// ── writeResponseToFileCapped (archive download cap) ─────────────────────────

describe("writeResponseToFileCapped", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-capped-writer-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("writes a within-cap body to disk verbatim", async () => {
    const dest = path.join(dir, "ok.bin");
    await writeResponseToFileCapped(dest, new Response("archive-bytes"), { maxBytes: 1024 });
    expect(fs.readFileSync(dest, "utf8")).toBe("archive-bytes");
  });

  test("refuses before reading when Content-Length exceeds the cap", async () => {
    const dest = path.join(dir, "declared.bin");
    const body = "x".repeat(1000);
    const response = new Response(body, { headers: { "content-length": "1000" } });
    await expect(writeResponseToFileCapped(dest, response, { maxBytes: 100 })).rejects.toBeInstanceOf(
      ResponseTooLargeError,
    );
    expect(fs.existsSync(dest)).toBe(false);
  });

  test("aborts mid-stream when the streamed body exceeds the cap", async () => {
    const dest = path.join(dir, "streamed.bin");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 5; i++) controller.enqueue(new TextEncoder().encode("y".repeat(1000)));
        controller.close();
      },
    });
    await expect(writeResponseToFileCapped(dest, new Response(stream), { maxBytes: 2500 })).rejects.toBeInstanceOf(
      ResponseTooLargeError,
    );
  });

  test("enforces the body-read deadline on a stalling download", async () => {
    const dest = path.join(dir, "stall.bin");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("first-chunk"));
        // Never close → stalls.
      },
    });
    await expect(
      writeResponseToFileCapped(dest, new Response(stream), { maxBytes: 1024 * 1024, bodyTimeoutMs: 60 }),
    ).rejects.toBeInstanceOf(BodyReadTimeoutError);
  });
});
