import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { NotFoundError, UsageError } from "../src/core/errors";
import {
  gitCredentialEnvironment,
  npmArtifactNetworkPolicy,
  parseRegistryRef,
  resolveRegistryArtifact,
  trustedNpmTarballHosts,
  UntrustedNpmTarballError,
  validateGitRef,
  validateGitUrl,
  validateNpmTarballUrl,
} from "../src/registry/resolve";
import { withEnvSync, withMockedFetch } from "./_helpers/sandbox";

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

describe("gitCredentialEnvironment", () => {
  test("passes bearer credentials through child-process config instead of a URL or argv (#977)", () => {
    const env = withEnvSync(
      { GIT_CONFIG_COUNT: undefined, GIT_CONFIG_KEY_0: undefined, GIT_CONFIG_VALUE_0: undefined },
      () => gitCredentialEnvironment("secret-value"),
    );

    expect(env.GIT_CONFIG_COUNT).toBe("1");
    expect(env.GIT_CONFIG_KEY_0).toBe("http.extraHeader");
    expect(env.GIT_CONFIG_VALUE_0).toBe("Authorization: Bearer secret-value");
  });

  test("appends to existing process-scoped Git config instead of replacing it", () => {
    const env = withEnvSync(
      {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "url.file:///fixture/.insteadOf",
        GIT_CONFIG_VALUE_0: "https://fixture.invalid/repo.git",
      },
      () => gitCredentialEnvironment("secret-value"),
    );

    expect(env.GIT_CONFIG_COUNT).toBe("2");
    expect(env.GIT_CONFIG_KEY_0).toBe("url.file:///fixture/.insteadOf");
    expect(env.GIT_CONFIG_VALUE_0).toBe("https://fixture.invalid/repo.git");
    expect(env.GIT_CONFIG_KEY_1).toBe("http.extraHeader");
    expect(env.GIT_CONFIG_VALUE_1).toBe("Authorization: Bearer secret-value");
  });

  test("rejects control characters in resolved credentials", () => {
    expect(() => gitCredentialEnvironment("secret\nextra-header: injected")).toThrow(UsageError);
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

  test("rejects a same-host tarball that changes the metadata origin", () => {
    for (const url of [
      "http://registry.npmjs.org/pkg/-/pkg-1.0.0.tgz",
      "https://registry.npmjs.org:8080/pkg/-/pkg-1.0.0.tgz",
    ]) {
      expect(() => validateNpmTarballUrl(url, "pkg@1.0.0")).toThrow(UntrustedNpmTarballError);
    }
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

  test("does not let a configured mirror nominate a different public origin", () => {
    process.env.AKM_NPM_REGISTRY = "https://npm.internal.example.com";
    expect(() => validateNpmTarballUrl("https://registry.npmjs.org/pkg/-/pkg-1.0.0.tgz", "pkg@1.0.0")).toThrow(
      UntrustedNpmTarballError,
    );
  });

  test("rejects untrusted host even with override set", () => {
    process.env.AKM_NPM_REGISTRY = "https://npm.internal.example.com";
    expect(() => validateNpmTarballUrl("https://evil.example.com/pkg.tgz", "pkg@1.0.0")).toThrow(
      UntrustedNpmTarballError,
    );
  });

  test("throws on unparseable AKM_NPM_REGISTRY override instead of silently falling back", () => {
    process.env.AKM_NPM_REGISTRY = "this is not a url";
    expect(() => trustedNpmTarballHosts()).toThrow(/AKM_NPM_REGISTRY/);
  });
});

// ── parseRegistryRef: scoped-npm vs path disambiguation ──────────────────────

describe("parseRegistryRef — bare scoped npm package", () => {
  // Regression: a ref starting with `@` is an npm scope, never a filesystem
  // path. `isPathLikeRef` used to return true for any ref containing `/`, so
  // `@scope/pkg` was routed to tryParseLocalRef(explicitPath=true) and threw
  // NotFoundError before the `@`-npm branch could run.
  test("parses `@scope/pkg` (not on disk) as an npm ref instead of throwing", () => {
    const parsed = parseRegistryRef("@scope/pkg");
    expect(parsed.source).toBe("npm");
    expect(parsed).toMatchObject({ source: "npm", packageName: "@scope/pkg" });
  });

  test("parses `@scope/pkg@1.2.3` as npm with the requested version", () => {
    const parsed = parseRegistryRef("@scope/pkg@1.2.3");
    expect(parsed).toMatchObject({
      source: "npm",
      packageName: "@scope/pkg",
      requestedVersionOrTag: "1.2.3",
    });
  });

  test("still routes an explicit `./@scope` path through the local branch", () => {
    // Leading ./ marks an explicit path; a missing one must throw the local
    // NotFoundError, proving it did NOT fall through to npm parsing.
    expect(() => parseRegistryRef("./@scope/does-not-exist")).toThrow(/Local path not found/);
  });
});

// ── parseRegistryRef — `owner/repo` shorthand (R-007) ───────────────────────
//
// R-007: `akm add owner/repo` was unreachable. `isPathLikeRef` returned true
// for ANY ref containing a `/`, so a bare `owner/repo` shorthand that did not
// exist as a local directory was routed to `tryParseLocalRef` with
// `explicitPath=true`, which throws `NotFoundError` before the GitHub
// shorthand fallback below it ever runs. Reproduced against the pristine
// pre-fix tree: `parseRegistryRef("itlackey/akm-stash")` threw
// `Local path not found: <cwd>/itlackey/akm-stash`.

describe("parseRegistryRef — `owner/repo` GitHub shorthand (R-007)", () => {
  test("a bare owner/repo ref with no matching local directory resolves as GitHub shorthand", () => {
    // Guaranteed not to exist as a directory relative to the test cwd.
    const parsed = parseRegistryRef("itlackey/akm-stash-does-not-exist-on-disk");
    expect(parsed).toMatchObject({
      source: "github",
      owner: "itlackey",
      repo: "akm-stash-does-not-exist-on-disk",
    });
  });

  test("owner/repo#ref shorthand also falls through to GitHub resolution when missing locally", () => {
    const parsed = parseRegistryRef("itlackey/akm-stash-does-not-exist-on-disk#main");
    expect(parsed).toMatchObject({
      source: "github",
      owner: "itlackey",
      repo: "akm-stash-does-not-exist-on-disk",
      requestedRef: "main",
    });
  });

  test("an EXPLICIT relative owner/repo-shaped path (./owner/repo) still throws when missing", () => {
    // Regression guard: only the bare (non-explicit) form should fall
    // through. A leading `./` is unambiguous — it MUST still fail loudly.
    expect(() => parseRegistryRef("./itlackey/akm-stash-does-not-exist-on-disk")).toThrow(NotFoundError);
    expect(() => parseRegistryRef("./itlackey/akm-stash-does-not-exist-on-disk")).toThrow(/Local path not found/);
  });

  test("an EXPLICIT absolute owner/repo-shaped path still throws when missing", () => {
    expect(() => parseRegistryRef("/tmp/definitely-does-not-exist-akm/owner/repo")).toThrow(/Local path not found/);
  });

  test("a bare path with 3+ segments (not owner/repo shaped) still throws when missing", () => {
    // Only the exact 2-segment owner/repo shape is ambiguous with GitHub
    // shorthand; a deeper bare path is not, and must keep failing loudly
    // rather than silently falling through to (and failing) npm parsing.
    expect(() => parseRegistryRef("some/nested/path-does-not-exist")).toThrow(/Local path not found/);
  });
});

// ── AKM_NPM_REGISTRY honored for METADATA resolution too (R-035) ───────────
//
// R-035: the env var previously only widened the trusted-tarball-host
// allowlist (`trustedNpmTarballHosts`); the metadata endpoint itself was
// hardcoded to `https://registry.npmjs.org`, making the
// `UntrustedNpmTarballError.hint()` text ("Set AKM_NPM_REGISTRY to your
// private npm mirror's base URL...") false for metadata resolution. Now the
// override is honored end-to-end: metadata is fetched from the configured
// mirror, not the public registry.

describe("resolveRegistryArtifact — npm metadata honors AKM_NPM_REGISTRY (R-035)", () => {
  const originalRegistry = process.env.AKM_NPM_REGISTRY;

  afterEach(() => {
    if (originalRegistry === undefined) {
      delete process.env.AKM_NPM_REGISTRY;
    } else {
      process.env.AKM_NPM_REGISTRY = originalRegistry;
    }
  });

  test("fetches package metadata from the overridden registry base, not registry.npmjs.org", async () => {
    process.env.AKM_NPM_REGISTRY = "https://npm.internal.example.com";
    const requestedUrls: string[] = [];

    const parsed = parseRegistryRef("npm:private-pkg");
    const result = await withMockedFetch(
      () => resolveRegistryArtifact(parsed),
      (url) => {
        requestedUrls.push(url);
        return new Response(
          JSON.stringify({
            "dist-tags": { latest: "1.0.0" },
            versions: {
              "1.0.0": {
                dist: {
                  tarball: "https://npm.internal.example.com/private-pkg/-/private-pkg-1.0.0.tgz",
                  shasum: "abc1234def567890abc1234def567890abc12345",
                },
              },
            },
          }),
          { headers: { "Content-Type": "application/json" } },
        );
      },
    );

    expect(requestedUrls).toEqual(["https://npm.internal.example.com/private-pkg"]);
    expect(requestedUrls.some((u) => u.includes("registry.npmjs.org"))).toBe(false);
    expect(result.resolvedVersion).toBe("1.0.0");
    expect(result.registryOrigin).toBe("https://npm.internal.example.com");
    expect(result.allowPrivateRegistryOrigin).toBe(true);
    process.env.AKM_NPM_REGISTRY = "http://changed-after-metadata.invalid:9999";
    expect(npmArtifactNetworkPolicy(result)).toEqual({
      kind: "npm-api",
      registryOrigin: "https://npm.internal.example.com",
      allowPrivateRegistryOrigin: true,
    });
  });

  test("falls back to the public registry for metadata when no override is set", async () => {
    delete process.env.AKM_NPM_REGISTRY;
    const requestedUrls: string[] = [];

    const parsed = parseRegistryRef("npm:public-pkg");
    await withMockedFetch(
      () => resolveRegistryArtifact(parsed),
      (url) => {
        requestedUrls.push(url);
        return new Response(
          JSON.stringify({
            "dist-tags": { latest: "2.0.0" },
            versions: {
              "2.0.0": {
                dist: {
                  tarball: "https://registry.npmjs.org/public-pkg/-/public-pkg-2.0.0.tgz",
                  shasum: "abc1234def567890abc1234def567890abc12345",
                },
              },
            },
          }),
          { headers: { "Content-Type": "application/json" } },
        );
      },
    );

    expect(requestedUrls).toEqual(["https://registry.npmjs.org/public-pkg"]);
  });
});
