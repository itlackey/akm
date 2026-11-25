// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import path from "node:path";
import { bundleAtDir } from "../config/config-sources";
import type { AkmConfig } from "../config/config-types";
import { warnOnce } from "../warn";
import { LINT_RULES } from "./types";

/**
 * Translate one `lint.skip` glob to a regular expression matched against a
 * `/`-joined bundle-relative path: `*` (any run of characters within one path
 * segment), `?` (one character) and `**` (any run of characters across
 * segments, including none). Not a full glob implementation (no brace
 * expansion, character classes or negation); those are matched literally.
 */
function globToRegExp(glob: string): RegExp {
  const normalized = glob.split(path.sep).join("/");
  let pattern = "";
  for (let i = 0; i < normalized.length; ) {
    if (normalized.startsWith("**", i)) {
      const consumesSlash = normalized[i + 2] === "/";
      pattern += consumesSlash ? "(?:.*/)?" : ".*";
      i += consumesSlash ? 3 : 2;
      continue;
    }
    const char = normalized[i]!;
    if (char === "*") pattern += "[^/]*";
    else if (char === "?") pattern += "[^/]";
    else pattern += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    i += 1;
  }
  return new RegExp(`^${pattern}$`);
}

/**
 * The bundle's `lint.skip` map as a lookup from a bundle-relative path to the
 * rules skipped for it. A rule name lint does not know is warned about once
 * and ignored.
 */
export function bundleLintSkip(config: AkmConfig, bundleRoot: string): (relPath: string) => string[] {
  const skip = config.bundles?.[bundleAtDir(config, bundleRoot) ?? ""]?.lint?.skip ?? {};
  const rules: Array<[string, RegExp[]]> = [];
  for (const [rule, globs] of Object.entries(skip)) {
    if (!(LINT_RULES as readonly string[]).includes(rule)) {
      warnOnce(
        `lint-skip-rule:${rule}`,
        `[lint] bundle lint.skip names "${rule}", which is not a lint rule; ignoring it.`,
      );
      continue;
    }
    rules.push([rule, globs.map(globToRegExp)]);
  }
  return (relPath) => {
    const normalized = relPath.split("\\").join("/");
    return rules.filter(([, patterns]) => patterns.some((pattern) => pattern.test(normalized))).map(([rule]) => rule);
  };
}
