// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Coverage-hardening: parseRegistryRef and maxSatisfying.
 *
 * parseRegistryRef is a heavily-branchy ref parser (npm / github / git+ /
 * file: / http(s) / bare-shorthand / registry-search-id) that was only ever
 * exercised INDIRECTLY through akmListSources/akmUpdate. Each transport
 * produces a differently-shaped ParsedRegistryRef (source + id), and the id is
 * the join key used downstream — a mis-parsed prefix silently mis-keys the
 * source (the relink-class gap). maxSatisfying + its semver helpers had NO
 * direct test at all; the caret / tilde / >= / prerelease branches are all
 * asserted here on real version lists.
 */

import { describe, expect, test } from "bun:test";
import { maxSatisfying, parseRegistryRef } from "../../src/registry/resolve";

// ── parseRegistryRef: transport dispatch ──────────────────────────────────────

describe("parseRegistryRef — npm", () => {
  test("parses an explicit npm: ref", () => {
    const p = parseRegistryRef("npm:left-pad");
    expect(p.source).toBe("npm");
    expect(p.id).toBe("npm:left-pad");
    if (p.source === "npm") {
      expect(p.packageName).toBe("left-pad");
      expect(p.requestedVersionOrTag).toBeUndefined();
    }
  });

  test("splits a version suffix off an npm: ref", () => {
    const p = parseRegistryRef("npm:left-pad@1.3.0");
    if (p.source !== "npm") throw new Error("expected npm ref");
    expect(p.packageName).toBe("left-pad");
    expect(p.requestedVersionOrTag).toBe("1.3.0");
  });

  test("parses a scoped package with a version", () => {
    const p = parseRegistryRef("npm:@scope/pkg@2.0.0");
    if (p.source !== "npm") throw new Error("expected npm ref");
    expect(p.packageName).toBe("@scope/pkg");
    expect(p.id).toBe("npm:@scope/pkg");
    expect(p.requestedVersionOrTag).toBe("2.0.0");
  });

  // NOTE: a bare, unprefixed scoped ref like "@scope/pkg" is EXPECTED to parse
  // as npm (parser.ts:85 special-cases `ref.startsWith("@")`), but currently
  // throws NotFoundError because isPathLikeRef() treats any "/"-containing ref
  // as an explicit local path. Removed here and reported as a suspected bug —
  // committing it would only lock in the buggy behavior.

  test("throws on an empty ref", () => {
    expect(() => parseRegistryRef("")).toThrow();
    expect(() => parseRegistryRef("   ")).toThrow();
  });
});

describe("parseRegistryRef — github", () => {
  test("parses an explicit github: shorthand", () => {
    const p = parseRegistryRef("github:owner/repo");
    if (p.source !== "github") throw new Error("expected github ref");
    expect(p.owner).toBe("owner");
    expect(p.repo).toBe("repo");
    expect(p.id).toBe("github:owner/repo");
    expect(p.requestedRef).toBeUndefined();
  });

  test("captures a #ref suffix on github shorthand", () => {
    const p = parseRegistryRef("github:owner/repo#v1.2.3");
    if (p.source !== "github") throw new Error("expected github ref");
    expect(p.requestedRef).toBe("v1.2.3");
    expect(p.id).toBe("github:owner/repo");
  });

  test("strips a trailing .git from the repo name", () => {
    const p = parseRegistryRef("github:owner/repo.git");
    if (p.source !== "github") throw new Error("expected github ref");
    expect(p.repo).toBe("repo");
  });

  test("rejects github shorthand that is not owner/repo shaped", () => {
    expect(() => parseRegistryRef("github:only-one-segment")).toThrow();
    expect(() => parseRegistryRef("github:a/b/c")).toThrow();
  });

  test("parses a full https://github.com URL, decoding the #ref fragment", () => {
    const p = parseRegistryRef("https://github.com/owner/repo#feature%2Fx");
    if (p.source !== "github") throw new Error("expected github ref");
    expect(p.owner).toBe("owner");
    expect(p.repo).toBe("repo");
    expect(p.requestedRef).toBe("feature/x");
  });
});

describe("parseRegistryRef — git and remote URLs", () => {
  test("parses a git+ transport ref and strips the transport prefix from the url", () => {
    const p = parseRegistryRef("git+https://example.com/team/repo.git#main");
    if (p.source !== "git") throw new Error("expected git ref");
    expect(p.url).toBe("https://example.com/team/repo.git");
    expect(p.requestedRef).toBe("main");
    // id normalises away the .git suffix
    expect(p.id).toBe("git:https://example.com/team/repo");
  });

  test("routes a non-github https URL to the generic git parser", () => {
    const p = parseRegistryRef("https://gitlab.com/group/repo.git");
    expect(p.source).toBe("git");
    if (p.source === "git") expect(p.url).toBe("https://gitlab.com/group/repo.git");
  });
});

describe("parseRegistryRef — registry search result IDs", () => {
  test("rejects a skills-sh: search ID with a helpful message (not an installable ref)", () => {
    let msg = "";
    try {
      parseRegistryRef("skills-sh:org/repo/skill-name");
    } catch (err) {
      msg = err instanceof Error ? err.message : String(err);
    }
    expect(msg).toContain("registry search result ID");
    // suggests the underlying github repo derived from the first two segments
    expect(msg).toContain("github:org/repo");
  });

  test("does NOT mistake a known npm: prefix for a registry search ID", () => {
    const p = parseRegistryRef("npm:some-pkg");
    expect(p.source).toBe("npm");
  });
});

// ── maxSatisfying: semver range resolution ────────────────────────────────────

describe("maxSatisfying — caret ranges", () => {
  test("^1.2.3 picks the highest same-major version at or above the floor", () => {
    expect(maxSatisfying(["1.2.3", "1.5.0", "1.9.9", "2.0.0"], "^1.2.3")).toBe("1.9.9");
  });

  test("^1.2.3 excludes versions below the floor and different majors", () => {
    expect(maxSatisfying(["1.0.0", "1.2.0", "2.0.0"], "^1.2.3")).toBeUndefined();
  });

  test("^0.2.3 pins the minor (0.x special-case): 0.3.0 is excluded", () => {
    expect(maxSatisfying(["0.2.3", "0.2.9", "0.3.0"], "^0.2.3")).toBe("0.2.9");
  });

  test("^0.2.3 excludes a lower patch in the same minor", () => {
    expect(maxSatisfying(["0.2.0", "0.2.2"], "^0.2.3")).toBeUndefined();
  });
});

describe("maxSatisfying — tilde and >= ranges", () => {
  test("~1.2.3 stays within the same major.minor", () => {
    expect(maxSatisfying(["1.2.3", "1.2.9", "1.3.0"], "~1.2.3")).toBe("1.2.9");
  });

  test(">=1.2.3 spans across majors and picks the newest", () => {
    expect(maxSatisfying(["1.2.3", "2.0.0", "3.1.4"], ">=1.2.3")).toBe("3.1.4");
  });

  test(">=1.2.3 excludes anything strictly below the floor", () => {
    expect(maxSatisfying(["1.0.0", "1.2.2"], ">=1.2.3")).toBeUndefined();
  });
});

describe("maxSatisfying — wildcard and prerelease handling", () => {
  test("* matches the highest stable version", () => {
    expect(maxSatisfying(["1.0.0", "2.3.4", "0.9.0"], "*")).toBe("2.3.4");
  });

  test("prerelease versions are skipped when the range has no prerelease tag", () => {
    expect(maxSatisfying(["1.2.3-beta.1", "1.2.3-rc.2"], "^1.2.0")).toBeUndefined();
  });

  test("a stable release is preferred over a prerelease of the same numbers under *", () => {
    // compareSemver ranks prerelease below its release, so the stable wins.
    expect(maxSatisfying(["1.2.3-beta.1", "1.2.3"], "*")).toBe("1.2.3");
  });

  test("ignores entries that are not valid semver", () => {
    expect(maxSatisfying(["not-a-version", "1.4.0", "latest"], "^1.0.0")).toBe("1.4.0");
  });

  test("returns undefined for an empty candidate list", () => {
    expect(maxSatisfying([], "^1.0.0")).toBeUndefined();
  });
});
