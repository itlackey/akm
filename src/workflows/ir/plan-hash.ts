// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Plan hashing: sha256 of the plan's canonical JSON (keys recursively sorted),
 * stored beside `plan_json` as information — a stored plan is never gated on it.
 */

import { createHash } from "node:crypto";

/** sha256 hex of the canonical (recursively sorted-keys) JSON of the plan. */
export function computePlanHash(plan: unknown): string {
  return createHash("sha256").update(canonicalPlanJson(plan)).digest("hex");
}

/** The canonical JSON string the hash is computed over (also what to persist). */
export function canonicalPlanJson(plan: unknown): string {
  return canonicalJson(plan);
}

/** Canonical JSON used by every plan and input hash. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("JSON values must be finite");
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => sortKeys(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, sortKeys(v)]),
    );
  }
  throw new TypeError("JSON value contains a non-JSON value");
}
