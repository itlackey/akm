import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import { asRecord, asString, createIssue, GITHUB_API_BASE, githubHeaders } from "../src/integrations/github";

// ── Environment helpers ─────────────────────────────────────────────────────

const originalGithubToken = process.env.GITHUB_TOKEN;
const originalGhToken = process.env.GH_TOKEN;
const originalFetch = globalThis.fetch;

afterEach(() => {
  mock.restore();
  globalThis.fetch = originalFetch;

  if (originalGithubToken === undefined) {
    delete process.env.GITHUB_TOKEN;
  } else {
    process.env.GITHUB_TOKEN = originalGithubToken;
  }

  if (originalGhToken === undefined) {
    delete process.env.GH_TOKEN;
  } else {
    process.env.GH_TOKEN = originalGhToken;
  }
});

// ── GITHUB_API_BASE ─────────────────────────────────────────────────────────

describe("GITHUB_API_BASE", () => {
  test("is the GitHub API URL", () => {
    expect(GITHUB_API_BASE).toBe("https://api.github.com");
  });
});

// ── githubHeaders ───────────────────────────────────────────────────────────

describe("githubHeaders", () => {
  test("includes Accept and User-Agent headers", () => {
    delete process.env.GITHUB_TOKEN;
    const headers = githubHeaders() as Record<string, string>;
    expect(headers.Accept).toBe("application/vnd.github+json");
    expect(headers["User-Agent"]).toBe("akm-registry");
  });

  test("does not include Authorization when GITHUB_TOKEN is unset", () => {
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
    spyOn(childProcess, "spawnSync").mockReturnValue({ status: 1, stdout: "" } as never);
    const headers = githubHeaders() as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });

  test("includes Authorization when GITHUB_TOKEN is set", () => {
    process.env.GITHUB_TOKEN = "ghp_test_token_123";
    const headers = githubHeaders() as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer ghp_test_token_123");
  });

  test("trims whitespace from GITHUB_TOKEN", () => {
    process.env.GITHUB_TOKEN = "  ghp_trimmed  ";
    delete process.env.GH_TOKEN;
    const headers = githubHeaders() as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer ghp_trimmed");
  });

  test("does not include Authorization when GITHUB_TOKEN is empty", () => {
    process.env.GITHUB_TOKEN = "";
    delete process.env.GH_TOKEN;
    const headers = githubHeaders() as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });

  test("does not include Authorization when GITHUB_TOKEN is whitespace-only", () => {
    process.env.GITHUB_TOKEN = "   ";
    delete process.env.GH_TOKEN;
    const headers = githubHeaders() as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });

  test("uses GH_TOKEN when GITHUB_TOKEN is unset", () => {
    delete process.env.GITHUB_TOKEN;
    process.env.GH_TOKEN = "ghs_from_gh_token";
    const headers = githubHeaders() as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer ghs_from_gh_token");
  });

  test("prefers GITHUB_TOKEN over GH_TOKEN", () => {
    process.env.GITHUB_TOKEN = "ghp_preferred";
    process.env.GH_TOKEN = "ghs_fallback";
    const headers = githubHeaders() as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer ghp_preferred");
  });

  test("falls back to gh auth token when env vars are unset", () => {
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
    const spawnSyncSpy = spyOn(childProcess, "spawnSync").mockReturnValue({
      status: 0,
      stdout: "gho_cli_token\n",
    } as never);
    const headers = githubHeaders() as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer gho_cli_token");
    expect(spawnSyncSpy).toHaveBeenCalledWith("gh", ["auth", "token"], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    });
  });

  test("does not include gh auth token for non-GitHub URLs", () => {
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
    spyOn(childProcess, "spawnSync").mockReturnValue({ status: 0, stdout: "gho_cli_token\n" } as never);
    const headers = githubHeaders("https://example.com/file.tgz") as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });
});

// ── asRecord ────────────────────────────────────────────────────────────────

describe("asRecord", () => {
  test("returns object as-is for a plain object", () => {
    const obj = { key: "value", num: 42 };
    expect(asRecord(obj)).toBe(obj);
  });

  test("returns empty object for null", () => {
    expect(asRecord(null)).toEqual({});
  });

  test("returns empty object for undefined", () => {
    expect(asRecord(undefined)).toEqual({});
  });

  test("returns empty object for a string", () => {
    expect(asRecord("hello")).toEqual({});
  });

  test("returns empty object for a number", () => {
    expect(asRecord(42)).toEqual({});
  });

  test("returns empty object for a boolean", () => {
    expect(asRecord(true)).toEqual({});
  });

  test("returns empty object for an array", () => {
    expect(asRecord([1, 2, 3])).toEqual({});
  });

  test("returns the object for nested objects", () => {
    const nested = { a: { b: "c" } };
    const result = asRecord(nested);
    expect(result).toBe(nested);
    expect((result as Record<string, unknown>).a).toEqual({ b: "c" });
  });
});

// ── asString ────────────────────────────────────────────────────────────────

describe("asString", () => {
  test("returns string for a non-empty string", () => {
    expect(asString("hello")).toBe("hello");
  });

  test("returns undefined for an empty string", () => {
    expect(asString("")).toBeUndefined();
  });

  test("returns undefined for null", () => {
    expect(asString(null)).toBeUndefined();
  });

  test("returns undefined for undefined", () => {
    expect(asString(undefined)).toBeUndefined();
  });

  test("returns undefined for a number", () => {
    expect(asString(42)).toBeUndefined();
  });

  test("returns undefined for a boolean", () => {
    expect(asString(true)).toBeUndefined();
  });

  test("returns undefined for an object", () => {
    expect(asString({ toString: () => "obj" })).toBeUndefined();
  });

  test("returns undefined for an array", () => {
    expect(asString(["hello"])).toBeUndefined();
  });

  test("returns string with whitespace preserved", () => {
    expect(asString("  spaced  ")).toBe("  spaced  ");
  });
});

// ── createIssue ───────────────────────────────────────────────────────────────

describe("createIssue", () => {
  test("POSTs to the repo issues endpoint with title, body and labels", async () => {
    process.env.GITHUB_TOKEN = "ghp_test";
    let captured: { url: string; method?: string; body: unknown } | undefined;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      captured = { url, method: init?.method, body: JSON.parse(String(init?.body)) };
      return new Response(JSON.stringify({ number: 7, html_url: "https://github.com/o/r/issues/7", title: "Hello" }), {
        status: 201,
      });
    }) as unknown as typeof fetch;

    const issue = await createIssue({ owner: "o", repo: "r", title: "Hello", body: "World", labels: ["feedback"] });

    expect(captured?.method).toBe("POST");
    expect(captured?.url).toBe("https://api.github.com/repos/o/r/issues");
    expect(captured?.body).toEqual({ title: "Hello", body: "World", labels: ["feedback"] });
    expect(issue).toEqual({ number: 7, url: "https://github.com/o/r/issues/7", title: "Hello" });
  });

  test("respects an apiBase override", async () => {
    process.env.GITHUB_TOKEN = "ghp_test";
    let capturedUrl = "";
    globalThis.fetch = (async (url: string) => {
      capturedUrl = url;
      return new Response(JSON.stringify({ number: 1, html_url: "https://example.test/i/1" }), { status: 201 });
    }) as unknown as typeof fetch;

    await createIssue({ owner: "o", repo: "r", title: "t", body: "b", apiBase: "https://example.test/api/" });
    expect(capturedUrl).toBe("https://example.test/api/repos/o/r/issues");
  });

  test("throws when no token is available", async () => {
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
    spyOn(childProcess, "spawnSync").mockReturnValue({ status: 1, stdout: "" } as never);
    await expect(createIssue({ owner: "o", repo: "r", title: "t", body: "b" })).rejects.toThrow(/token/i);
  });

  test("throws on a non-OK response with the status in the message", async () => {
    process.env.GITHUB_TOKEN = "ghp_test";
    globalThis.fetch = (async () => new Response("Forbidden", { status: 403 })) as unknown as typeof fetch;
    await expect(createIssue({ owner: "o", repo: "r", title: "t", body: "b" })).rejects.toThrow(/403/);
  });

  test("throws when the response is missing number or html_url", async () => {
    process.env.GITHUB_TOKEN = "ghp_test";
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ title: "t" }), { status: 201 })) as unknown as typeof fetch;
    await expect(createIssue({ owner: "o", repo: "r", title: "t", body: "b" })).rejects.toThrow(/unexpected response/);
  });

  test("requires a non-empty title", async () => {
    process.env.GITHUB_TOKEN = "ghp_test";
    await expect(createIssue({ owner: "o", repo: "r", title: "  ", body: "b" })).rejects.toThrow(/title/i);
  });
});
