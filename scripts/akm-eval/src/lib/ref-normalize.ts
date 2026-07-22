/**
 * Minimal parser for akm's current `[bundle//]conceptId[#fragment]` grammar.
 * Eval correlation keeps the bundle prefix because it is part of durable
 * identity; no legacy `type:name`, `.md`, or `.derived` rewriting occurs here.
 */

import { bundleRefToString, parseBundleRef } from "../../../../src/core/asset/asset-ref";

export interface ParsedRef {
  bundle?: string;
  conceptId: string;
  fragment?: string;
  /** Trimmed current-grammar spelling, including bundle and fragment. */
  canonical: string;
}

export function parseRef(raw: string): ParsedRef | undefined {
  const canonical = raw.trim();
  if (!canonical) return undefined;
  try {
    const parsed = parseBundleRef(canonical);
    // Eval inputs are canonical, subdir-qualified concept refs. Requiring the
    // first path separator to precede any colon rejects nested spellings of
    // the retired `[origin//]type:name` grammar without rejecting colons in a
    // later concept segment or fragment.
    const firstSeparator = parsed.conceptId.indexOf("/");
    const firstColon = parsed.conceptId.indexOf(":");
    if (
      firstSeparator < 1 ||
      (firstColon >= 0 && firstColon < firstSeparator) ||
      bundleRefToString(parsed) !== canonical
    ) {
      return undefined;
    }
    return {
      ...(parsed.bundle ? { bundle: parsed.bundle } : {}),
      conceptId: parsed.conceptId,
      ...(parsed.fragment ? { fragment: parsed.fragment } : {}),
      canonical,
    };
  } catch {
    return undefined;
  }
}

export function normalizeRef(raw: string): string {
  return parseRef(raw)?.canonical ?? "";
}

export function refVariants(ref: string): string[] {
  const normalized = normalizeRef(ref);
  return normalized ? [normalized] : [];
}
