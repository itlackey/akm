// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** Compare legacy numeric or semver-like config versions for diagnostics only. */
export function compareConfigVersion(
  a: string | number | undefined,
  b: string | number | undefined,
): -1 | 0 | 1 | undefined {
  const left = normalize(a);
  const right = normalize(b);
  if (!left || !right) return undefined;
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const l = left[index] ?? 0;
    const r = right[index] ?? 0;
    if (l < r) return -1;
    if (l > r) return 1;
  }
  return 0;
}

function normalize(value: string | number | undefined): number[] | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return [0, Math.trunc(value), 0];
  if (typeof value !== "string" || !value.trim()) return undefined;
  const parts = value.trim().replace(/^v/i, "").split(/[-+]/, 1)[0].split(".");
  if (parts.some((part) => !/^\d+$/.test(part))) return undefined;
  return parts.map(Number);
}
