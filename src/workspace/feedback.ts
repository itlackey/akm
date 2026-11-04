// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** Record feedback on an asset, with an optional typed fix, exactly as `akm feedback` does. */

import { UsageError } from "../core/errors";
import { runCli } from "./cli-child";

const MAX_FIX_PAIRS = 10;

export interface FeedbackInput {
  ref: string;
  signal: "positive" | "negative";
  reason?: string;
  tags?: string[];
  /** Up to ten exact text replacements the asset should receive. */
  fix?: Array<{ replace: string; with: string }>;
  /** Where the fix was verified; only recorded with a fix. */
  source?: string;
}

export async function record(input: FeedbackInput) {
  const ref = typeof input.ref === "string" ? input.ref.trim() : "";
  if (!ref) throw new UsageError("ref is required.");
  if (ref.startsWith("-"))
    throw new UsageError(
      "ref must be a target, not a command option. Use ./ for a relative path beginning with a dash.",
    );
  if (input.signal !== "positive" && input.signal !== "negative")
    throw new UsageError("signal must be positive or negative.");
  const args = ["feedback", ref, `--${input.signal}`];
  if (typeof input.reason === "string" && input.reason.trim()) args.push(`--reason=${input.reason.trim()}`);
  if (input.tags !== undefined) {
    if (!Array.isArray(input.tags) || input.tags.some((tag) => typeof tag !== "string"))
      throw new UsageError("tags must be strings.");
    for (const tag of input.tags) args.push(`--tag=${tag}`);
  }
  // Passed as `--replace=` / `--with=` so a value that starts with a dash is not read as a flag.
  if (input.fix !== undefined) {
    if (!Array.isArray(input.fix) || input.fix.length === 0)
      throw new UsageError("fix must be a list of replace/with pairs.");
    if (input.fix.length > MAX_FIX_PAIRS)
      throw new UsageError(`At most ${MAX_FIX_PAIRS} replace/with pairs are accepted.`);
    for (const pair of input.fix) {
      if (typeof pair?.replace !== "string" || typeof pair?.with !== "string")
        throw new UsageError("Every fix needs a replace and a with string.");
      args.push(`--replace=${pair.replace}`, `--with=${pair.with}`);
    }
    if (typeof input.source === "string" && input.source.trim()) args.push(`--source=${input.source.trim()}`);
  }
  return runCli(args, undefined, true);
}
