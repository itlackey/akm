// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import path from "node:path";
import { UsageError } from "../errors";
import { DEPRECATED_REJECTED_TYPES } from "../recognition-util";

// ── Types ───────────────────────────────────────────────────────────────────

export interface AssetRef {
  /**
   * Open string token (chunk 1.5, D1.5-1/D1.5-6): any non-empty asset type
   * is valid ref data EXCEPT `DEPRECATED_REJECTED_TYPES` — foreign/adapter
   * types round-trip through `parseAssetRef`/`makeAssetRef` unrejected.
   */
  type: string;
  name: string;
  /**
   * Where to find this asset.
   *   - undefined: search all sources (primary → search paths → installed)
   *   - "local": primary stash only
   *   - registry ref: e.g. "npm:@scope/pkg", "owner/repo", "github:owner/repo#v1"
   *   - filesystem path: e.g. "/mnt/shared-stash"
   */
  origin?: string;
}

/** Accepted spelling aliases mapping to a canonical asset type. */
const TYPE_ALIASES: Record<string, string> = {
  environment: "env",
};

// ── Construction ────────────────────────────────────────────────────────────

/**
 * Build a ref string from components.
 *
 * Examples:
 *   makeAssetRef("script", "deploy.sh")
 *     → "script:deploy.sh"
 *   makeAssetRef("script", "deploy.sh", "npm:@scope/pkg")
 *     → "npm:@scope/pkg//script:deploy.sh"
 *   makeAssetRef("skill", "code-review", "local")
 *     → "local//skill:code-review"
 *   makeAssetRef("script", "db/migrate/run.sh", "owner/repo")
 *     → "owner/repo//script:db/migrate/run.sh"
 */
export function makeAssetRef(type: string, name: string, origin?: string): string {
  validateName(name);
  const normalized = normalizeName(name);
  const asset = `${type}:${normalized}`;
  if (!origin) return asset;
  return `${origin}//${asset}`;
}

/**
 * Serialize a parsed {@link AssetRef} value-object back to its canonical
 * `[origin//]type:name` string form. The single formatter for refs — call
 * this instead of hand-building `${type}:${name}` template strings so the
 * serialization rules (origin prefix, name normalization) live in one place
 * and stay in lockstep with {@link parseAssetRef}.
 *
 * `refToString(parseAssetRef(s))` round-trips for any `s` that
 * `parseAssetRef` accepts.
 */
export function refToString(ref: AssetRef): string {
  return makeAssetRef(ref.type, ref.name, ref.origin);
}

// ── Parsing ─────────────────────────────────────────────────────────────────

/**
 * Parse a ref string in the format `[origin//]type:name`.
 */
export function parseAssetRef(ref: string): AssetRef {
  const trimmed = ref.trim();
  if (!trimmed) throw new UsageError("Empty ref.", "MISSING_REQUIRED_ARGUMENT");

  let origin: string | undefined;
  let body = trimmed;

  const boundary = trimmed.indexOf("//");
  if (boundary >= 0) {
    origin = trimmed.slice(0, boundary);
    body = trimmed.slice(boundary + 2);
    if (!origin) throw new UsageError("Empty origin in ref.", "MISSING_REQUIRED_ARGUMENT");
  }

  const colon = body.indexOf(":");
  if (colon <= 0) {
    throw new UsageError(
      `Invalid ref "${trimmed}". Expected [origin//]type:name, e.g. skill:deploy or knowledge:guide.md`,
      "MISSING_REQUIRED_ARGUMENT",
    );
  }

  const rawType = body.slice(0, colon);
  const rawName = body.slice(colon + 1);

  // The `vault` asset type was removed in 0.9.0. Point callers at its
  // replacements rather than failing with a generic unknown-type error.
  if (rawType === "vault") {
    throw new UsageError(
      "The `vault` asset type was removed in 0.9.0 — use `env:` (whole .env config) or `secret:` (a single value).",
      "MISSING_REQUIRED_ARGUMENT",
    );
  }

  // Type aliases: `environment:` is an accepted spelling of the canonical
  // `env:` type.
  const resolvedType = TYPE_ALIASES[rawType] ?? rawType;

  // Open type token (chunk 1.5, D1.5-6): any other non-empty type is valid
  // ref data (foreign/adapter types included) EXCEPT the deliberately-removed
  // set — silently re-admitting one of those as an ordinary foreign type
  // would defeat the guard that removed it. `vault` is already caught above
  // with its own migration-hint message; this catches the rest of the
  // deny-list (currently just `tool`).
  if (DEPRECATED_REJECTED_TYPES.has(resolvedType)) {
    throw new UsageError(`Invalid asset type: "${rawType}".`, "MISSING_REQUIRED_ARGUMENT");
  }

  validateName(rawName);
  const name = normalizeName(rawName);

  return { type: resolvedType, name, origin: origin || undefined };
}

// ── Validation ──────────────────────────────────────────────────────────────

function validateName(name: string): void {
  if (!name) throw new UsageError("Empty asset name.", "MISSING_REQUIRED_ARGUMENT");
  if (name.includes("\0")) throw new UsageError("Null byte in asset name.", "MISSING_REQUIRED_ARGUMENT");
  if (/^[A-Za-z]:/.test(name)) throw new UsageError("Windows drive path in asset name.", "MISSING_REQUIRED_ARGUMENT");

  const normalized = path.posix.normalize(name.replace(/\\/g, "/"));
  if (path.posix.isAbsolute(normalized))
    throw new UsageError("Absolute path in asset name.", "MISSING_REQUIRED_ARGUMENT");
  if (normalized === ".." || normalized.startsWith("../")) {
    throw new UsageError("Path traversal in asset name.", "MISSING_REQUIRED_ARGUMENT");
  }
  const segments = normalized.split("/");
  if (segments.some((seg) => seg === "." || seg === "..")) {
    throw new UsageError("Asset name cannot contain relative path segments.", "MISSING_REQUIRED_ARGUMENT");
  }
}

function normalizeName(name: string): string {
  return path.posix.normalize(name.replace(/\\/g, "/"));
}

// ── Bundle-scoped ref grammar (0.9.0, spec §11.1 / §3.4) ─────────────────────
//
// The 0.9.0 identity is `[<bundle>//]<concept-id>[#<fragment>]` (path identity;
// `type` is no longer part of identity). This API is ADDITIVE — it lands
// alongside `parseAssetRef`/`makeAssetRef`/`refToString` (the pre-0.9.0
// `[origin//]type:name` grammar) so both spellings resolve during the Chunk-5
// cutover. The old API is deleted only after every ref site is repointed here.
//
//   - `bundle`   — workspace bundle slug; the OPTIONAL prefix. Short refs
//                  (no `bundle//`) resolve to the containing bundle (§11.1).
//                  Charset excludes `:`/`.`/`#`/`/` and whitespace so a
//                  `bundle//conceptId` token is lexically distinct from a URL
//                  (whose scheme carries a `:` before `//`, §3.4) and so the
//                  first `//` unambiguously bounds the bundle.
//   - `conceptId`— OKF concept id = path within the bundle − ext;
//                  `/`-separated, NFC-normalized, byte-wise case-sensitive
//                  (§11.1). Reuses `validateName`'s traversal/null-byte/
//                  drive-letter guards. `#` is reserved for the fragment.
//   - `fragment` — the export `#fragment` selector (optional).

export interface BundleRef {
  /** Workspace bundle slug; `undefined` = short form (resolves to the containing bundle). */
  bundle?: string;
  /** OKF concept id = path within bundle − ext; `/`-separated, NFC, byte-wise case-sensitive. */
  conceptId: string;
  /** Export `#fragment` selector (optional). */
  fragment?: string;
}

/**
 * Bundle slug charset (spec §3.4): non-empty, and excluding `:`/`.`/`#`/`/`
 * plus whitespace. Excluding `:`/`.` is what keeps `bundle//conceptId` lexically
 * distinguishable from a URL in prose; excluding `/` is what makes the first
 * `//` an unambiguous bundle boundary; excluding `#` reserves it for fragments.
 */
const BUNDLE_SLUG_RE = /^[^\s:.#/]+$/;

/**
 * Body-ref recognition (prose): the FULLY-QUALIFIED anchored form ONLY
 * (`<bundle>//<concept-id>[#<fragment>]`, spec §11.1 — the short form is never
 * recognized in prose). `g`/`m` for scanning; group 1 = the whole ref token.
 *
 * The leading `//` must be preceded by a bundle slug, so a URL (`https://…`,
 * `//cdn.example.com/…`) never matches: a scheme carries a `:` before `//`
 * (excluded from the slug), and a scheme-relative `//host` has no slug before
 * its `//` at all. The bundle-slug charset here additionally excludes the prose
 * boundary punctuation (brackets/parens/quotes/backtick/comma/angle) so a
 * leading boundary char (e.g. the `[` of a markdown link) is not absorbed into
 * the slug. The concept segment reuses the same terminator charset as the
 * legacy body-ref scan (whitespace/quotes/brackets/comma/nl), and admits `/`,
 * `.`, and a trailing `#fragment`.
 */
export const BUNDLE_REF_RE = /(?:^|[\s`"'(,[])([^\s:.#/`"'()[\],<>]+\/\/[^\s"'`)\]>,\n]+)/gm;

/** NFC-normalize + traversal/null-byte/drive-letter guard + path-normalize a concept id. */
function normalizeConceptId(raw: string): string {
  const nfc = raw.normalize("NFC");
  if (nfc.includes("#")) {
    throw new UsageError("`#` is reserved for the export fragment in a concept id.", "MISSING_REQUIRED_ARGUMENT");
  }
  validateName(nfc);
  return normalizeName(nfc);
}

/**
 * Build a fully-qualified (or short) bundle ref string from its components.
 *
 * Examples:
 *   makeBundleRef(undefined, "knowledge/http-caching")   → "knowledge/http-caching"
 *   makeBundleRef("core", "knowledge/http-caching")      → "core//knowledge/http-caching"
 *   makeBundleRef("core", "skills/review", "usage")      → "core//skills/review#usage"
 */
export function makeBundleRef(bundle: string | undefined, conceptId: string, fragment?: string): string {
  const normalized = normalizeConceptId(conceptId);
  let out = normalized;
  if (bundle) {
    if (!BUNDLE_SLUG_RE.test(bundle)) {
      throw new UsageError(
        `Invalid bundle slug "${bundle}". A bundle slug may not contain ':', '.', '#', '/', or whitespace.`,
        "MISSING_REQUIRED_ARGUMENT",
      );
    }
    out = `${bundle}//${normalized}`;
  }
  if (fragment) out = `${out}#${fragment}`;
  return out;
}

/**
 * Serialize a parsed {@link BundleRef} back to its canonical
 * `[bundle//]conceptId[#fragment]` string form — the single formatter for the
 * 0.9.0 grammar (call this instead of hand-building `${bundle}//${conceptId}`).
 * `bundleRefToString(parseBundleRef(s))` round-trips for any `s` that
 * `parseBundleRef` accepts.
 */
export function bundleRefToString(ref: BundleRef): string {
  return makeBundleRef(ref.bundle, ref.conceptId, ref.fragment);
}

/**
 * Parse a ref string in the 0.9.0 format `[<bundle>//]<concept-id>[#<fragment>]`.
 * The bundle prefix and the export fragment are both optional; the short form
 * (no `bundle//`) leaves `bundle` undefined for the caller to resolve against
 * the containing bundle (§11.1).
 */
export function parseBundleRef(ref: string): BundleRef {
  const trimmed = ref.trim();
  if (!trimmed) throw new UsageError("Empty ref.", "MISSING_REQUIRED_ARGUMENT");

  let bundle: string | undefined;
  let body = trimmed;

  const boundary = trimmed.indexOf("//");
  if (boundary >= 0) {
    bundle = trimmed.slice(0, boundary);
    body = trimmed.slice(boundary + 2);
    if (!bundle) throw new UsageError("Empty bundle in ref.", "MISSING_REQUIRED_ARGUMENT");
    if (!BUNDLE_SLUG_RE.test(bundle)) {
      throw new UsageError(
        `Invalid bundle slug "${bundle}" in ref "${trimmed}". A bundle slug may not contain ':', '.', '#', '/', or whitespace.`,
        "MISSING_REQUIRED_ARGUMENT",
      );
    }
  }

  // Export fragment: everything after the first `#` in the concept body.
  let fragment: string | undefined;
  const hash = body.indexOf("#");
  if (hash >= 0) {
    fragment = body.slice(hash + 1) || undefined;
    body = body.slice(0, hash);
  }

  if (!body) {
    throw new UsageError(
      `Invalid ref "${trimmed}". Expected [bundle//]conceptId, e.g. knowledge/guide or core//skills/review`,
      "MISSING_REQUIRED_ARGUMENT",
    );
  }

  const conceptId = normalizeConceptId(body);
  return { bundle: bundle || undefined, conceptId, fragment };
}
