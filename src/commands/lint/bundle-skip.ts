// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { bundleKeyForContentRoot } from "../../core/config/config-sources";
import type { AkmConfig } from "../../core/config/config-types";
import { warnOnce } from "../../core/warn";
import { includeEntryToRegExp } from "../../sources/include";

/** The rules `lint.skip` can suppress: the ones the per-file checks gate on. */
export const LINT_SKIPPABLE_RULES: readonly string[] = [
  "redacted-content",
  "unquoted-colon",
  "missing-updated",
  "stale-path",
  "missing-ref",
  "orphaned-stub",
];

/**
 * The bundle's `lint.skip` map as a lookup from a bundle-relative asset path
 * to the rules skipped for it. A rule name lint does not know is warned about
 * once and ignored.
 */
export function bundleLintSkip(config: AkmConfig, bundleRoot: string): (relPath: string) => string[] {
  const skip = config.bundles?.[bundleKeyForContentRoot(config, bundleRoot) ?? ""]?.lint?.skip ?? {};
  const rules: Array<[string, RegExp[]]> = [];
  for (const [rule, globs] of Object.entries(skip)) {
    if (!LINT_SKIPPABLE_RULES.includes(rule)) {
      warnOnce(
        `lint-skip-rule:${rule}`,
        `[lint] bundle lint.skip names "${rule}", which is not a skippable rule; ignoring it.`,
      );
      continue;
    }
    rules.push([rule, globs.map(includeEntryToRegExp)]);
  }
  return (relPath) => {
    const normalized = relPath.split("\\").join("/");
    return rules.filter(([, patterns]) => patterns.some((pattern) => pattern.test(normalized))).map(([rule]) => rule);
  };
}
