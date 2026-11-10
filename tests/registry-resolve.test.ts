import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ConfigError, NotFoundError, UsageError } from "../src/core/errors";
import { _setWarnSinkForTests } from "../src/core/warn";
import {
  gitCredentialEnvironment,
  parseRegistryRef,
  resolveRegistryArtifact,
  validateGitRef,
  validateGitUrl,
  validateNpmTarballUrl,
} from "../src/registry/resolve";
import { highestVersion, isExactSemver, isSemverRange, maxSatisfying } from "../src/registry/semver";
import { fetchCachedJson, withRegistryCacheDb } from "../src/storage/repositories/registry-index-cache-repository";
import { type IsolatedAkmStorage, withEnvSync, withIsolatedAkmStorage, withMockedFetch } from "./_helpers/sandbox";
import { overrideSeam } from "./_helpers/seams";

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
      expect(() => validateNpmTarballUrl(url, "pkg@1.0.0")).toThrow(NotFoundError);
    }
  });

  test("rejects tarball on attacker-controlled host", () => {
    let caught: Error | undefined;
    try {
      validateNpmTarballUrl("https://evil.example.com/pkg-1.0.0.tgz", "pkg@1.0.0");
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeInstanceOf(NotFoundError);
    expect((caught as NotFoundError).code).toBe("REGISTRY_RESPONSE_INVALID");
    expect(caught?.message).toContain("evil.example.com");
  });

  test("rejects malformed tarball URL", () => {
    expect(() => validateNpmTarballUrl("not-a-url", "pkg@1.0.0")).toThrow(NotFoundError);
  });

  test("rejects disallowed scheme", () => {
    expect(() => validateNpmTarballUrl("ftp://registry.npmjs.org/pkg.tgz", "pkg@1.0.0")).toThrow(NotFoundError);
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
      NotFoundError,
    );
  });

  test("rejects untrusted host even with override set", () => {
    process.env.AKM_NPM_REGISTRY = "https://npm.internal.example.com";
    expect(() => validateNpmTarballUrl("https://evil.example.com/pkg.tgz", "pkg@1.0.0")).toThrow(NotFoundError);
  });

  test("throws on unparseable AKM_NPM_REGISTRY override instead of silently falling back", async () => {
    process.env.AKM_NPM_REGISTRY = "this is not a url";
    const parsed = parseRegistryRef("npm:pkg");
    await expect(resolveRegistryArtifact(parsed)).rejects.toThrow(ConfigError);
    await expect(resolveRegistryArtifact(parsed)).rejects.toThrow(/AKM_NPM_REGISTRY/);
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
    expect(result.artifactUrl).toBe("https://npm.internal.example.com/private-pkg/-/private-pkg-1.0.0.tgz");
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

/**
 * Registry stale-cache fallback past TTL (§24.2 "Durability" release gate).
 *
 * The fetch skeleton's stale fallback used to consult only the TTL-filtered
 * row: once the cached index aged past `ttlMs`, an unreachable registry
 * hard-failed `akm search --from registry` / `akm registry list` even though
 * a perfectly serviceable index sat in the cache. A failed fetch now serves
 * the expired row too — loudly, via warn().
 */

const KEY = "https://registry.example/index.json";

function opts(fetchFresh: () => Promise<{ value: string; cacheJson: string }>, ttlMs = 60_000) {
  return {
    cacheKey: KEY,
    ttlMs,
    parseCache: (json: string) => (JSON.parse(json) as { v: string }).v,
    fetchFresh,
  };
}

async function backdateCacheRow(ageMs: number): Promise<void> {
  await withRegistryCacheDb(async (db) => {
    if (!db) throw new Error("expected a cache db in the sandbox");
    db.prepare("UPDATE registry_index_cache SET fetched_at = ? WHERE registry_url = ?").run(
      new Date(Date.now() - ageMs).toISOString(),
      KEY,
    );
  });
}

describe("registry cache fallback past TTL", () => {
  let storage: IsolatedAkmStorage;
  beforeEach(() => {
    storage = withIsolatedAkmStorage();
  });
  afterEach(() => storage.cleanup());

  test("a failed fetch serves the EXPIRED cached index with a warning instead of throwing", async () => {
    // Seed the cache with a successful fetch, then age it past the TTL.
    await fetchCachedJson(opts(async () => ({ value: "seeded", cacheJson: JSON.stringify({ v: "seeded" }) })));
    await backdateCacheRow(2 * 60_000);

    const warned: string[] = [];
    overrideSeam(_setWarnSinkForTests, (level, args) => {
      if (level === "warn") warned.push(args.map(String).join(" "));
    });

    const result = await fetchCachedJson(
      opts(async () => {
        throw new Error("ECONNREFUSED registry.example");
      }),
    );
    expect(result).toBe("seeded");
    expect(warned.some((w) => w.includes("registry.example"))).toBe(true);
  });

  test("with no cached row at all, the fetch failure still propagates", async () => {
    await expect(
      fetchCachedJson(
        opts(async () => {
          throw new Error("ECONNREFUSED registry.example");
        }),
      ),
    ).rejects.toThrow(/ECONNREFUSED/);
  });
});

/**
 * R-068 #3: the hand-rolled `satisfiesRange` in `src/registry/semver.ts`
 * silently rejected a long list of valid npm range forms even though the
 * looser `isSemverRange` classifier correctly recognized them as ranges —
 * `1.2.x`, `>1.0.0`, `<2.0.0`, `>=1.0.0 <2.0.0`, `^1.2`, OR-ranges (`a || b`),
 * hyphen ranges, and plain exact versions used as a range. The module now
 * delegates to the real `semver` package (already a runtime dependency).
 * These tests pin every form the register called out, plus the
 * previously-supported forms, so a future re-inlining regresses loudly.
 */

describe("isExactSemver", () => {
  test("true for exact versions", () => {
    expect(isExactSemver("1.2.3")).toBe(true);
    expect(isExactSemver("0.0.1")).toBe(true);
    expect(isExactSemver("1.2.3-beta.1")).toBe(true);
  });

  test("false for ranges, wildcards, and partial versions", () => {
    expect(isExactSemver("^1.2.3")).toBe(false);
    expect(isExactSemver("~1.2.3")).toBe(false);
    expect(isExactSemver("*")).toBe(false);
    expect(isExactSemver("latest")).toBe(false);
    expect(isExactSemver("1.2")).toBe(false);
    expect(isExactSemver("not-a-version")).toBe(false);
  });
});

describe("isSemverRange — every form R-068 #3 called out", () => {
  test.each([
    ["1.2.x", true],
    [">1.0.0", true],
    ["<2.0.0", true],
    [">=1.0.0 <2.0.0", true],
    ["^1.2", true],
    ["^1.2.3", true],
    ["~1.2.3", true],
    ["1.x || 2.x", true], // OR-range
    ["1.2.3 - 2.3.4", true], // hyphen range
    ["1.2.3", true], // exact version used as a range
    ["*", true],
  ])("isSemverRange(%s) -> %s", (input, expected) => {
    expect(isSemverRange(input)).toBe(expected);
  });

  test("false for npm dist-tag conventions and garbage", () => {
    expect(isSemverRange("latest")).toBe(false);
    expect(isSemverRange("not-a-range-at-all")).toBe(false);
  });
});

describe("maxSatisfying — resolves a satisfiable version for every previously-rejected form", () => {
  const versions = ["1.0.0", "1.2.0", "1.2.5", "1.2.9", "1.3.0", "2.0.0", "2.3.4", "3.0.0"];

  test.each([
    ["1.2.x", "1.2.9"],
    [">1.0.0", "3.0.0"],
    ["<2.0.0", "1.3.0"],
    [">=1.0.0 <2.0.0", "1.3.0"],
    ["^1.2", "1.3.0"],
    ["^1.2.3", "1.3.0"], // caret allows minor bumps within the same major
    ["~1.2.3", "1.2.9"], // tilde is patch-only

    ["1.x || 2.x", "2.3.4"],
    ["1.2.3 - 2.3.4", "2.3.4"],
    ["1.2.5", "1.2.5"], // exact version used as a range
    ["*", "3.0.0"],
  ])("maxSatisfying(versions, %s) -> %s", (range, expected) => {
    expect(maxSatisfying(versions, range)).toBe(expected);
  });

  test("returns undefined when nothing satisfies the range", () => {
    expect(maxSatisfying(versions, "^5.0.0")).toBeUndefined();
    expect(maxSatisfying(versions, ">10.0.0")).toBeUndefined();
  });

  test("prerelease versions are excluded by default (matching npm's own semver semantics)", () => {
    const withPrerelease = [...versions, "1.4.0-beta.1"];
    // A plain range does not admit a prerelease of a version it doesn't
    // explicitly reference — the released 1.3.0 still wins over 1.4.0-beta.1.
    expect(maxSatisfying(withPrerelease, "^1.2.0")).toBe("1.3.0");
    // A range that explicitly targets the same [major, minor, patch] with a
    // prerelease tag DOES admit it (narrowed version list so no released
    // version in the same range outranks the prerelease).
    expect(maxSatisfying(["1.3.0", "1.4.0-beta.1"], ">=1.4.0-alpha")).toBe("1.4.0-beta.1");
  });

  test("hyphen range with only a partial upper bound", () => {
    expect(maxSatisfying(versions, "1.0.0 - 1.2.5")).toBe("1.2.5");
  });
});

describe("highestVersion — orders known versions with prereleases included", () => {
  test("stable, beta and alpha of the same month: the stable release is highest, then beta, then alpha", () => {
    expect(highestVersion(["0.10.261013-alpha", "0.10.261013", "0.10.261013-beta"])).toBe("0.10.261013");
    expect(highestVersion(["0.10.261013-alpha", "0.10.261013-beta"])).toBe("0.10.261013-beta");
  });

  test("across months a later build is highest whatever its stage", () => {
    expect(highestVersion(["0.10.261013", "0.10.261015-beta", "0.10.261101-alpha"])).toBe("0.10.261101-alpha");
    expect(highestVersion(["0.10.261101-alpha", "0.10.261015", "0.10.261015-beta"])).toBe("0.10.261101-alpha");
  });

  test("a 0.10 prerelease sorts above the 0.9 stable line, which maxSatisfying '*' would skip", () => {
    const versions = ["0.9.30202610090106", "0.10.261013-beta"];
    expect(maxSatisfying(versions, "*")).toBe("0.9.30202610090106");
    expect(highestVersion(versions)).toBe("0.10.261013-beta");
  });

  test("invalid entries are ignored; none valid is undefined", () => {
    expect(highestVersion(["latest", "0.9.1", "not-a-version"])).toBe("0.9.1");
    expect(highestVersion(["latest"])).toBeUndefined();
    expect(highestVersion([])).toBeUndefined();
  });
});
