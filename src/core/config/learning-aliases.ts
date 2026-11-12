// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `experimental.learning.*` is the experimental home of the research learning controls: it mirrors
 * `improve.strategies` and `improve.qualityGate` key for key. The reader folds it into `improve.*` in memory, so
 * everything downstream sees the one shape it always read. A key set under both paths to different values reads
 * as the `experimental.learning` one, with one warning naming both.
 */
import { isDeepStrictEqual } from "node:util";
import { warnOnce } from "../warn";
import { isPlainObject } from "./deep-merge";

type Dict = Record<string, unknown>;

/** The `improve.*` keys `experimental.learning.*` mirrors. */
const LEARNING_KEYS = ["strategies", "qualityGate"] as const;

/** `old` with `next` laid over it: objects merge key by key, anything else in `next` replaces; `undefined` carries nothing. */
function overlay(old: unknown, next: unknown, keyPath: readonly string[], conflicts: string[][]): unknown {
  if (isPlainObject(old) && isPlainObject(next)) {
    const merged: Dict = { ...old };
    for (const [key, value] of Object.entries(next)) {
      if (value === undefined) continue;
      merged[key] = key in old ? overlay(old[key], value, [...keyPath, key], conflicts) : value;
    }
    return merged;
  }
  if (old !== undefined && !isDeepStrictEqual(old, next)) conflicts.push([...keyPath]);
  return next;
}

export function readLearningAliases(raw: Dict, sourcePath?: string): Dict {
  const experimental = raw.experimental;
  const learning = isPlainObject(experimental) ? experimental.learning : undefined;
  if (!isPlainObject(learning)) return raw;
  const improve = raw.improve === undefined ? {} : raw.improve;
  if (!isPlainObject(improve)) return raw;
  const folded: Dict = { ...improve };
  for (const key of LEARNING_KEYS) {
    if (learning[key] === undefined) continue;
    const conflicts: string[][] = [];
    folded[key] = overlay(improve[key], learning[key], [key], conflicts);
    for (const keyPath of conflicts) {
      const dotted = keyPath.join(".");
      warnOnce(
        `config:learning-alias:${sourcePath ?? "inline"}:${dotted}`,
        `improve.${dotted} and experimental.learning.${dotted} are both set${sourcePath ? ` at ${sourcePath}` : ""} to different values; using experimental.learning.${dotted}.`,
      );
    }
  }
  return { ...raw, improve: folded };
}
