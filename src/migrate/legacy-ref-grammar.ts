// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * MIGRATE HOME for the pre-0.9.0 `[origin//]type:name` ref grammar and the
 * dual-grammar bridge that keeps STORED durable refs (state.db usage events,
 * proposals, salience rows, workflow runs, index `entry_ref` rows) parseable
 * while they still carry the legacy spelling.
 *
 * Everything here retires with the Chunk-8 §11.4 one-time state.db re-key: once
 * every durable row is re-keyed to `bundle//conceptId`, the legacy grammar and
 * this whole module are deleted. Chunk-8's content-migration + §11.4 re-key
 * passes consume these functions directly.
 *
 * ── Cycle-safety (HARD constraint) ──
 *
 * Self-contained leaf: imports only sibling core leaves (`asset-ref`,
 * `asset-placement`), the `recognition-util` sink, and the `core/errors` sink.
 * It NEVER imports `resolve-ref` (the input-boundary layer), so it cannot join
 * an import cycle. The permanent D-R2 reverse table lives in `resolve-ref.ts`
 * (`typeNameFromConceptId`); this module carries its own private transient copy
 * ({@link conceptIdToLegacyParts}) for stored-ref parsing so it stays a leaf.
 */

import path from "node:path";
import { stashDirFor, typeForStashDir } from "../core/asset/asset-placement";
import { type BundleRef, isBundleSlug, parseBundleRef } from "../core/asset/asset-ref";
import { NotFoundError, UsageError } from "../core/errors";
import { DEPRECATED_REJECTED_TYPES } from "../core/recognition-util";

// ── Legacy `[origin//]type:name` value object ────────────────────────────────

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

// ── Construction ─────────────────────────────────────────────────────────────

/**
 * Build a legacy ref string from components.
 *
 * Examples:
 *   makeAssetRef("script", "deploy.sh")                 → "script:deploy.sh"
 *   makeAssetRef("script", "deploy.sh", "npm:@scope/pkg")→ "npm:@scope/pkg//script:deploy.sh"
 *   makeAssetRef("skill", "code-review", "local")        → "local//skill:code-review"
 */
export function makeAssetRef(type: string, name: string, origin?: string): string {
  validateName(name);
  const normalized = normalizeName(name);
  const asset = `${type}:${normalized}`;
  if (!origin) return asset;
  return `${origin}//${asset}`;
}

/**
 * Serialize a parsed {@link AssetRef} back to its canonical `[origin//]type:name`
 * string form. `refToString(parseAssetRef(s))` round-trips for any `s` that
 * `parseAssetRef` accepts.
 */
export function refToString(ref: AssetRef): string {
  return makeAssetRef(ref.type, ref.name, ref.origin);
}

// ── Parsing ──────────────────────────────────────────────────────────────────

function parseLegacyAssetRef(ref: string, allowRetiredTypes: boolean): AssetRef {
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
  if (!allowRetiredTypes && rawType === "vault") {
    throw new UsageError(
      "The `vault` asset type was removed in 0.9.0 — use `env:` (whole .env config) or `secret:` (a single value).",
      "MISSING_REQUIRED_ARGUMENT",
    );
  }

  // Type aliases: `environment:` is an accepted spelling of the canonical `env:` type.
  const resolvedType = TYPE_ALIASES[rawType] ?? rawType;

  // Open type token (chunk 1.5, D1.5-6): any other non-empty type is valid ref
  // data (foreign/adapter types included) EXCEPT the deliberately-removed set.
  if (!allowRetiredTypes && DEPRECATED_REJECTED_TYPES.has(resolvedType)) {
    throw new UsageError(`Invalid asset type: "${rawType}".`, "MISSING_REQUIRED_ARGUMENT");
  }

  validateName(rawName);
  const name = normalizeName(rawName);

  return { type: resolvedType, name, origin: origin || undefined };
}

/** Parse a legacy ref string in the format `[origin//]type:name`. */
export function parseAssetRef(ref: string): AssetRef {
  return parseLegacyAssetRef(ref, false);
}

// ── Validation (private copies — kept self-contained) ────────────────────────

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

// ── Dual-grammar classification / translation (D-R2 / D-R5) ──────────────────

/** Which ref grammar a raw input string is written in. */
export type RefGrammar = "bundle" | "legacy";

/**
 * Classify a raw ref string as the new `[bundle//]conceptId` grammar or the
 * pre-0.9.0 `[origin//]type:name` grammar (D-R5 charset dispatch).
 *
 * NEW grammar iff EITHER:
 *   - it has a `prefix//tail` split whose `prefix` is a LEGAL bundle slug (no
 *     `/ : . #` or whitespace) AND `tail` carries no `type:`-style colon; OR
 *   - it is a bare conceptId (no `//`, no `:`).
 *
 * LEGACY otherwise: `owner/repo//skill:x` / `npm:@scope/pkg//skill:x` have
 * ILLEGAL bundle-slug prefixes, and `local//skill:x` has a legal prefix but a
 * colon in the tail — all three land as legacy.
 */
export function classifyRefGrammar(raw: string): RefGrammar {
  const trimmed = raw.trim();
  const boundary = trimmed.indexOf("//");
  if (boundary >= 0) {
    const prefix = trimmed.slice(0, boundary);
    const tail = trimmed.slice(boundary + 2);
    return isBundleSlug(prefix) && !tail.includes(":") ? "bundle" : "legacy";
  }
  return trimmed.includes(":") ? "legacy" : "bundle";
}

/**
 * D-R2 static-table translation of a legacy `type`/`name` pair to its qualified
 * conceptId `<stash-subdir>/<name>` (bare-name fallback for a foreign type with
 * no placement stash-subdir). Mirrors the indexer's conceptId derivation.
 */
export function legacyConceptId(type: string, name: string): string {
  const stashDir = stashDirFor(type);
  return stashDir !== undefined ? `${stashDir}/${name}` : name;
}

/** The legacy `type`/`name` a qualified conceptId maps back to, or `undefined`. */
export interface LegacyRefParts {
  type: string;
  name: string;
}

/**
 * Reverse of {@link legacyConceptId}: split a qualified conceptId
 * (`<stash-subdir>/<name>`) back to its legacy `type`/`name`, or `undefined`
 * when the leading segment is not a known stash subdir. Transient private copy
 * of the permanent `typeNameFromConceptId` (resolve-ref.ts) so this leaf stays
 * self-contained; retires with the state.db re-key.
 */
function conceptIdToLegacyParts(conceptId: string): LegacyRefParts | undefined {
  const slash = conceptId.indexOf("/");
  if (slash <= 0) return undefined;
  const type = typeForStashDir(conceptId.slice(0, slash));
  if (type === undefined) return undefined;
  return { type, name: conceptId.slice(slash + 1) };
}

/**
 * Translate a raw legacy `[origin//]type:name` ref to its {@link BundleRef}
 * spelling: conceptId via {@link legacyConceptId}, and `bundle` from the origin
 * when the origin is a legal bundle slug (a `registryId`, D-R5 rule 2). A
 * `local`/`stash`/path origin is not a stored bundle id, so it stays short.
 */
export function legacyRefToBundleRef(raw: string): BundleRef {
  const parsed = parseAssetRef(raw);
  const conceptId = legacyConceptId(parsed.type, parsed.name);
  const bundle =
    parsed.origin !== undefined && parsed.origin !== "local" && parsed.origin !== "stash" && isBundleSlug(parsed.origin)
      ? parsed.origin
      : undefined;
  return { bundle, conceptId };
}

// ── Stored-ref dual parser (Chunk-8: retire with the state.db one-time re-key) ─

/**
 * Parse a STORED durable ref that may be written in EITHER the new
 * `[bundle//]conceptId` grammar OR the pre-0.9.0 `[origin//]type:name` grammar,
 * returning today's {@link AssetRef} value-object shape.
 *
 * Stored state (usage events, proposals, salience rows, workflow runs, index
 * `entry_ref` rows) keeps its legacy spelling until the Chunk-8 §11.4 one-time
 * re-key, so every reader that parses a durable ref must accept BOTH grammars —
 * this is the safe superset of `parseRefInput` (input boundaries are new-only).
 *
 * Mapping mirrors the pre-flip input bridge exactly:
 *   - legacy input      → historical syntax parser (including retired types).
 *   - new `conceptId`   → `type`/`name` via the D-R2 reverse table.
 *   - new `bundle`      → `origin`.
 *   - `#fragment`       → rejected (no stored ref carries one).
 */
export function parseStoredRef(raw: string): AssetRef {
  if (classifyRefGrammar(raw) === "legacy") {
    // Durable state may predate the removal of a type. Retired but structurally
    // valid refs are expected orphans; current user input remains strict.
    return parseLegacyAssetRef(raw, true);
  }
  const ref = parseBundleRef(raw);
  if (ref.fragment !== undefined) {
    throw new UsageError(
      `Export fragment "#${ref.fragment}" is not accepted here — drop it from "${raw.trim()}".`,
      "INVALID_FLAG_VALUE",
    );
  }
  const legacy = conceptIdToLegacyParts(ref.conceptId);
  if (legacy === undefined) {
    throw new NotFoundError(
      `Unrecognized asset ref "${raw.trim()}": conceptId "${ref.conceptId}" has no known asset-type prefix.`,
      "ASSET_NOT_FOUND",
    );
  }
  return { type: legacy.type, name: legacy.name, origin: ref.bundle };
}
