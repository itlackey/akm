// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import path from "node:path";
import { type AkmAssetType, isAssetType } from "../common";
import { UsageError } from "../errors";

// ── Types ───────────────────────────────────────────────────────────────────

export interface AssetRef {
  type: AkmAssetType;
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
const TYPE_ALIASES: Record<string, AkmAssetType> = {
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
export function makeAssetRef(type: AkmAssetType, name: string, origin?: string): string {
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

  if (!isAssetType(resolvedType)) {
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
