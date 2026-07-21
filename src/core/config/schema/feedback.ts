// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Feedback taxonomy + `feedback` config section. Extracted verbatim from the
 * former `config-schema.ts` monolith — no behavior change.
 */
import { z } from "zod";
import { nonEmptyString } from "./primitives";

// ── Feedback failure modes (F-3 / #384) ─────────────────────────────────────

/**
 * Curated taxonomy of failure modes for negative feedback.
 *
 * Structured failure modes enable aggregation across feedback events so the
 * distill pipeline can detect that "5 assets failed for the same reason" and
 * act on it — free-text strings about the same issue are not aggregatable.
 */
export const FEEDBACK_FAILURE_MODES = [
  "incorrect", // Factually wrong or logically flawed content
  "outdated", // Correct at some point but now stale
  "dangerous", // Could cause harm if followed (security, safety)
  "incomplete", // Missing key steps, context, or caveats
  "redundant", // Duplicates another asset without adding value
] as const;

/** Union of the curated failure-mode values. */
export type FeedbackFailureMode = (typeof FEEDBACK_FAILURE_MODES)[number];

// ── Feedback ────────────────────────────────────────────────────────────────

export const FeedbackConfigSchema = z
  .object({
    requireReason: z.boolean().optional(),
    allowedFailureModes: z.array(nonEmptyString).optional(),
  })
  .passthrough();
