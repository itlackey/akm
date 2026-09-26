// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The target-ref classifier (P1a Lane B, docs/plans/specs/p1a-with-rejection-classifier.md §4.1).
 *
 * `classifyTargetRef` is the canonical classifier for a canonical asset ref
 * used as an execution target: `commands/<name>`, `scripts/<name>`,
 * `tasks/<name>`, or `workflows/<name>`, each optionally bundle-qualified
 * (`<bundle>//commands/<name>`). It reuses the repo's one ref parser
 * (`parseBundleRef` / `bundleRefToString`, src/core/asset/asset-ref.ts) and
 * accepts a value only when all of the following hold:
 *
 *   1. `parseBundleRef(value)` does not throw;
 *   2. the parsed ref carries no `#fragment`;
 *   3. `bundleRefToString(parsed) === value` — the value round-trips, which
 *      rejects non-canonical spellings (`akm:commands/review`,
 *      `bad.bundle//commands/review`) even when they happen to parse;
 *   4. the concept id contains a `/`, and the family segment before the
 *      first `/` is one of `commands`, `scripts`, `tasks`, `workflows`;
 *   5. the name segment after the first `/` is non-empty.
 *
 * Explicit non-goals (binding, spec §4.1): no GitHub locator grammar, no
 * `akm/command` builtin special case, no resolution, no filesystem access, no
 * guessing. Callers layer builtin detection on top (see
 * `classifyWorkflowStepUses` in src/workflows/source-semantics.ts).
 */

import { bundleRefToString, parseBundleRef } from "../core/asset/asset-ref";
import { UsageError } from "../core/errors";

export type TargetRefKind = "command" | "script" | "task" | "workflow";

export interface ClassifiedTargetRef {
  readonly kind: TargetRefKind;
  readonly ref: string;
}

const FAMILY_KIND: Readonly<Record<string, TargetRefKind>> = {
  commands: "command",
  scripts: "script",
  tasks: "task",
  workflows: "workflow",
};

function targetRefInvalid(value: string): UsageError {
  return new UsageError(
    `Target ref ${JSON.stringify(value)} must be a canonical commands/, scripts/, tasks/, or workflows/ asset ref.`,
    "TARGET_REF_INVALID",
  );
}

/** Classify one exact canonical asset ref as an execution target. Never resolves or guesses. */
export function classifyTargetRef(value: string): ClassifiedTargetRef {
  let parsed: ReturnType<typeof parseBundleRef>;
  try {
    parsed = parseBundleRef(value);
  } catch {
    throw targetRefInvalid(value);
  }
  if (parsed.fragment !== undefined) throw targetRefInvalid(value);
  if (bundleRefToString(parsed) !== value) throw targetRefInvalid(value);

  const slash = parsed.conceptId.indexOf("/");
  if (slash < 0) throw targetRefInvalid(value);
  const family = parsed.conceptId.slice(0, slash);
  const name = parsed.conceptId.slice(slash + 1);
  if (name.length === 0) throw targetRefInvalid(value);

  const kind = FAMILY_KIND[family];
  if (kind === undefined) throw targetRefInvalid(value);

  return Object.freeze({ kind, ref: value });
}
