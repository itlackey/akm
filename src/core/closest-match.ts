// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The closest of a few known names to one that was typed, for a did-you-mean in
 * an error: the unknown-flag and unknown-command paths, an improve scope's type,
 * and a connection or harness that is not configured.
 */

/** Single-row-at-a-time edit-distance DP (inputs are short flag/command names). */
function editDistance(a: string, b: string): number {
  let previous: number[] = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const current: number[] = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current.push(Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, (previous[j - 1] ?? 0) + cost));
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}

/**
 * Closest candidate within `threshold` edit distance, or undefined when
 * nothing is close enough to be worth suggesting. Callers pick their own thresholds.
 */
export function closestMatch(attempted: string, candidates: readonly string[], threshold: number): string | undefined {
  let best: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const distance = editDistance(attempted, candidate);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  return best !== undefined && bestDistance <= threshold ? best : undefined;
}
