// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * P1 — robots.txt compliance: pure-function and policy-layer unit tests.
 *
 * Authoritative spec: docs/plans/specs/p1-robots.md. Row IDs in test names
 * (P-xx, D-xx, M-xx, L-xx, F-xx, G-xx) refer to that spec's behavior tables
 * (§4.1–§4.7) so failures can be traced back to the exact requirement.
 *
 * No real network: `loadRobotsTxt` tests go through `withMockedFetch`, and
 * every non-IP-literal hostname passes an injected `resolveHostname` stub so
 * no real DNS lookup ever runs (mirrors tests/integration/website-ssrf.test.ts).
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { ConfigError, UsageError } from "../src/core/errors";
import { _setWarnSinkForTests } from "../src/core/warn";
import {
  ALLOW_ALL_RULES,
  createAllowAllRobotsPolicy,
  createRobotsPolicy,
  DISALLOW_ALL_RULES,
  isPathAllowedByRobots,
  MAX_CRAWL_DELAY_MS,
  parseRobotsTxt,
  ROBOTS_BODY_TIMEOUT_MS,
  ROBOTS_BYTE_CAP,
  ROBOTS_FETCH_TIMEOUT_MS,
  ROBOTS_PRODUCT_TOKENS,
  ROBOTS_USER_AGENT_HEADER,
  type RobotsFetchOutcome,
  type RobotsRuleKind,
  type RobotsRuleSet,
  type RobotsTxtLoader,
} from "../src/sources/snapshot-fetchers/robots";
import {
  loadRobotsTxt,
  resolveCrawlTimeoutMs,
  resolvePositiveInt,
  resolveRespectRobots,
} from "../src/sources/snapshot-fetchers/website-ingest";
import { withMockedFetch } from "./_helpers/sandbox";
import { overrideSeam } from "./_helpers/seams";

// ── Shared warn()/warnVerbose() capture ─────────────────────────────────────
//
// Captures BEFORE the quiet/verbose gate (see src/core/warn.ts), so this sees
// warnVerbose() calls regardless of AKM_VERBOSE state.

let warnCalls: string[] = [];
let warnVerboseCalls: string[] = [];

beforeEach(() => {
  warnCalls = [];
  warnVerboseCalls = [];
  overrideSeam(_setWarnSinkForTests, (level, args) => {
    const message = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
    if (level === "warn") warnCalls.push(message);
    if (level === "warnVerbose") warnVerboseCalls.push(message);
  });
});

// ── §2 Constants (pin these exactly) ────────────────────────────────────────

describe("robots.ts constants", () => {
  test("pins the exact values specified in §2 of the spec", () => {
    expect(ROBOTS_PRODUCT_TOKENS).toEqual(["akm", "akm-cli"]);
    expect(ROBOTS_BYTE_CAP).toBe(512 * 1024);
    expect(ROBOTS_FETCH_TIMEOUT_MS).toBe(15_000);
    expect(ROBOTS_BODY_TIMEOUT_MS).toBe(15_000);
    expect(MAX_CRAWL_DELAY_MS).toBe(10_000);
    expect(ROBOTS_USER_AGENT_HEADER).toBe("akm-cli website provider");
  });

  test("ALLOW_ALL_RULES and DISALLOW_ALL_RULES are pinned sentinels", () => {
    expect(ALLOW_ALL_RULES).toEqual({ disallowAll: false, rules: [], crawlDelayMs: null });
    expect(DISALLOW_ALL_RULES).toEqual({ disallowAll: true, rules: [], crawlDelayMs: null });
  });
});

// ── §4.1 parseRobotsTxt — grouping and directives (P-01…P-24) ──────────────

describe("parseRobotsTxt — grouping and directives", () => {
  test("P-01: empty input yields the empty rule set", () => {
    expect(parseRobotsTxt("")).toEqual({ disallowAll: false, rules: [], crawlDelayMs: null });
  });

  test("P-03: a wildcard group's Disallow becomes one disallow rule", () => {
    const result = parseRobotsTxt("User-agent: *\nDisallow: /private/");
    expect(result.rules).toEqual([{ kind: "disallow", pattern: "/private/", specificity: "/private/".length }]);
  });

  test("P-04: directive names are case-insensitive", () => {
    const result = parseRobotsTxt("USER-AGENT: *\nDISALLOW: /a");
    expect(result.rules).toEqual([{ kind: "disallow", pattern: "/a", specificity: 2 }]);
  });

  test("P-05: pattern VALUES are case-sensitive (kept verbatim)", () => {
    const result = parseRobotsTxt("User-agent: *\nDisallow: /Case");
    expect(result.rules).toEqual([{ kind: "disallow", pattern: "/Case", specificity: 5 }]);
  });

  test("P-06: a group naming the 'akm' product token matches", () => {
    const result = parseRobotsTxt("user-agent: akm\nDisallow: /x");
    expect(result.rules).toEqual([{ kind: "disallow", pattern: "/x", specificity: 2 }]);
  });

  test("P-08: a group for an unrelated UA with no wildcard fallback matches nothing", () => {
    const result = parseRobotsTxt("User-agent: googlebot\nDisallow: /x");
    expect(result.rules).toEqual([]);
  });

  test("P-09: a matching SPECIFIC group suppresses the wildcard group entirely", () => {
    const result = parseRobotsTxt("User-agent: *\nDisallow: /all\n\nUser-agent: akm\nDisallow: /mine");
    expect(result.rules).toEqual([{ kind: "disallow", pattern: "/mine", specificity: 5 }]);
  });

  test("P-10: consecutive User-agent lines form ONE group (assert on match behavior, not array length)", () => {
    const result = parseRobotsTxt("User-agent: akm\nUser-agent: akm-cli\nDisallow: /x");
    expect(isPathAllowedByRobots(result, "http://example.com/x")).toBe(false);
    expect(isPathAllowedByRobots(result, "http://example.com/y")).toBe(true);
  });

  test("P-11: rules from all matching SPECIFIC groups are unioned", () => {
    const result = parseRobotsTxt("User-agent: akm\nDisallow: /a\n\nUser-agent: akm-cli\nDisallow: /b");
    expect(isPathAllowedByRobots(result, "http://example.com/a")).toBe(false);
    expect(isPathAllowedByRobots(result, "http://example.com/b")).toBe(false);
    expect(isPathAllowedByRobots(result, "http://example.com/c")).toBe(true);
  });

  test("P-12: rules from multiple wildcard groups are unioned", () => {
    const result = parseRobotsTxt("User-agent: *\nDisallow: /a\n\nUser-agent: *\nDisallow: /b");
    expect(isPathAllowedByRobots(result, "http://example.com/a")).toBe(false);
    expect(isPathAllowedByRobots(result, "http://example.com/b")).toBe(false);
  });

  test("P-13: a Disallow with no preceding User-agent is ignored", () => {
    expect(parseRobotsTxt("Disallow: /orphan").rules).toEqual([]);
  });

  test("P-14: CRLF line endings parse identically to LF, no stray \\r in the pattern", () => {
    const result = parseRobotsTxt("User-agent: *\r\nDisallow: /x\r\n");
    expect(result.rules).toEqual([{ kind: "disallow", pattern: "/x", specificity: 2 }]);
  });

  test("P-15: trailing comments are stripped from both the UA value and the pattern", () => {
    const result = parseRobotsTxt("User-agent: *  # our bot\nDisallow: /x # secret");
    expect(result.rules).toEqual([{ kind: "disallow", pattern: "/x", specificity: 2 }]);
  });

  test("P-16: an empty Disallow value is ignored (matches everything => allowed)", () => {
    expect(parseRobotsTxt("User-agent: *\nDisallow:").rules).toEqual([]);
  });

  test("P-17: Allow and Disallow both parse into their own rule kinds", () => {
    const result = parseRobotsTxt("User-agent: *\nAllow: /pub/\nDisallow: /");
    expect(result.rules).toContainEqual({ kind: "allow", pattern: "/pub/", specificity: 5 });
    expect(result.rules).toContainEqual({ kind: "disallow", pattern: "/", specificity: 1 });
    expect(result.rules).toHaveLength(2);
  });

  test("P-18: a Disallow value neither / nor *-rooted is ignored, diagnosed via warnVerbose only", () => {
    const result = parseRobotsTxt("User-agent: *\nDisallow: relative/path");
    expect(result.rules).toEqual([]);
    expect(warnCalls).toEqual([]);
    expect(warnVerboseCalls.length).toBeGreaterThanOrEqual(1);
  });

  test("P-20: unknown directives are ignored without error", () => {
    expect(parseRobotsTxt("User-agent: *\nUnknown-Directive: foo").rules).toEqual([]);
  });

  test("P-21: a line with no colon is ignored", () => {
    expect(parseRobotsTxt("User-agent: *\ngarbage").rules).toEqual([]);
  });

  test("P-22: only the first colon splits directive from value", () => {
    const result = parseRobotsTxt("User-agent: *\nDisallow: /a:b");
    expect(result.rules).toEqual([{ kind: "disallow", pattern: "/a:b", specificity: 4 }]);
  });

  test("P-23: a leading UTF-8 BOM before User-agent is stripped", () => {
    const result = parseRobotsTxt("﻿User-agent: *\nDisallow: /x");
    expect(result.rules).toEqual([{ kind: "disallow", pattern: "/x", specificity: 2 }]);
  });

  test("P-24: 5000 rule lines parse without pathological blowup", () => {
    const lines = ["User-agent: *"];
    for (let i = 0; i < 5000; i++) lines.push(`Disallow: /path-${i}`);
    const result = parseRobotsTxt(lines.join("\n"));
    expect(result.rules).toHaveLength(5000);
    expect(result.rules[4999]).toEqual({
      kind: "disallow",
      pattern: "/path-4999",
      specificity: "/path-4999".length,
    });
  });
});

// ── §4.2 parseRobotsTxt — Crawl-delay (D-01…D-12) ───────────────────────────

describe("parseRobotsTxt — Crawl-delay", () => {
  test.each([
    ["Crawl-delay: 2", 2000], // D-01
    ["Crawl-delay: 0", null], // D-03
    ["Crawl-delay: abc", null], // D-05
    ["Crawl-delay: 3600", 10_000], // D-07 — clamped
    ["Crawl-delay: 2.5", 2500], // D-11
  ])("%s => crawlDelayMs %p", (directive, expected) => {
    const result = parseRobotsTxt(`User-agent: *\n${directive}`);
    expect(result.crawlDelayMs).toBe(expected);
  });

  test("D-09: crawlDelayMs is the MAXIMUM across all matching (specific) groups, then clamped", () => {
    const result = parseRobotsTxt("User-agent: akm\nCrawl-delay: 1\n\nUser-agent: akm-cli\nCrawl-delay: 4");
    expect(result.crawlDelayMs).toBe(4000);
  });

  test("D-10: Crawl-delay inside a non-matching group does not apply", () => {
    expect(parseRobotsTxt("User-agent: googlebot\nCrawl-delay: 2").crawlDelayMs).toBeNull();
  });

  test("D-12: Crawl-delay: NaN is ignored; Crawl-delay: Infinity is clamped", () => {
    expect(parseRobotsTxt("User-agent: *\nCrawl-delay: NaN").crawlDelayMs).toBeNull();
    expect(parseRobotsTxt("User-agent: *\nCrawl-delay: Infinity").crawlDelayMs).toBe(10_000);
  });
});

// ── §4.3 isPathAllowedByRobots — pattern matching (M-01…M-32) ──────────────

function ruleSet(rules: Array<{ kind: RobotsRuleKind; pattern: string }>): RobotsRuleSet {
  return {
    disallowAll: false,
    crawlDelayMs: null,
    rules: rules.map((r) => ({ ...r, specificity: r.pattern.length })),
  };
}

function urlFor(pathAndQuery: string): string {
  return `http://example.com${pathAndQuery}`;
}

describe("isPathAllowedByRobots", () => {
  test("M-01: no rules allows anything", () => {
    expect(isPathAllowedByRobots(ruleSet([]), urlFor("/anything"))).toBe(true);
  });

  test("M-02: disallowAll blocks everything regardless of rules", () => {
    expect(isPathAllowedByRobots(DISALLOW_ALL_RULES, urlFor("/"))).toBe(false);
  });

  test("M-03/M-04: Disallow: / blocks the root and any deeper path", () => {
    const rules = ruleSet([{ kind: "disallow", pattern: "/" }]);
    expect(isPathAllowedByRobots(rules, urlFor("/"))).toBe(false);
    expect(isPathAllowedByRobots(rules, urlFor("/deep/page"))).toBe(false);
  });

  test("M-05/M-06/M-07: Disallow: /private is a PREFIX match (no word boundary)", () => {
    const rules = ruleSet([{ kind: "disallow", pattern: "/private" }]);
    expect(isPathAllowedByRobots(rules, urlFor("/private"))).toBe(false);
    expect(isPathAllowedByRobots(rules, urlFor("/private/x"))).toBe(false);
    expect(isPathAllowedByRobots(rules, urlFor("/privateer"))).toBe(false);
  });

  test("M-08: a trailing-slash pattern does not prefix-match a longer word", () => {
    const rules = ruleSet([{ kind: "disallow", pattern: "/private/" }]);
    expect(isPathAllowedByRobots(rules, urlFor("/privateer"))).toBe(true);
  });

  test("M-10: path matching is case-sensitive", () => {
    const rules = ruleSet([{ kind: "disallow", pattern: "/private" }]);
    expect(isPathAllowedByRobots(rules, urlFor("/Private"))).toBe(true);
  });

  test("M-11/M-12: a trailing $ anchors the end of pathname+search", () => {
    const rules = ruleSet([{ kind: "disallow", pattern: "/*.pdf$" }]);
    expect(isPathAllowedByRobots(rules, urlFor("/docs/a.pdf"))).toBe(false);
    expect(isPathAllowedByRobots(rules, urlFor("/docs/a.pdf?v=1"))).toBe(true);
  });

  test("M-13: without a trailing $, a query-string suffix does not save a match", () => {
    const rules = ruleSet([{ kind: "disallow", pattern: "/*.pdf" }]);
    expect(isPathAllowedByRobots(rules, urlFor("/docs/a.pdf?v=1"))).toBe(false);
  });

  test("M-14/M-15/M-16: '*' matches any sequence, including empty", () => {
    const rules = ruleSet([{ kind: "disallow", pattern: "/a/*/b" }]);
    expect(isPathAllowedByRobots(rules, urlFor("/a/x/b"))).toBe(false);
    expect(isPathAllowedByRobots(rules, urlFor("/a//b"))).toBe(false);
    expect(isPathAllowedByRobots(rules, urlFor("/a/x/c"))).toBe(true);
  });

  test("M-17/M-18: a trailing $ with no wildcard requires an exact match", () => {
    const rules = ruleSet([{ kind: "disallow", pattern: "/x$" }]);
    expect(isPathAllowedByRobots(rules, urlFor("/x"))).toBe(false);
    expect(isPathAllowedByRobots(rules, urlFor("/xy"))).toBe(true);
  });

  test("M-20/M-21: regex metacharacters in a pattern are literal", () => {
    const rules = ruleSet([{ kind: "disallow", pattern: "/a+b" }]);
    expect(isPathAllowedByRobots(rules, urlFor("/a+b"))).toBe(false);
    expect(isPathAllowedByRobots(rules, urlFor("/aab"))).toBe(true);
  });

  test("M-23/M-24: Allow wins over a broader Disallow by longest match", () => {
    const rules = ruleSet([
      { kind: "disallow", pattern: "/" },
      { kind: "allow", pattern: "/pub" },
    ]);
    expect(isPathAllowedByRobots(rules, urlFor("/pub/x"))).toBe(true);
    expect(isPathAllowedByRobots(rules, urlFor("/other"))).toBe(false);
  });

  test("M-25: an exact tie between Allow and Disallow goes to Allow", () => {
    const rules = ruleSet([
      { kind: "disallow", pattern: "/p" },
      { kind: "allow", pattern: "/p" },
    ]);
    expect(isPathAllowedByRobots(rules, urlFor("/p"))).toBe(true);
  });

  test("M-26/M-27: longest match wins with wildcard/anchor patterns on both sides", () => {
    const rules = ruleSet([
      { kind: "disallow", pattern: "/folder/" },
      { kind: "allow", pattern: "/folder/*.html$" },
    ]);
    expect(isPathAllowedByRobots(rules, urlFor("/folder/a.html"))).toBe(true);
    expect(isPathAllowedByRobots(rules, urlFor("/folder/a.txt"))).toBe(false);
  });

  test("M-29: the pattern must match starting at the pathname, not inside the query string", () => {
    const rules = ruleSet([{ kind: "disallow", pattern: "/?q=" }]);
    expect(isPathAllowedByRobots(rules, urlFor("/search?q=1"))).toBe(true);
  });

  test("M-30: a leading wildcard lets the pattern match inside the query string", () => {
    const rules = ruleSet([{ kind: "disallow", pattern: "/*?q=" }]);
    expect(isPathAllowedByRobots(rules, urlFor("/search?q=1"))).toBe(false);
  });

  test("M-31: percent-encoded octets compare literally, as URL.pathname produces them", () => {
    const rules = ruleSet([{ kind: "disallow", pattern: "/caf%C3%A9" }]);
    expect(isPathAllowedByRobots(rules, urlFor("/caf%C3%A9"))).toBe(false);
  });

  // Percent-encoding normalization regression: a percent-encoded alias of a
  // disallowed path must not bypass robots.txt. `URL.pathname` preserves
  // %-escapes verbatim (confirmed above by M-31), so without normalizing
  // UNRESERVED octets on both the rule pattern and the match target,
  // `Disallow: /secret/` would never match a link written as `/%73ecret/`
  // (`%73` decodes to the unreserved byte `s`) even though it names the
  // exact same resource.
  test("percent-encoding regression: an unreserved percent-encoded alias of a disallowed path still matches", () => {
    const rules = ruleSet([{ kind: "disallow", pattern: "/secret/" }]);
    expect(isPathAllowedByRobots(rules, urlFor("/%73ecret/"))).toBe(false);
    // Symmetric direction: the PATTERN itself written with an unreserved
    // escape must match a literally-written target too.
    const escapedPatternRules = ruleSet([{ kind: "disallow", pattern: "/%73ecret/" }]);
    expect(isPathAllowedByRobots(escapedPatternRules, urlFor("/secret/"))).toBe(false);
  });

  // M-31 must stay green under the same normalization: %C3/%A9 are NOT
  // unreserved octets (they decode to non-ASCII UTF-8 continuation bytes),
  // so they must never be decoded — only left exactly as written on both
  // sides, which still compares equal to itself.
  test("percent-encoding regression: reserved/non-ASCII octets (M-31's %C3%A9) are never decoded", () => {
    const rules = ruleSet([{ kind: "disallow", pattern: "/caf%C3%A9" }]);
    expect(isPathAllowedByRobots(rules, urlFor("/caf%C3%A9"))).toBe(false);
    // A path-separator escape (%2F) must never be decoded to a literal '/' —
    // that would silently turn one path segment into two and change which
    // resource the pattern refers to.
    const slashRules = ruleSet([{ kind: "disallow", pattern: "/a%2Fb" }]);
    expect(isPathAllowedByRobots(slashRules, urlFor("/a/b"))).toBe(true); // no match: %2F != '/'
    expect(isPathAllowedByRobots(slashRules, urlFor("/a%2Fb"))).toBe(false); // matches itself
  });

  test("M-32: an unparseable URL fails open (allowed), not closed", () => {
    const rules = ruleSet([{ kind: "disallow", pattern: "/" }]);
    expect(isPathAllowedByRobots(rules, "not a url")).toBe(true);
  });

  // §6.4 ReDoS / pattern-collapse: consecutive '*' must collapse to a single
  // '.*' per run, not one '.*' per '*'. A naive `pattern.replace(/\*/g, ".*")`
  // (one '.*' per star, uncollapsed) compiles a regex with 40 sequential
  // '.*' groups; matched against a long string containing none of the
  // required trailing literal, that shape forces the engine to explore every
  // backtracking split point across all 40 groups — catastrophic, effectively
  // non-terminating for realistic input sizes. A correct implementation
  // collapses the run to one '.*' and resolves in linear time regardless of
  // how many literal '*' characters appear in the pattern.
  //
  // The time budget is enforced via bun's own per-test `timeout` (not a
  // manual `Date.now()`/`performance.now()` delta assertion, which
  // `scripts/lint-tests-isolation.ts` bans as flake-prone): a correct
  // (collapsed) implementation resolves in well under a millisecond, while a
  // naive uncollapsed one blows this budget by many orders of magnitude.
  test(
    "§6.4: a pathological run of consecutive '*' resolves quickly, not via catastrophic backtracking",
    () => {
      const rules = ruleSet([{ kind: "disallow", pattern: `/${"*".repeat(40)}x` }]);

      // No "x" anywhere in the path, so the pattern can never match no matter
      // how the collapsed (or, if buggy, uncollapsed) wildcard run is split —
      // the worst case for a backtracking engine, since it must exhaust every
      // split combination before concluding failure.
      const nonMatchingPath = `/${"a".repeat(60)}`;
      expect(isPathAllowedByRobots(rules, urlFor(nonMatchingPath))).toBe(true); // no match => allowed

      // A matching path exercises the same pathological pattern shape on the
      // success path, confirming collapse doesn't just "fail fast" — it still
      // matches correctly when the trailing literal is present.
      const matchingPath = `/${"a".repeat(60)}x`;
      expect(isPathAllowedByRobots(rules, urlFor(matchingPath))).toBe(false); // matches => disallowed
    },
    { timeout: 100 },
  );

  // §6.4 ReDoS regression (review finding robots.ts:211): collapsing
  // consecutive '*' does NOT defeat this shape. Here the wildcards are
  // separated by a short literal ("a"), so there is nothing to collapse —
  // a regex-based matcher built as `/^\/(?:.*a){N}$/`-equivalent from
  // `/*a*a*a*a*a*a*a*a$` forces the engine to explore an exponential number
  // of ways to split a long, non-matching path across N '.*' groups before
  // concluding failure. Measured against the old implementation: 8
  // wildcards ~217ms, 10 ~2.8s, 11 ~7.5s, 12 ~19.9s (~2.7x per added
  // wildcard) — i.e. it never returns for realistic wildcard counts well
  // within the 512 KiB robots.txt cap. A non-backtracking matcher resolves
  // this in microseconds regardless of wildcard count, so a generous 200ms
  // budget leaves no room for exponential behavior to sneak back in while
  // still being nowhere near what a correct implementation needs.
  test(
    "§6.4 regression: distinct '*a' wildcards (not consecutive '*') do not backtrack catastrophically",
    () => {
      const wildcardCount = 30;
      const pattern = `/${"*a".repeat(wildcardCount)}$`;
      const rules = ruleSet([{ kind: "disallow", pattern }]);

      // A long run of "a" that almost satisfies the pattern, immediately
      // followed by one character that breaks the trailing `$` anchor. This
      // is the actual pathological shape for `(.*a){N}$`-style patterns: a
      // path with NO "a" at all fails on the very first literal and would
      // resolve quickly even under naive backtracking, but a near-miss like
      // this forces a backtracking engine to try every way of distributing
      // the "a" run across the N groups before it can conclude — for each of
      // them — that none end in "a" at the required final position.
      const nonMatchingPath = `/${"a".repeat(200)}b`;
      expect(isPathAllowedByRobots(rules, urlFor(nonMatchingPath))).toBe(true); // no match => allowed

      // A matching path (the literal "a" repeated, with nothing extra after
      // the last one) exercises the same pattern shape on the success path.
      const matchingPath = `/${"a".repeat(wildcardCount)}`;
      expect(isPathAllowedByRobots(rules, urlFor(matchingPath))).toBe(false); // matches => disallowed
    },
    { timeout: 200 },
  );
});

// ── §4.4 createRobotsPolicy / createAllowAllRobotsPolicy (L-01…L-04) ───────

function loaderReturning(outcome: RobotsFetchOutcome): { load: RobotsTxtLoader; calls: string[] } {
  const calls: string[] = [];
  const load: RobotsTxtLoader = async (robotsUrl) => {
    calls.push(robotsUrl);
    return outcome;
  };
  return { load, calls };
}

describe("createRobotsPolicy", () => {
  test("L-01: a 'body' outcome is parsed via parseRobotsTxt", async () => {
    const text = "User-agent: *\nDisallow: /private\nCrawl-delay: 1\n";
    const policy = createRobotsPolicy(async () => ({ kind: "body", text }));
    await expect(policy.rulesFor("http://example.test/")).resolves.toEqual(parseRobotsTxt(text));
    expect(await policy.isAllowed("http://example.test/private")).toBe(false);
    expect(await policy.isAllowed("http://example.test/ok")).toBe(true);
  });

  test("L-02: an 'unavailable' outcome caches ALLOW_ALL_RULES", async () => {
    const policy = createRobotsPolicy(async () => ({ kind: "unavailable" }));
    await expect(policy.rulesFor("http://example.test/")).resolves.toEqual(ALLOW_ALL_RULES);
    expect(await policy.isAllowed("http://example.test/anything")).toBe(true);
  });

  test("L-03: an 'unreachable' outcome caches DISALLOW_ALL_RULES", async () => {
    const policy = createRobotsPolicy(async () => ({ kind: "unreachable" }));
    await expect(policy.rulesFor("http://example.test/")).resolves.toEqual(DISALLOW_ALL_RULES);
    expect(await policy.isAllowed("http://example.test/anything")).toBe(false);
    expect(await policy.crawlDelayMs("http://example.test/anything")).toBe(0);
  });

  test("L-04: a loader throw propagates and caches nothing (retried on next call)", async () => {
    let callCount = 0;
    const load: RobotsTxtLoader = async () => {
      callCount++;
      if (callCount === 1) throw new Error("boom");
      return { kind: "body", text: "" };
    };
    const policy = createRobotsPolicy(load);
    await expect(policy.rulesFor("http://example.test/")).rejects.toThrow("boom");
    await expect(policy.rulesFor("http://example.test/")).resolves.toEqual(ALLOW_ALL_RULES);
    expect(callCount).toBe(2);
  });

  test("fetches robots.txt at most once per origin, deduping in-flight requests", async () => {
    let callCount = 0;
    const load: RobotsTxtLoader = async () => {
      callCount++;
      return { kind: "body", text: "User-agent: *\nDisallow: /x" };
    };
    const policy = createRobotsPolicy(load);
    const origin = "http://example.test";
    const [a, b] = await Promise.all([policy.isAllowed(`${origin}/x`), policy.isAllowed(`${origin}/y`)]);
    expect(a).toBe(false);
    expect(b).toBe(true);
    expect(callCount).toBe(1);

    // A later, sequential call against the same origin must still hit the cache.
    await policy.isAllowed(`${origin}/z`);
    expect(callCount).toBe(1);
  });

  test("passes the origin-root robots.txt URL to the loader, never a path-relative one", async () => {
    const { load, calls } = loaderReturning({ kind: "body", text: "" });
    const policy = createRobotsPolicy(load);
    await policy.isAllowed("http://example.test/deep/nested/page?x=1");
    expect(calls).toEqual(["http://example.test/robots.txt"]);
  });

  test("reports 0ms crawl delay when robots.txt sets none", async () => {
    const policy = createRobotsPolicy(async () => ({ kind: "body", text: "User-agent: *\n" }));
    expect(await policy.crawlDelayMs("http://example.test/")).toBe(0);
  });
});

describe("createAllowAllRobotsPolicy", () => {
  test("never invokes a loader and always allows with zero delay", async () => {
    const policy = createAllowAllRobotsPolicy();
    expect(await policy.isAllowed("http://example.test/anything")).toBe(true);
    expect(await policy.crawlDelayMs("http://example.test/anything")).toBe(0);
    expect(await policy.rulesFor("http://example.test/anything")).toEqual(ALLOW_ALL_RULES);
  });
});

// ── §4.5 loadRobotsTxt (F-01…F-12) ──────────────────────────────────────────

const ROBOTS_URL = "https://example.test/robots.txt";
// No real DNS: a fixed public-looking answer, matching website-ssrf.test.ts's
// resolverReturning() pattern.
const resolveHostname = async () => ["93.184.216.34"];

describe("loadRobotsTxt", () => {
  test("F-01: 200 with a body returns { kind: 'body' }", async () => {
    const text = "User-agent: *\nDisallow: /x";
    const outcome = await withMockedFetch(
      () => loadRobotsTxt(ROBOTS_URL, { resolveHostname }),
      () => new Response(text, { status: 200, headers: { "content-type": "text/plain" } }),
    );
    expect(outcome).toEqual({ kind: "body", text });
    expect(warnCalls).toEqual([]);
  });

  test("F-02: 204 with an empty body still parses to allow-all", async () => {
    const outcome = await withMockedFetch(
      () => loadRobotsTxt(ROBOTS_URL, { resolveHostname }),
      () => new Response(null, { status: 204 }),
    );
    expect(outcome).toEqual({ kind: "body", text: "" });
  });

  test("F-03: 404 is unavailable and completely silent (the common case)", async () => {
    const outcome = await withMockedFetch(
      () => loadRobotsTxt(ROBOTS_URL, { resolveHostname }),
      () => new Response("not found", { status: 404 }),
    );
    expect(outcome).toEqual({ kind: "unavailable" });
    expect(warnCalls).toEqual([]);
    expect(warnVerboseCalls).toEqual([]);
  });

  test("F-04: 401 is unavailable with no diagnostic", async () => {
    const outcome = await withMockedFetch(
      () => loadRobotsTxt(ROBOTS_URL, { resolveHostname }),
      () => new Response("nope", { status: 401 }),
    );
    expect(outcome).toEqual({ kind: "unavailable" });
    expect(warnCalls).toEqual([]);
  });

  test("F-06: 500 is unavailable (not unreachable) and warns, naming the URL, status, and respectRobots", async () => {
    const outcome = await withMockedFetch(
      () => loadRobotsTxt(ROBOTS_URL, { resolveHostname }),
      () => new Response("boom", { status: 500 }),
    );
    expect(outcome).toEqual({ kind: "unavailable" });
    expect(warnCalls.length).toBeGreaterThanOrEqual(1);
    const message = warnCalls.join(" ");
    expect(message).toContain(ROBOTS_URL);
    expect(message).toContain("500");
    expect(message).toMatch(/respectRobots/);
  });

  test("F-08: an oversized body (via Content-Length) is unavailable and warns naming the URL and cap", async () => {
    const outcome = await withMockedFetch(
      () => loadRobotsTxt(ROBOTS_URL, { resolveHostname }),
      () => new Response("x", { status: 200, headers: { "content-length": String(ROBOTS_BYTE_CAP + 1) } }),
    );
    expect(outcome).toEqual({ kind: "unavailable" });
    const message = warnCalls.join(" ");
    expect(message).toContain(ROBOTS_URL);
    expect(message).toContain(String(ROBOTS_BYTE_CAP));
  });

  test("F-09: a thrown network error is unavailable, diagnosed via warnVerbose only", async () => {
    const outcome = await withMockedFetch(
      () => loadRobotsTxt(ROBOTS_URL, { resolveHostname }),
      () => {
        throw new Error("ECONNRESET");
      },
    );
    expect(outcome).toEqual({ kind: "unavailable" });
    expect(warnCalls).toEqual([]);
    expect(warnVerboseCalls.length).toBeGreaterThanOrEqual(1);
  });

  test("F-10: a redirect response missing Location is unavailable, diagnosed via warnVerbose", async () => {
    const outcome = await withMockedFetch(
      () => loadRobotsTxt(ROBOTS_URL, { resolveHostname }),
      () => new Response(null, { status: 302 }),
    );
    expect(outcome).toEqual({ kind: "unavailable" });
    expect(warnVerboseCalls.length).toBeGreaterThanOrEqual(1);
  });

  test("F-11: a redirect hop to a forbidden/private host is unavailable and that host is never fetched", async () => {
    const seenUrls: string[] = [];
    const outcome = await withMockedFetch(
      () => loadRobotsTxt(ROBOTS_URL, { resolveHostname }),
      (url) => {
        seenUrls.push(url);
        if (url === ROBOTS_URL) {
          return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/robots.txt" } });
        }
        throw new Error(`must not fetch forbidden redirect target, got ${url}`);
      },
    );
    expect(outcome).toEqual({ kind: "unavailable" });
    expect(seenUrls).toEqual([ROBOTS_URL]);
    expect(warnVerboseCalls.length).toBeGreaterThanOrEqual(1);
  });

  test("F-12: a guard rejection on the INITIAL robots.txt URL propagates, never becomes allow-all", async () => {
    let caught: unknown;
    try {
      await withMockedFetch(
        () => loadRobotsTxt("http://169.254.169.254/robots.txt"),
        (url) => {
          throw new Error(`fetch must not be called for a guard-rejected URL, got ${url}`);
        },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(UsageError);
  });
});

// ── Strict website option boundary ──────────────────────────────────────────

describe("resolveRespectRobots", () => {
  test.each([
    [undefined, true],
    [true, true],
    [false, false],
  ])("resolves %p to %p", (input, expected) => {
    expect(resolveRespectRobots(input)).toBe(expected);
  });

  test.each([[null], ["true"], [{}]])("rejects non-boolean value %p with a ConfigError", (input) => {
    expect(() => resolveRespectRobots(input)).toThrow(ConfigError);
    expect(() => resolveRespectRobots(input)).toThrow(/respectRobots.*boolean/i);
  });
});

describe("resolvePositiveInt", () => {
  test("uses the fallback only when the option is absent", () => {
    expect(resolvePositiveInt(undefined, 50, "maxPages")).toBe(50);
  });

  test.each([1, 50])("accepts positive integer %p", (input) => {
    expect(resolvePositiveInt(input, 50, "maxPages")).toBe(input);
  });

  test.each([[null], [0], [1.5], ["7"]])("rejects invalid positive integer %p", (input) => {
    expect(() => resolvePositiveInt(input, 50, "maxPages")).toThrow(ConfigError);
    expect(() => resolvePositiveInt(input, 50, "maxPages")).toThrow(/maxPages.*positive integer/i);
  });
});

describe("resolveCrawlTimeoutMs", () => {
  test("leaves an absent timeout unset and maps zero to the explicit disabled state", () => {
    expect(resolveCrawlTimeoutMs(undefined)).toBeUndefined();
    expect(resolveCrawlTimeoutMs(0)).toBeNull();
  });

  test.each([1, 600_000])("accepts nonzero integer timeout %p", (input) => {
    expect(resolveCrawlTimeoutMs(input)).toBe(input);
  });

  test.each([[null], [-1], [1.5], ["300"]])("rejects invalid timeout %p", (input) => {
    expect(() => resolveCrawlTimeoutMs(input)).toThrow(ConfigError);
    expect(() => resolveCrawlTimeoutMs(input)).toThrow(/crawlTimeoutMs.*non-negative integer/i);
  });
});
