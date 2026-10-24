// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * robots.txt parsing, matching, and a crawl-scoped fetch/cache policy.
 *
 * Behavioral reference: docs/plans/specs/p1-robots.md (authoritative). This
 * module is a clean rewrite against akm's contracts, not a port of any
 * upstream source file.
 *
 * Pure by design: no fetching happens here (see `RobotsTxtLoader`/
 * `loadRobotsTxt` in `website-ingest.ts`). There is no crawl-semantic
 * module-level state: the per-origin HTTP cache lives on the object
 * `createRobotsPolicy` returns so it dies with the crawl that created it —
 * a module-level `origin -> RobotsRuleSet` map would leak `disallowAll`
 * results across crawls and across the test suite's process-wide `bun test`
 * run (see spec §6.1). The module-level `WeakMap` below is a different
 * category: it memoizes a pure function of an individual rule object's own
 * `pattern` field, keyed by that object's identity. It cannot leak meaning
 * between origins or tests — distinct `parseRobotsTxt` calls (even for
 * identical robots.txt text) allocate distinct rule objects with distinct
 * cache slots, and slots are reclaimed by the GC once a rule set is
 * unreachable. It is memoization scoped to a single parsed rule set, not
 * shared cross-crawl state.
 */

import { warnVerbose } from "../../core/warn";

// ── §2 Constants (pinned by spec) ───────────────────────────────────────────

/** Group-matching tokens for `User-agent`, compared case-insensitively. */
export const ROBOTS_PRODUCT_TOKENS = ["akm", "akm-cli"] as const;
/** 512 KiB. RFC 9309 §2.5 requires parsing at least 500 KiB. */
export const ROBOTS_BYTE_CAP = 512 * 1024;
/** Matches the existing website page-fetch timeout. */
export const ROBOTS_FETCH_TIMEOUT_MS = 15_000;
/** Body-read deadline; robots.txt is tiny. */
export const ROBOTS_BODY_TIMEOUT_MS = 15_000;
/** Ceiling applied to any parsed `Crawl-delay`, so a hostile robots.txt cannot stall the crawl. */
export const MAX_CRAWL_DELAY_MS = 10_000;
/** Identical to the existing website-fetch `User-Agent` header. */
export const ROBOTS_USER_AGENT_HEADER = "akm-cli website provider";

// ── §3 Public API surface (pinned by spec) ──────────────────────────────────

export type RobotsRuleKind = "allow" | "disallow";

export interface RobotsPathRule {
  readonly kind: RobotsRuleKind;
  /** Raw pattern text as written in robots.txt, e.g. "/private/", "/*.pdf$". */
  readonly pattern: string;
  /** Match specificity = pattern.length. Used for longest-match-wins. */
  readonly specificity: number;
}

export interface RobotsRuleSet {
  /** true => the entire origin is off-limits regardless of `rules`. */
  readonly disallowAll: boolean;
  readonly rules: readonly RobotsPathRule[];
  /** Already clamped to [0, MAX_CRAWL_DELAY_MS]; null when unspecified. */
  readonly crawlDelayMs: number | null;
}

/**
 * Frozen so a stray mutation (e.g. an accidental `.rules.push(...)` somewhere
 * that borrows one of these as a starting point) can never poison every other
 * crawl sharing this instance (spec §10, Review log 2026-08-01 finding 1).
 */
const EMPTY_ROBOTS_RULES: readonly RobotsPathRule[] = Object.freeze([]);
export const ALLOW_ALL_RULES: RobotsRuleSet = Object.freeze({
  disallowAll: false,
  rules: EMPTY_ROBOTS_RULES,
  crawlDelayMs: null,
});
export const DISALLOW_ALL_RULES: RobotsRuleSet = Object.freeze({
  disallowAll: true,
  rules: EMPTY_ROBOTS_RULES,
  crawlDelayMs: null,
});

export type RobotsFetchOutcome =
  | { readonly kind: "body"; readonly text: string }
  | { readonly kind: "unavailable" } // 4xx / oversized / transport failure => allow all
  | { readonly kind: "unreachable" }; // 5xx => disallow all

/** Injected by website-ingest.ts. Receives the absolute `<origin>/robots.txt` URL. */
export type RobotsTxtLoader = (robotsUrl: string) => Promise<RobotsFetchOutcome>;

export interface RobotsPolicy {
  /** Resolves (and caches) the rule set for the URL's origin. */
  rulesFor(url: string): Promise<RobotsRuleSet>;
  isAllowed(url: string): Promise<boolean>;
  /** Clamped crawl delay in ms for the URL's origin; 0 when none. */
  crawlDelayMs(url: string): Promise<number>;
}

// ── §4.1/§4.2 parseRobotsTxt ─────────────────────────────────────────────────

interface RobotsGroup {
  /** Lowercased User-agent tokens naming this group. */
  agents: string[];
  rules: RobotsPathRule[];
  /** Unclamped ms; clamping happens once at the end, on the selected max. */
  crawlDelayMsRaw: number | null;
}

/** Strips a trailing `# comment` (RFC 9309 comments run to end of line). */
function stripRobotsComment(line: string): string {
  const hashIndex = line.indexOf("#");
  return hashIndex === -1 ? line : line.slice(0, hashIndex);
}

/**
 * Parses a `Crawl-delay` value (seconds, possibly fractional) into ms.
 * Non-positive, unparseable, and empty values are ignored (`null`).
 * `Infinity` is preserved so the caller's clamp reduces it to the ceiling
 * rather than the value silently vanishing.
 */
function parseCrawlDelayMs(raw: string): number | null {
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isNaN(seconds) || seconds <= 0) return null;
  return Math.round(seconds * 1000);
}

/**
 * Pure. Never throws, never fetches.
 *
 * Grouping follows RFC 9309 §2.2.1: consecutive `User-agent` lines (no
 * intervening directive) form one group; a matching *specific* product-token
 * group suppresses the wildcard (`*`) group entirely; rules from all matching
 * groups of the winning kind are unioned; `Crawl-delay` is the maximum across
 * those groups, clamped once at the end.
 */
export function parseRobotsTxt(text: string): RobotsRuleSet {
  const stripped = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lines = stripped.split(/\r\n|\r|\n/);

  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | null = null;
  // True once any non-user-agent directive has been seen for `current`, so
  // the next `User-agent` line starts a NEW group instead of extending it.
  let sawDirectiveSinceLastUserAgent = false;

  for (const rawLine of lines) {
    const line = stripRobotsComment(rawLine).trim();
    if (!line) continue;

    const colonIndex = line.indexOf(":");
    if (colonIndex === -1) continue; // P-21: no colon => ignored

    const directive = line.slice(0, colonIndex).trim().toLowerCase();
    const value = line.slice(colonIndex + 1).trim();

    if (directive === "user-agent") {
      if (!value) continue;
      const token = value.toLowerCase();
      if (current && !sawDirectiveSinceLastUserAgent) {
        current.agents.push(token);
      } else {
        current = { agents: [token], rules: [], crawlDelayMsRaw: null };
        groups.push(current);
        sawDirectiveSinceLastUserAgent = false;
      }
      continue;
    }

    if (!current) continue; // P-13: directive with no preceding User-agent => ignored
    sawDirectiveSinceLastUserAgent = true;

    if (directive === "disallow" || directive === "allow") {
      if (!value) continue; // P-16: empty value matches nothing
      if (!(value.startsWith("/") || value.startsWith("*"))) {
        // P-18: neither "/" nor "*"-rooted => ignored, diagnosed quietly.
        warnVerbose("[akm] robots.txt: ignoring %s value %s (patterns must start with '/' or '*')", directive, value);
        continue;
      }
      const rule: RobotsPathRule = {
        kind: directive === "allow" ? "allow" : "disallow",
        pattern: value,
        specificity: value.length,
      };
      // Compile once, here, at parse time — not on every URL check (spec
      // §6.4, review finding robots.ts:238). See `compiledPatternCache`.
      compiledPatternCache.set(rule, compilePatternSegments(value));
      current.rules.push(rule);
      continue;
    }

    if (directive === "crawl-delay") {
      const parsed = parseCrawlDelayMs(value);
      if (parsed !== null) current.crawlDelayMsRaw = parsed;
    }

    // Sitemap / unknown directives: ignored without diagnostic (P-19, P-20).
  }

  const productTokens: readonly string[] = ROBOTS_PRODUCT_TOKENS;
  const specificGroups = groups.filter((group) => group.agents.some((agent) => productTokens.includes(agent)));
  const wildcardGroups = groups.filter((group) => group.agents.includes("*"));
  const selected = specificGroups.length > 0 ? specificGroups : wildcardGroups;

  const rules = selected.flatMap((group) => group.rules);
  let maxDelayMs: number | null = null;
  for (const group of selected) {
    if (group.crawlDelayMsRaw !== null) {
      maxDelayMs = maxDelayMs === null ? group.crawlDelayMsRaw : Math.max(maxDelayMs, group.crawlDelayMsRaw);
    }
  }
  const crawlDelayMs = maxDelayMs === null ? null : Math.min(maxDelayMs, MAX_CRAWL_DELAY_MS);

  return { disallowAll: false, rules, crawlDelayMs };
}

// ── §4.3 isPathAllowedByRobots ───────────────────────────────────────────────
//
// Matching is NOT regex-based. A pattern compiled to a RegExp with
// `*` -> `.*` produces one regex quantifier per wildcard; a pattern with
// several DISTINCT wildcards separated by short literals (e.g.
// `/*a*a*a*a*a*a*a*a$`, not consecutive stars — collapsing consecutive `*`
// does not help here) makes the regex engine explore an exponential number
// of ways to split a long non-matching input across those quantifiers,
// hanging the process (spec §6.4; review finding robots.ts:211). Instead,
// patterns are compiled to a flat list of literal segments split on `*`
// (consecutive `*` collapsed to one) and matched with a single left-to-right
// scan: the first segment must prefix the target, each interior segment is
// located with a single forward `indexOf` from the current position, and the
// final segment either anchors the end (trailing `$`) or is located the same
// way. This is a greedy, non-backtracking scan — each segment's search
// position only moves forward — so it runs in time bounded by
// segments x target length, never exponential, regardless of wildcard count.

interface CompiledRobotsPattern {
  /** True when the raw pattern ended in a literal, unescaped trailing `$`. */
  readonly anchored: boolean;
  /** Literal, unescaped text between wildcards; consecutive `*` collapsed. */
  readonly segments: readonly string[];
}

const COLLAPSE_STARS = /\*+/g;
const PERCENT_ENCODED_OCTET = /%[0-9a-fA-F]{2}/g;

/**
 * RFC 3986 §2.3 "unreserved" set: ALPHA / DIGIT / "-" / "." / "_" / "~".
 * A percent-encoded octet in this set is byte-identical to its literal
 * character (`%73` and `s` are the same byte), so it carries no meaning a
 * URL consumer can rely on. Every other octet — `%2F` ('/'), `%3F` ('?'),
 * `%23` ('#'), `%2A` ('*'), non-ASCII bytes like `%C3` — is "reserved" or
 * otherwise structurally significant and must be left percent-encoded:
 * decoding e.g. `%2F` would silently turn one path segment into two.
 */
function isUnreservedByte(byte: number): boolean {
  return (
    (byte >= 0x41 && byte <= 0x5a) || // A-Z
    (byte >= 0x61 && byte <= 0x7a) || // a-z
    (byte >= 0x30 && byte <= 0x39) || // 0-9
    byte === 0x2d || // -
    byte === 0x2e || // .
    byte === 0x5f || // _
    byte === 0x7e // ~
  );
}

/**
 * Normalizes percent-encoding for robots.txt matching, mirroring the RFC
 * 9309 reference matcher: percent-encoded UNRESERVED octets are decoded to
 * their literal character; every other `%XX` escape is left exactly as
 * written (including hex-digit case). Applied identically to rule patterns
 * (via `compilePatternSegments`, at parse time and in the defensive lazy
 * fallback) and match targets (`isPathAllowedByRobots`), so a percent-encoded
 * alias of a disallowed path — e.g. a link written as `/%73ecret/` — cannot
 * bypass `Disallow: /secret/` simply because `URL.pathname` preserves
 * %-escapes verbatim. Reserved-octet patterns like spec §4.3 M-31's
 * `/caf%C3%A9` are untouched on both sides (0xC3/0xA9 are not unreserved),
 * so they keep matching themselves exactly as before.
 */
function normalizePercentEncoding(value: string): string {
  if (!value.includes("%")) return value;
  return value.replace(PERCENT_ENCODED_OCTET, (octetEscape) => {
    const byte = Number.parseInt(octetEscape.slice(1), 16);
    if (isUnreservedByte(byte)) return String.fromCharCode(byte);
    // A reserved octet stays encoded, but `%2F` and `%2f` denote the same
    // byte — RFC 3986 §6.2.2.1 makes the hex digits case-insensitive. Without
    // canonicalizing the case, `Disallow: /a%2Fb` would fail to match a link
    // spelled `/a%2fb` and the page would be crawled anyway.
    return octetEscape.toUpperCase();
  });
}

function compilePatternSegments(pattern: string): CompiledRobotsPattern {
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const collapsed = normalizePercentEncoding(body).replace(COLLAPSE_STARS, "*");
  return { anchored, segments: collapsed.split("*") };
}

/**
 * Per-rule-object cache of the compiled pattern (see the file-level doc
 * comment for why this is not "module-level state" in the sense spec §6.1
 * forbids). `parseRobotsTxt` populates this eagerly, once, when it creates
 * each `RobotsPathRule` — the compile-once requirement from spec §6.4 /
 * review finding robots.ts:238. `compiledPatternFor` below is a defensive
 * fallback for `RobotsRuleSet`s assembled by hand (e.g. test fixtures)
 * rather than via `parseRobotsTxt`; it still compiles at most once per rule
 * object, just lazily on first use instead of at parse time.
 */
const compiledPatternCache = new WeakMap<RobotsPathRule, CompiledRobotsPattern>();

function compiledPatternFor(rule: RobotsPathRule): CompiledRobotsPattern {
  const cached = compiledPatternCache.get(rule);
  if (cached) return cached;
  const compiled = compilePatternSegments(rule.pattern);
  compiledPatternCache.set(rule, compiled);
  return compiled;
}

/**
 * Matches a precompiled pattern against `target` (`pathname + search`).
 * Greedy left-to-right, no backtracking — see the section doc comment above.
 */
function matchesCompiledPattern(compiled: CompiledRobotsPattern, target: string): boolean {
  const { anchored, segments } = compiled;
  const first = segments[0] ?? "";
  if (!target.startsWith(first)) return false;
  const pos = first.length;

  const lastIndex = segments.length - 1;
  if (lastIndex === 0) {
    // No wildcard at all: already a prefix match; anchored additionally
    // requires the pattern to consume the whole target.
    return anchored ? target.length === first.length : true;
  }

  let cursor = pos;
  for (let i = 1; i < lastIndex; i++) {
    const segment = segments[i] ?? "";
    const found = target.indexOf(segment, cursor);
    if (found === -1) return false;
    // Greedy-leftmost is safe here: an earlier match of segment i can only
    // give segment i+1 MORE room to be found later, never less, since the
    // `*` between them absorbs any extra characters. No backtracking needed.
    cursor = found + segment.length;
  }

  const last = segments[lastIndex] ?? "";
  if (anchored) {
    if (last.length > target.length - cursor) return false;
    return target.endsWith(last);
  }
  return last === "" || target.indexOf(last, cursor) !== -1;
}

/**
 * Pure. `url` is an absolute http(s) URL string. Matching uses
 * `pathname + search` of the parsed URL. Returns true when the URL cannot be
 * parsed (caller has already validated it; do not fail closed on a parse bug).
 */
export function isPathAllowedByRobots(rules: RobotsRuleSet, url: string): boolean {
  if (rules.disallowAll) return false;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return true; // M-32: fail open, never closed, on an unparseable URL.
  }

  // Normalized the same way `compilePatternSegments` normalizes the rule
  // pattern (see `normalizePercentEncoding`'s doc comment) — otherwise a
  // percent-encoded alias of a disallowed path (e.g. `/%73ecret/` for a
  // `Disallow: /secret/` rule) would never match because `URL.pathname`
  // preserves %-escapes verbatim.
  const target = normalizePercentEncoding(`${parsed.pathname}${parsed.search}`);
  let best: RobotsPathRule | null = null;
  for (const rule of rules.rules) {
    if (!matchesCompiledPattern(compiledPatternFor(rule), target)) continue;
    const isMoreSpecific = !best || rule.specificity > best.specificity;
    // Tie goes to Allow (least restrictive) — order-independent: this only
    // upgrades a disallow to an allow at equal specificity, never the reverse.
    const isTieBrokenByAllow =
      best !== null && rule.specificity === best.specificity && rule.kind === "allow" && best.kind === "disallow";
    if (isMoreSpecific || isTieBrokenByAllow) best = rule;
  }

  return best ? best.kind === "allow" : true;
}

// ── §4.4 createRobotsPolicy / createAllowAllRobotsPolicy ────────────────────

function outcomeToRuleSet(outcome: RobotsFetchOutcome): RobotsRuleSet {
  switch (outcome.kind) {
    case "body":
      return parseRobotsTxt(outcome.text);
    case "unavailable":
      return ALLOW_ALL_RULES;
    case "unreachable":
      return DISALLOW_ALL_RULES;
  }
}

/**
 * Crawl-scoped. Caches per origin (including in-flight promises) so the
 * `load` callback runs at most once per origin regardless of how many pages
 * or concurrent lookups reference it. Deliberately NOT a module-level cache
 * (see the file-level doc comment) — callers construct one instance per crawl.
 */
export function createRobotsPolicy(load: RobotsTxtLoader): RobotsPolicy {
  const cache = new Map<string, Promise<RobotsRuleSet>>();

  function rulesForOrigin(origin: string): Promise<RobotsRuleSet> {
    const cached = cache.get(origin);
    if (cached) return cached;

    const robotsUrl = new URL("/robots.txt", origin).toString();
    const pending = load(robotsUrl).then(outcomeToRuleSet);
    // A rejected fetch must not poison the cache: the next lookup for this
    // origin should retry the loader rather than replaying the same failure
    // forever (spec §4.4 L-04).
    pending.catch(() => {
      if (cache.get(origin) === pending) cache.delete(origin);
    });
    cache.set(origin, pending);
    return pending;
  }

  return {
    rulesFor: (url) => rulesForOrigin(new URL(url).origin),
    isAllowed: async (url) => isPathAllowedByRobots(await rulesForOrigin(new URL(url).origin), url),
    crawlDelayMs: async (url) => (await rulesForOrigin(new URL(url).origin)).crawlDelayMs ?? 0,
  };
}

/** Never fetches. isAllowed => true, crawlDelayMs => 0. Used when respectRobots is false. */
export function createAllowAllRobotsPolicy(): RobotsPolicy {
  return {
    rulesFor: async () => ALLOW_ALL_RULES,
    isAllowed: async () => true,
    crawlDelayMs: async () => 0,
  };
}
