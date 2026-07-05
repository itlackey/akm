// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Eligibility / safety predicates for consolidate: "may we touch this memory?"
// One reason to change — the policy for what consolidate is allowed to act on.

import fs from "node:fs";
import { parseFrontmatter } from "../../../core/asset/frontmatter";
import { hasHotCaptureMode } from "../../proposal/validators/proposal-quality-validators";

export function isConsolidationEligibleMemoryName(name: string): boolean {
  return !name.endsWith(".derived");
}

/**
 * Returns true when the memory file has `captureMode: hot` in its frontmatter.
 *
 * Hot memories are USER-EXPLICIT (written via `akm remember` on the hot path).
 * The consolidate LLM is forbidden from deleting or auto-merging them — the
 * user wrote them on purpose and only the user can decide to retire them.
 *
 * Reads the file once per check; consolidate runs against ~10 memories per
 * chunk so the IO cost is trivial. Returns false on any read/parse error
 * (fail-safe: an unparseable file is treated as not-hot, but the broader
 * consolidate flow already guards against unparseable memories elsewhere).
 *
 * Defends against four observed defect classes (see
 * `memory:akm-improve-critical-review-2026-05-20`):
 *   - LLM marks a memory contradicted then deletes (dangling contradictedBy)
 *   - LLM merges two unrelated memories sharing a topic keyword
 *   - LLM judges a recent durable design memo as "redundant"
 *   - Cascade deletes (LLM uses ref:X as `contradictedBy` for ref:Y then deletes both)
 */
export function isHotCapturedMemory(filePath: string): boolean {
  try {
    if (!fs.existsSync(filePath)) return false;
    const content = fs.readFileSync(filePath, "utf8");
    const parsed = parseFrontmatter(content);
    return hasHotCaptureMode(parsed.data as Record<string, unknown> | undefined);
  } catch {
    return false;
  }
}

/**
 * Strict guard for the consolidate delete/merge paths.
 *
 * Returns a verdict that distinguishes "hot" (refuse, user-explicit) from
 * "unparseable" (refuse, frontmatter integrity broken — could have hidden a
 * hot flag) from "safe" (proceed). The legacy `isHotCapturedMemory` returns
 * false on read/parse errors, which would let consolidate delete a memory
 * whose frontmatter was corrupted between capture and consolidate runs.
 *
 * Use this for any destructive operation; use `isHotCapturedMemory` only
 * when a missing/unparseable file is genuinely safe to ignore.
 */
export type ConsolidateGuardVerdict = "hot" | "safe" | "unparseable" | "missing";

export function consolidateGuardStatus(filePath: string): ConsolidateGuardVerdict {
  if (!fs.existsSync(filePath)) return "missing";
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch {
    return "unparseable";
  }
  let parsed: ReturnType<typeof parseFrontmatter>;
  try {
    parsed = parseFrontmatter(content);
  } catch {
    return "unparseable";
  }
  const data = parsed.data as Record<string, unknown> | undefined;
  if (!data || Object.keys(data).length === 0) return "unparseable";
  return hasHotCaptureMode(data) ? "hot" : "safe";
}
