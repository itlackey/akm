// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The one place lowering notices from several sources become one list.
 *
 * Notices are live execution metadata only: executor, report and output paths
 * merge them, result and evidence journal writers never do.
 */

import { type ExecutionJsonObject, sortExecutionJson } from "./json";
import type { LoweringNotice } from "./resolved-request";

export type Notice = Readonly<LoweringNotice>;
export type NoticeSink = (notices: readonly Notice[]) => void;

/**
 * Merge notices in first-seen order, each once. Two notices are the same when
 * everything about them is, `details` included and key order aside, so two
 * genuinely different structured diagnostics are not collapsed because their
 * headline fields match. `undefined` when there are none.
 */
export function mergeNotices<T extends Notice>(
  ...groups: readonly (readonly T[] | undefined)[]
): readonly T[] | undefined {
  const merged = new Map<string, T>();
  for (const group of groups) {
    for (const notice of group ?? []) {
      const key = JSON.stringify(sortExecutionJson(notice as unknown as ExecutionJsonObject));
      if (!merged.has(key)) merged.set(key, notice);
    }
  }
  return merged.size > 0 ? Object.freeze([...merged.values()]) : undefined;
}

const NONE: readonly Notice[] = Object.freeze([]);

/**
 * The notices a run's dispatches report as they go, merged when read.
 * `forward` also receives each batch as it arrives.
 */
export function noticeSet(forward?: NoticeSink) {
  const groups: (readonly Notice[])[] = [];
  const add: NoticeSink = (notices) => {
    groups.push(notices);
    forward?.(notices);
  };
  const list = (): readonly Notice[] => mergeNotices(...groups) ?? NONE;
  return {
    add,
    list,
    /** `{ notices }` for a result that carries them, `{}` when there are none. */
    fields: (): { notices?: readonly Notice[] } => {
      const notices = mergeNotices(...groups);
      return notices ? { notices } : {};
    },
  };
}
export type NoticeSet = ReturnType<typeof noticeSet>;
