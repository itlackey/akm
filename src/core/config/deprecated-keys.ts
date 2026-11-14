// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * One notice per process for each deprecated config key that still works in 0.10 and goes in 0.11, like the
 * `extends` notice. The config is read exactly as before; a notice is not printed for akm's own runs
 * (the scheduler, a task, improve, audit) or with `--help`, and `--quiet` silences it (it goes through `warnOnce`).
 */
import { warnOnce } from "../warn";
import { isPlainObject } from "./deep-merge";

type Dict = Record<string, unknown>;

const INTERNAL_SOURCES = new Set(["task", "improve", "audit"]);

/**
 * True for akm's own invocations (the scheduler, a task, improve or audit), `--help` and `--scheduled`: no
 * deprecation notice. `hasFlag` answers for the invocation's own arguments (before any `--`).
 */
export function deprecationNoticesSuppressed(
  hasFlag: (flag: string) => boolean,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    INTERNAL_SOURCES.has(env.AKM_EVENT_SOURCE ?? "") || hasFlag("--help") || hasFlag("-h") || hasFlag("--scheduled")
  );
}

/** Whether this process was started with `flag` (or `flag=true`) among its own arguments. */
function processHasFlag(flag: string): boolean {
  for (const arg of process.argv.slice(2)) {
    if (arg === "--") return false;
    if (arg === flag || arg === `${flag}=true`) return true;
  }
  return false;
}

export function warnDeprecatedConfigKeys(raw: Dict, sourcePath?: string): void {
  if (deprecationNoticesSuppressed(processHasFlag)) return;
  const where = sourcePath ? ` (${sourcePath})` : "";
  const improve = isPlainObject(raw.improve) ? raw.improve : {};
  if (improve.strategies !== undefined || improve.qualityGate !== undefined) {
    warnOnce(
      "config:improve-learning-keys-deprecated",
      `\`improve.strategies\` and \`improve.qualityGate\` are Deprecated and are removed in 0.11: use \`experimental.learning.strategies\` and \`experimental.learning.qualityGate\`${where}. See STABILITY.md.`,
    );
  }
  // Still deletes state rows in 0.10; 0.11 drops the key and nothing replaces it.
  if (isPlainObject(improve.stateGc) && improve.stateGc.collect !== undefined) {
    warnOnce(
      "config:state-gc-collect-deprecated",
      `\`improve.stateGc.collect\` is Deprecated and is removed in 0.11, with no replacement${where}. See STABILITY.md.`,
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
      if (!isPlainObject(strategy)) continue;
      if (strategy.limit !== undefined) {
        warnOnce(
          "config:strategy-limit-deprecated",
          `\`${base}.${name}.limit\` is Deprecated and is removed in 0.11: use \`--limit\` or \`processes.reflect.limit\`${where}. See STABILITY.md.`,
        );
      }
      const processes = isPlainObject(strategy.processes) ? strategy.processes : {};
      if (isPlainObject(processes.consolidate) && processes.consolidate.limit !== undefined) {
        warnOnce(
          "config:consolidate-limit-deprecated",
          `\`${base}.${name}.processes.consolidate.limit\` is Deprecated and is removed in 0.11; \`--limit\` and \`processes.reflect.limit\` stay${where}. See STABILITY.md.`,
        );
      }
    }
  }
}
