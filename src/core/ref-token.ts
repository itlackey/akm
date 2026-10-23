// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The one substitution token akm hands to a process or a provider: `${ref}`,
 * where `ref` is an akm ref (`[bundle//]conceptId`). A `secrets/…` ref stands
 * for the secret's value; any other asset ref stands for the asset's absolute
 * path. A `${…}` body that is not an akm ref (`${HOME}`, `${PATH//:/ }`,
 * `${v//-/_}`, `${x/a/b}`: not led by a native type and not qualified by an
 * installed bundle) is plain text and is left alone.
 *
 * Kept free of the commands layer so config credentials and env values share
 * this one function.
 */

import { parseBundleRef } from "./asset/asset-ref";
import { typeNameFromConceptId } from "./asset/resolve-ref";

export const REF_TOKEN_RE = /\$\{([^}\s]+)\}/g;

/**
 * Does a `${…}` body parse as an akm ref (no export fragment) that either
 * leads with a native asset type (bundle-qualified or not) or is bundle-qualified
 * with a bundle `isBundleInstalled` accepts? Anything else stays text, so shell
 * syntax (`${v//-/_}`, `${x/a/b}`) is never read as a ref. A qualified opaque body
 * follows the core ref grammar and the owner walk, whatever adapter owns it, but
 * only for an installed bundle; with no predicate no bundle is installed.
 */
function isRefBody(body: string, isBundleInstalled?: (bundle: string) => boolean): boolean {
  try {
    const ref = parseBundleRef(body);
    if (ref.fragment !== undefined) return false;
    if (typeNameFromConceptId(ref.conceptId) !== undefined) return true;
    return ref.bundle !== undefined && isBundleInstalled?.(ref.bundle) === true;
  } catch {
    return false;
  }
}

/** Is the whole string exactly one `${ref}` token? */
export function isRefToken(value: string): boolean {
  const body = /^\$\{([^}\s]+)\}$/.exec(value)?.[1];
  return body !== undefined && isRefBody(body);
}

/** Is the whole string exactly one `${ref}` token whose ref names a `secrets/` asset? */
export function isSecretRefToken(value: string): boolean {
  const body = /^\$\{([^}\s]+)\}$/.exec(value)?.[1];
  return (
    body !== undefined && isRefBody(body) && typeNameFromConceptId(parseBundleRef(body).conceptId)?.type === "secret"
  );
}

export interface RefTokenResolution {
  values: Record<string, string>;
  /** Refs no bundle owns, de-duplicated in first-seen order. Callers treat a non-empty list as a hard error and inject nothing. */
  missing: string[];
  /** Every substituted secret value, for redaction. */
  secretValues: string[];
}

/**
 * Replace every `${ref}` token in each value. Keys are never touched, and
 * tokens embedded in larger strings are all substituted. `isBundleInstalled`
 * lets a bundle-qualified body that is not led by a native type be a ref when
 * its bundle is installed. An unresolved ref is
 * collected in `missing` and its token left in place. Resolved secret values
 * must never be logged or printed by callers.
 */
export function substituteRefTokens(
  values: Record<string, string>,
  resolve: (ref: string) => { kind: "secret"; value: string } | { kind: "path"; path: string } | undefined,
  isBundleInstalled?: (bundle: string) => boolean,
): RefTokenResolution {
  const missing: string[] = [];
  const secretValues = new Set<string>();
  const cache = new Map<string, ReturnType<typeof resolve>>();
  const out: Record<string, string> = {};

  for (const [key, value] of Object.entries(values)) {
    out[key] = value.replace(REF_TOKEN_RE, (token, body: string) => {
      if (!isRefBody(body, isBundleInstalled)) return token;
      if (!cache.has(body)) cache.set(body, resolve(body));
      const resolved = cache.get(body);
      if (resolved === undefined) {
        if (!missing.includes(body)) missing.push(body);
        return token;
      }
      if (resolved.kind === "path") return resolved.path;
      if (resolved.value) secretValues.add(resolved.value);
      return resolved.value;
    });
  }

  return { values: out, missing, secretValues: [...secretValues] };
}
