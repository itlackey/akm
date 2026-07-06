// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Plan hashing for the frozen-plan contract (redesign addendum, R1).
 *
 * `workflow start` persists `plan_json` + `plan_hash` on the run row
 * (migration 006); every later invocation executes that snapshot. The hash is
 * the sha256 (hex) of the plan's CANONICAL JSON — object keys recursively
 * sorted — so two structurally-equal plans hash identically regardless of key
 * insertion order, and the same program always freezes to the same hash.
 *
 * Pure module: no IO beyond node:crypto, no engine imports.
 */

import { createHash } from "node:crypto";
import type { WorkflowPlanGraph } from "./schema";

/** sha256 hex of the canonical (recursively sorted-keys) JSON of the plan. */
export function computePlanHash(plan: WorkflowPlanGraph): string {
  return createHash("sha256").update(canonicalPlanJson(plan)).digest("hex");
}

/** The canonical JSON string the hash is computed over (also what to persist). */
export function canonicalPlanJson(plan: WorkflowPlanGraph): string {
  return JSON.stringify(sortKeys(plan));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, sortKeys(v)]),
    );
  }
  return value;
}
