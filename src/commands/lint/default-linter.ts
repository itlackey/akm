// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { BaseLinter } from "./base-linter";
import type { LintContext, LintIssue } from "./types";

/**
 * Default linter for asset types that have no type-specific rules beyond the
 * base checks (`unquoted-colon`, `missing-updated`).
 *
 * Covers: `lessons`.
 */
export class DefaultLinter extends BaseLinter {
  readonly types = ["lessons"] as const;

  lint(ctx: LintContext): LintIssue[] {
    return this.runBaseChecks(ctx);
  }
}
