// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * One notice per process for each deprecated config key that still works in 0.10 and goes in 0.11, like the
 * `extends` notice. The config is read exactly as before; a notice is not printed for akm's own runs
 * (the scheduler, a task, improve, audit) or with `--help`, and `--quiet` silences it (it goes through `warnOnce`).
 */
import { deprecationNoticesSuppressed } from "../../cli/deprecations";
import { warnOnce } from "../warn";
import { isPlainObject } from "./deep-merge";

type Dict = Record<string, unknown>;

export function warnDeprecatedConfigKeys(raw: Dict, sourcePath?: string): void {
  if (deprecationNoticesSuppressed()) return;
  const where = sourcePath ? ` (${sourcePath})` : "";
  const improve = isPlainObject(raw.improve) ? raw.improve : {};
  if (improve.strategies !== undefined || improve.qualityGate !== undefined) {
    warnOnce(
      "config:improve-learning-keys-deprecated",
      `\`improve.strategies\` and \`improve.qualityGate\` are Deprecated and are removed in 0.11: use \`experimental.learning.strategies\` and \`experimental.learning.qualityGate\`${where}. See STABILITY.md.`,
    );
  }
  const experimental = isPlainObject(raw.experimental) ? raw.experimental : {};
  const learning = isPlainObject(experimental.learning) ? experimental.learning : {};
  for (const [base, strategies] of [
    ["improve.strategies", improve.strategies],
    ["experimental.learning.strategies", learning.strategies],
  ] as const) {
    if (!isPlainObject(strategies)) continue;
    for (const [name, strategy] of Object.entries(strategies)) {
      if (!isPlainObject(strategy) || strategy.limit === undefined) continue;
      warnOnce(
        "config:strategy-limit-deprecated",
        `\`${base}.${name}.limit\` is Deprecated and is removed in 0.11: use \`--limit\` or \`processes.reflect.limit\`${where}. See STABILITY.md.`,
      );
      return;
    }
  }
}
