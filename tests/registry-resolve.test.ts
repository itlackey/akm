import { describe, expect, test } from "bun:test";
import { UsageError } from "../src/errors";
import { validateGitRef, validateGitUrl } from "../src/registry-resolve";

// ── validateGitUrl ───────────────────────────────────────────────────────────

describe("validateGitUrl", () => {
  // ── Rejected schemes ──────────────────────────────────────────────────────

  test("rejects ext:: protocol helper (arbitrary command execution)", () => {
    expect(() => validateGitUrl("ext::evil-command arg")).toThrow(UsageError);
  });

  test("rejects fd:: protocol helper", () => {
    expect(() => validateGitUrl("fd::5")).toThrow(UsageError);
  });

  test("rejects file:// scheme (local path traversal)", () => {
    expect(() => validateGitUrl("file:///etc/passwd")).toThrow(UsageError);
  });

  test("rejects ftp:// scheme", () => {
    expect(() => validateGitUrl("ftp://example.com/repo")).toThrow(UsageError);
  });

  test("rejects completely invalid URLs", () => {
    expect(() => validateGitUrl("not a url at all !!")).toThrow(UsageError);
  });

  // ── Accepted schemes ──────────────────────────────────────────────────────

  test("accepts https:// URLs", () => {
    expect(() => validateGitUrl("https://github.com/valid/repo.git")).not.toThrow();
  });

  test("accepts http:// URLs", () => {
    expect(() => validateGitUrl("http://internal.example.com/repo.git")).not.toThrow();
  });

  test("accepts ssh:// URLs", () => {
    expect(() => validateGitUrl("ssh://git@github.com/org/repo.git")).not.toThrow();
  });

  test("accepts git:// URLs", () => {
    expect(() => validateGitUrl("git://github.com/org/repo.git")).not.toThrow();
  });

  test("accepts git@ SSH shorthand", () => {
    expect(() => validateGitUrl("git@github.com:org/repo.git")).not.toThrow();
  });

  test("accepts git@ SSH shorthand with subdomain", () => {
    expect(() => validateGitUrl("git@gitlab.example.com:group/subgroup/repo.git")).not.toThrow();
  });
});

// ── validateGitRef ───────────────────────────────────────────────────────────

describe("validateGitRef", () => {
  // ── Rejected patterns ─────────────────────────────────────────────────────

  test("rejects refs with semicolons", () => {
    expect(() => validateGitRef("main;rm -rf /")).toThrow(UsageError);
  });

  test("rejects refs with spaces", () => {
    expect(() => validateGitRef("main branch")).toThrow(UsageError);
  });

  test("rejects refs with shell special chars", () => {
    expect(() => validateGitRef("$(evil)")).toThrow(UsageError);
    expect(() => validateGitRef("`evil`")).toThrow(UsageError);
    expect(() => validateGitRef("main&evil")).toThrow(UsageError);
  });

  test("rejects empty string", () => {
    expect(() => validateGitRef("")).toThrow(UsageError);
  });

  // ── Accepted patterns ─────────────────────────────────────────────────────

  test("accepts branch names", () => {
    expect(() => validateGitRef("main")).not.toThrow();
    expect(() => validateGitRef("feat/my-feature")).not.toThrow();
    expect(() => validateGitRef("v1.2.3")).not.toThrow();
    expect(() => validateGitRef("release-candidate_1")).not.toThrow();
  });

  test("accepts full git SHA hashes", () => {
    expect(() => validateGitRef("abc1234def567890abc1234def567890abc12345")).not.toThrow();
  });

  test("accepts short SHA hashes", () => {
    expect(() => validateGitRef("abc1234")).not.toThrow();
  });
});
