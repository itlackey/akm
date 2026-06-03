// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Built-in deterministic triage policy presets (Proposal-Queue Triage, §3.1).
 *
 * These are the *only* "rule schema" we ship. Custom needs are served by the
 * single `--policy <path>` escape hatch, which zod-validates an external policy
 * file — not by a config-embedded rule engine (see §9, rejected alternatives).
 *
 * | preset           | accepts                                                   | rejects     | leaves pending                                     |
 * |------------------|-----------------------------------------------------------|-------------|----------------------------------------------------|
 * | `personal-stash` | extract (real content); reflect ≤80 lines; consolidate    | empty diffs | consolidate mid-band, distill dups, contradictions |
 * | `conservative`   | small extract + consolidate only                          | empty diffs | everything else                                    |
 * | `manual`         | nothing                                                   | empty diffs | everything else                                    |
 */

import fs from "node:fs";
import { z } from "zod";
import { UsageError } from "../core/errors";
import { PROPOSAL_SOURCES } from "../core/proposals";
import type { DrainPolicy } from "./proposal-drain";

// Valid `generator` values for a drain rule are exactly the canonical proposal
// `source` values (see {@link PROPOSAL_SOURCES} in src/core/proposals.ts). The
// engine matches rules via `policy.accept.find(r => r.generator === proposal.source)`,
// so a generator that is not a real source can never match — it would be a
// silent permanent no-op. Validate against the closed set to surface typos.
const GeneratorSchema = z.enum(PROPOSAL_SOURCES as unknown as [string, ...string[]], {
  errorMap: () => ({
    message: `must be one of the known proposal sources: ${PROPOSAL_SOURCES.join(", ")}`,
  }),
});

// ---------------------------------------------------------------------------
// Built-in presets
// ---------------------------------------------------------------------------

/**
 * `personal-stash` encodes the deterministic core of today's hand-rolled
 * rubric (the editable `contradicted` memory). It is shipped as a preset, never
 * hardcoded policy: edit a copy via `--policy <path>` to tune it.
 */
export const PERSONAL_STASH: DrainPolicy = {
  name: "personal-stash",
  accept: [
    // Extract proposals carry freshly-pulled real content — accept when present.
    { generator: "extract", minContentLines: 1 },
    // Reflect refinements: accept small ones; larger refinements defer to review.
    { generator: "reflect", maxDiffLines: 80 },
    // Consolidate within the diff band; mid-band lands in `defer` below.
    { generator: "consolidate", maxDiffLines: 200 },
  ],
  rejectEmpty: true,
  // Mid-band consolidate, distill duplicates, and contradiction escalations are
  // the irreducibly-semantic tail — deferred to the (Phase 3) judgment tier.
  defer: ["consolidate", "distill"],
};

/** `conservative` accepts only small, low-risk extract + consolidate proposals. */
export const CONSERVATIVE: DrainPolicy = {
  name: "conservative",
  accept: [
    { generator: "extract", maxDiffLines: 80, minContentLines: 1 },
    { generator: "consolidate", maxDiffLines: 80 },
  ],
  rejectEmpty: true,
  defer: [],
};

/** `manual` accepts nothing; it only clears empty diffs. */
export const MANUAL: DrainPolicy = {
  name: "manual",
  accept: [],
  rejectEmpty: true,
  defer: [],
};

const BUILTIN_POLICIES: Record<string, DrainPolicy> = {
  "personal-stash": PERSONAL_STASH,
  conservative: CONSERVATIVE,
  manual: MANUAL,
};

/** Names of the built-in presets, for help text and validation messages. */
export const BUILTIN_POLICY_NAMES = Object.keys(BUILTIN_POLICIES);

// ---------------------------------------------------------------------------
// Custom policy file schema (`--policy <path>`)
// ---------------------------------------------------------------------------

const DrainAcceptRuleSchema = z
  .object({
    generator: GeneratorSchema,
    maxDiffLines: z.number().int().positive().optional(),
    minContentLines: z.number().int().nonnegative().optional(),
  })
  .strict();

const DrainPolicySchema = z
  .object({
    name: z.string().min(1),
    accept: z.array(DrainAcceptRuleSchema),
    rejectEmpty: z.boolean(),
    defer: z.array(GeneratorSchema),
  })
  .strict();

/**
 * Resolve a `--policy <preset|path>` argument into a {@link DrainPolicy}.
 *
 *   - A bare preset name (`personal-stash` / `conservative` / `manual`) returns
 *     the matching built-in.
 *   - Anything else is treated as a filesystem path to a JSON policy file, which
 *     is read and zod-validated.
 *
 * Throws a {@link UsageError} on an unknown preset, a missing file, or a file
 * that fails schema validation.
 */
export function resolveDrainPolicy(arg: string | undefined): DrainPolicy {
  const value = (arg ?? "personal-stash").trim();
  const builtin = BUILTIN_POLICIES[value];
  if (builtin) return builtin;

  // Treat as a path to a custom policy file.
  if (!fs.existsSync(value)) {
    throw new UsageError(
      `Unknown policy "${value}". Use a built-in preset (${BUILTIN_POLICY_NAMES.join(", ")}) or a path to a policy file.`,
      "INVALID_FLAG_VALUE",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(value, "utf8"));
  } catch (err) {
    throw new UsageError(
      `Could not parse policy file "${value}": ${err instanceof Error ? err.message : String(err)}`,
      "INVALID_FLAG_VALUE",
    );
  }
  const validated = DrainPolicySchema.safeParse(parsed);
  if (!validated.success) {
    throw new UsageError(
      `Invalid policy file "${value}": ${validated.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`).join("; ")}`,
      "INVALID_FLAG_VALUE",
    );
  }
  return validated.data;
}
