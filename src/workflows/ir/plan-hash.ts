// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Plan hashing for the frozen-plan contract.
 *
 * `workflow run` persists `plan_json` + `plan_hash` on the run row. The hash is
 * the sha256 (hex) of the plan's CANONICAL JSON — object keys recursively
 * sorted — so two structurally-equal plans hash identically regardless of key
 * insertion order. It is informational: a stored plan is read back as it is
 * (`runtime/run-plan.ts`), never gated on the hash.
 *
 * Pure module: no IO beyond node:crypto, no engine imports.
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
