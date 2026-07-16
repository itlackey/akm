// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * God-function size gate for `src/commands/improve/**` (R31, chunk-7 DoD 5).
 *
 * A TS-AST scan flags every function-like node (declarations, expressions,
 * arrows, methods, accessors, constructors — including nested anonymous ones)
 * whose inclusive line span exceeds {@link IMPROVE_FN_SIZE_BAR}.
 *
 * WI-7.8 emptied the original shrink-only decomposition baseline — all 13
 * god-functions measured at the chunk-7 HEAD are decomposed — so the gate is
 * now ABSOLUTE: the paired meta-test
 * (`tests/architecture/improve-fn-size-ratchet.test.ts`) asserts the offender
 * list is EMPTY, with no allowlist to consult. A new function over the bar
 * fails immediately; decompose it into named passes instead of growing it.
 *
 * The measurement core is shared with the repo-wide shrink-tolerant ratchet
 * (`scripts/lint-src-fn-size.ts`) via `scripts/fn-size-core.ts`; this gate
 * keeps its own absolute semantics.
 *
 * Pattern: `scripts/lint-tests-isolation.ts` (AST lint gate) +
 * `tests/integration/architecture/agent-runner-seam.test.ts` (TS-AST scan).
 */

import path from "node:path";
import { type FnOffender, measureFnOffenders, REPO_ROOT } from "./fn-size-core";

/** Inclusive-line-span ceiling. "~200 LOC" (plan DoD 5) with tolerance. */
export const IMPROVE_FN_SIZE_BAR = 220;

const IMPROVE_ROOT = path.join(REPO_ROOT, "src", "commands", "improve");

/** One over-bar function-like node: a stable id and its inclusive line span. */
export type ImproveFnOffender = FnOffender;

/**
 * Scan `src/commands/improve/**` and return every function-like node over the
 * bar, sorted by descending size then id (deterministic, worklist-friendly).
 */
export function measureImproveFnOffenders(): ImproveFnOffender[] {
  return measureFnOffenders(IMPROVE_ROOT, IMPROVE_FN_SIZE_BAR);
}
