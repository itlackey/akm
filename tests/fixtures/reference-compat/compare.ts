// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * How the corpus compares a run with the recording.
 *
 * A difference is a node: the deepest place where the two results stop agreeing. Objects are walked key by key and
 * arrays of objects that each carry a unique `ref` (or `id`, or `file`+`issue`+`detail`) element by element, matched by that name, so a moved hit is
 * one node (`hits[order]`) and an added or removed one is a node of its own; other equal-length arrays are walked by
 * index. Anything else (a value, a type, an array that grew or shrank) is a node holding both sides. Two runs that
 * agree give no nodes. Each node is one entry of `differences.json`: its case, its path, the recorded value (`base`),
 * the working tree's value (`current`) and the `row` of the design's approved-changes register (§0.2) that approves
 * it. A node passes only when an entry names exactly that case, path, base and current AND its row is one the
 * owner approved. Nothing else passes: not a new difference, not one whose value moved on since it was registered,
 * and not an entry whose difference no longer occurs.
 */

export interface DifferenceNode {
  case: string;
  /** Where in the case's result, e.g. `stdout.hits[2].ref`; empty for the whole result. */
  path: string;
  /** The recorded value; absent (`undefined`) when the recording has no such value. */
  base?: unknown;
  /** The working tree's value; absent when it has none. */
  current?: unknown;
}

/**
 * Whether a registered entry's `case` covers a node's. An entry names one case, or a glob of them (`*` matches any
 * characters) for a difference every such case shows the same way; its path, recorded value and new value must still
 * be exactly the node's.
 */
export function caseCovers(entryCase: string, nodeCase: string): boolean {
  if (!entryCase.includes("*")) return entryCase === nodeCase;
  const pattern = entryCase
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${pattern}$`).test(nodeCase);
}

export interface RegisteredDifference extends DifferenceNode {
  /** The §0.2 row that approves this difference, e.g. `A3`; `A3+A5` when two approved rows together account for it. */
  row: string;
  /** Why the row covers it, in one line. */
  note: string;
}

/**
 * The rows of the design's §0.2 register the owner has approved, so the only rows a difference may name (N9 was
 * withdrawn, never approved). A row that is still marked as needing the owner's approval is not here: a difference only
 * it covers stays failing.
 */
export const APPROVED_ROWS: ReadonlySet<string> = new Set([
  ...Array.from({ length: 16 }, (_, i) => `A${i + 1}`),
  ...[1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15, 16, 17].map((n) => `N${n}`),
]);

/** True when `row` names only approved §0.2 rows (`A3`, or `A3+A5`). */
export function rowsApproved(row: string): boolean {
  return row.length > 0 && row.split("+").every((r) => APPROVED_ROWS.has(r));
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The keys that name each element of two arrays of objects, when every element has a unique name by them. */
const IDENTITIES: string[][] = [["ref"], ["id"], ["file", "issue", "detail"]];

function identityKeys(base: unknown[], current: unknown[]): string[] | undefined {
  for (const keys of IDENTITIES) {
    const names = (list: unknown[]) =>
      list.map((e) =>
        isObject(e) && keys.every((k) => typeof e[k] === "string") ? keys.map((k) => e[k]).join("\u0001") : undefined,
      );
    const halves = [names(base), names(current)];
    if (halves.every((h) => h.every((v) => v !== undefined) && new Set(h).size === h.length)) return keys;
  }
  return undefined;
}

type Found = Array<{ path: string; base?: unknown; current?: unknown }>;

function walk(base: unknown, current: unknown, at: string, out: Found) {
  if (isObject(base) && isObject(current)) {
    for (const key of new Set([...Object.keys(base), ...Object.keys(current)])) {
      const next = /^[A-Za-z_$][\w$]*$/.test(key) ? (at ? `${at}.${key}` : key) : `${at}[${JSON.stringify(key)}]`;
      if (!(key in current)) out.push({ path: next, base: base[key] });
      else if (!(key in base)) out.push({ path: next, current: current[key] });
      else walk(base[key], current[key], next, out);
    }
    return;
  }
  if (Array.isArray(base) && Array.isArray(current)) {
    const keys = identityKeys(base, current);
    if (keys !== undefined) {
      // Elements are matched by what they are, not where they stand: a hit that moved is one difference, not a shift of
      // every hit after it.
      const label = (e: unknown) =>
        `[${keys.map((k) => `${k}=${JSON.stringify((e as Record<string, string>)[k])}`).join(",")}]`;
      const named = (list: unknown[]) => new Map(list.map((e) => [label(e), e]));
      const before = named(base);
      const after = named(current);
      for (const [id, element] of before) {
        if (!after.has(id)) out.push({ path: `${at}${id}`, base: element });
        else walk(element, after.get(id), `${at}${id}`, out);
      }
      for (const [id, element] of after) if (!before.has(id)) out.push({ path: `${at}${id}`, current: element });
      const common = (ids: string[], other: Map<string, unknown>) => ids.filter((id) => other.has(id));
      const was = common([...before.keys()], after);
      const now = common([...after.keys()], before);
      if (JSON.stringify(was) !== JSON.stringify(now)) out.push({ path: `${at}[order]`, base: was, current: now });
      return;
    }
    if (base.length === current.length) {
      for (const [i, value] of base.entries()) walk(value, current[i], `${at}[${i}]`, out);
      return;
    }
  }
  if (JSON.stringify(base) !== JSON.stringify(current)) out.push({ path: at, base, current });
}

/** Every difference node between the recording and a run, in case order. */
export function differences(expected: Record<string, unknown>, actual: Record<string, unknown>): DifferenceNode[] {
  const nodes: DifferenceNode[] = [];
  for (const id of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
    const found: Found = [];
    if (!(id in actual)) found.push({ path: "", base: expected[id] });
    else if (!(id in expected)) found.push({ path: "", current: actual[id] });
    else walk(expected[id], actual[id], "", found);
    for (const f of found) nodes.push({ case: id, ...f });
  }
  return nodes;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** The registered entry that approves `node`, if there is one: same case, path, base and current, approved row. */
export function approvedBy(node: DifferenceNode, registry: RegisteredDifference[]): RegisteredDifference | undefined {
  return registry.find(
    (e) =>
      caseCovers(e.case, node.case) &&
      e.path === node.path &&
      same(e.base, node.base) &&
      same(e.current, node.current) &&
      rowsApproved(e.row),
  );
}
