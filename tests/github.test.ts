import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import { asRecord, asString, GITHUB_API_BASE, githubHeaders } from "../src/github";

// ── Environment helpers ─────────────────────────────────────────────────────

const originalGithubToken = process.env.GITHUB_TOKEN;
const originalGhToken = process.env.GH_TOKEN;

afterEach(() => {
  mock.restore();

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
