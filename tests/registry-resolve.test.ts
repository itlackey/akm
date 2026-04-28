import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { UsageError } from "../src/core/errors";
import {
  trustedNpmTarballHosts,
  UntrustedNpmTarballError,
  validateGitRef,
  validateGitUrl,
  validateNpmTarballUrl,
} from "../src/registry/resolve";

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

// ── validateNpmTarballUrl ───────────────────────────────────────────────────

describe("validateNpmTarballUrl", () => {
  const originalRegistry = process.env.AKM_NPM_REGISTRY;

  beforeEach(() => {
    delete process.env.AKM_NPM_REGISTRY;
  });

  afterEach(() => {
    if (originalRegistry === undefined) {
      delete process.env.AKM_NPM_REGISTRY;
    } else {
      process.env.AKM_NPM_REGISTRY = originalRegistry;
    }
  });

  test("accepts public registry tarball", () => {
    expect(() =>
      validateNpmTarballUrl("https://registry.npmjs.org/@scope/pkg/-/pkg-1.0.0.tgz", "@scope/pkg@1.0.0"),
    ).not.toThrow();
  });

  test("rejects tarball on attacker-controlled host", () => {
    let caught: Error | undefined;
    try {
      validateNpmTarballUrl("https://evil.example.com/pkg-1.0.0.tgz", "pkg@1.0.0");
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeInstanceOf(UntrustedNpmTarballError);
    expect((caught as UntrustedNpmTarballError).code).toBe("UNTRUSTED_NPM_TARBALL");
    expect(caught?.message).toContain("evil.example.com");
  });

  test("rejects malformed tarball URL", () => {
    expect(() => validateNpmTarballUrl("not-a-url", "pkg@1.0.0")).toThrow(UntrustedNpmTarballError);
  });

  test("rejects disallowed scheme", () => {
    expect(() => validateNpmTarballUrl("ftp://registry.npmjs.org/pkg.tgz", "pkg@1.0.0")).toThrow(
      UntrustedNpmTarballError,
    );
  });

  test("accepts operator-configured private registry", () => {
    process.env.AKM_NPM_REGISTRY = "https://npm.internal.example.com";
    expect(() =>
      validateNpmTarballUrl("https://npm.internal.example.com/pkg/-/pkg-2.0.0.tgz", "pkg@2.0.0"),
    ).not.toThrow();
  });

  test("still accepts public registry alongside operator override", () => {
    process.env.AKM_NPM_REGISTRY = "https://npm.internal.example.com";
    expect(() => validateNpmTarballUrl("https://registry.npmjs.org/pkg/-/pkg-1.0.0.tgz", "pkg@1.0.0")).not.toThrow();
  });

  test("rejects untrusted host even with override set", () => {
    process.env.AKM_NPM_REGISTRY = "https://npm.internal.example.com";
    expect(() => validateNpmTarballUrl("https://evil.example.com/pkg.tgz", "pkg@1.0.0")).toThrow(
      UntrustedNpmTarballError,
    );
  });

  test("ignores unparseable AKM_NPM_REGISTRY override", () => {
    process.env.AKM_NPM_REGISTRY = "this is not a url";
    const hosts = trustedNpmTarballHosts();
    expect(hosts.has("registry.npmjs.org")).toBe(true);
    expect(hosts.size).toBe(1);
  });
});
