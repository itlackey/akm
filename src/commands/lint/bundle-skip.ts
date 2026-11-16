// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { bundleKeyForContentRoot } from "../../core/config/config-sources";
import type { AkmConfig } from "../../core/config/config-types";
import { warnOnce } from "../../core/warn";
import { includeEntryToRegExp } from "../../sources/include";
import { LINT_RULES } from "./types";

/**
 * The bundle's `lint.skip` map as a lookup from a bundle-relative path to the
 * rules skipped for it. A rule name lint does not know is warned about once
 * and ignored.
 */
export function bundleLintSkip(config: AkmConfig, bundleRoot: string): (relPath: string) => string[] {
  const skip = config.bundles?.[bundleKeyForContentRoot(config, bundleRoot) ?? ""]?.lint?.skip ?? {};
  const rules: Array<[string, RegExp[]]> = [];
  for (const [rule, globs] of Object.entries(skip)) {
    if (!(LINT_RULES as readonly string[]).includes(rule)) {
      warnOnce(
        `lint-skip-rule:${rule}`,
        `[lint] bundle lint.skip names "${rule}", which is not a lint rule; ignoring it.`,
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
