// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { BaseLinter } from "./base-linter";
import type { LintContext, LintIssue } from "./types";

/**
 * Linter for `knowledge/` assets.
 *
 * All checks are inherited from BaseLinter (`unquoted-colon`, `missing-updated`,
 * `stale-path`, `missing-ref`). No type-specific rules needed.
 */
export class KnowledgeLinter extends BaseLinter {
  readonly types = ["knowledge"] as const;

  lint(ctx: LintContext): LintIssue[] {
    return this.runBaseChecks(ctx);
  }
}
