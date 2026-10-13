// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Distill guards: the related lessons, knowledge notes and skills shown to the
 * writer so it does not repeat or overwrite them (CLS context).
 */

export const DEFAULT_CLS_ADJACENT_COUNT = 3;

export interface ClsConfig {
  enabled?: boolean;
  adjacentCount?: number;
}

/** The CLS prompt section (each entry capped at 600 chars); empty when disabled (on unless `enabled: false`) or nothing is related. */
export function buildClsContext(adjacentItems: Array<{ ref: string; content: string }>, config: ClsConfig): string {
  if (config.enabled === false || adjacentItems.length === 0) return "";
  const lines = [
    "",
    "## Related assets already in the library",
    "The library already holds these lessons, knowledge notes and skills near this memory. They may be about another subject.",
    "If one of them already states the rule the memory would give, answer NONE. Do not contradict or overwrite them.",
    "",
  ];
  for (const item of adjacentItems) lines.push(`### ${item.ref}`, item.content.trim().slice(0, 600), "");
  return lines.join("\n");
}
