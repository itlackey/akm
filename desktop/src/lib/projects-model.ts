// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Projects in Settings: the `projects` config entries as list rows and edit drafts, and a draft back to an entry.
 * Desktop checks nothing about an entry's content; akm's config schema does, when the entry is written.
 */

type Scalar = string | number | boolean;
type Scope = Record<string, string | string[]>;

export interface ProjectEntry {
  paths?: string[];
  from?: string | string[];
  filters?: Scope;
  prefer?: Scope;
  write?: { bundle?: string; user?: string; agent?: string; channel?: string; metadata?: Record<string, Scalar> };
  [other: string]: unknown;
}
/** A filter or prefer row. An empty value in akm means "the key is absent", shown as its own box. */
export interface ScopeRow {
  key: string;
  values: string;
  absent: boolean;
}
export interface ProjectDraft {
  name: string;
  paths: string;
  from: string[];
  filters: ScopeRow[];
  prefer: ScopeRow[];
  bundle: string;
  user: string;
  agent: string;
  channel: string;
  metadata: Array<{ key: string; value: string }>;
}
export interface ProjectRow {
  name: string;
  entry: ProjectEntry;
  /** Set in this install's config.json, or only inherited from an `extends` base (a local save overrides it). */
  inherited: boolean;
}

const list = (value: string | string[] | undefined): string[] =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** One value per line: a line never occurs inside a frontmatter value, and a comma can. */
function scopeRows(scope: Scope | undefined): ScopeRow[] {
  return Object.entries(scope ?? {}).map(([key, value]) => {
    const values = list(value);
    return { key, values: values.filter(Boolean).join("\n"), absent: values.includes("") };
  });
}
/** A row that still reads as it did when loaded keeps the value it came from, whatever shape that had. */
function scopeOf(rows: ScopeRow[], original: Scope | undefined): Scope | undefined {
  const entries = rows
    .map((row) => {
      const key = row.key.trim();
      if (original && key in original && same(scopeRows({ [key]: original[key] })[0], row))
        return [key, original[key]] as const;
      const values = row.values
        .split("\n")
        .map((value) => value.trim())
        .filter(Boolean);
      const all = row.absent ? [...values, ""] : values;
      return [key, all] as const;
    })
    .filter(([key, values]) => key && values.length);
  return entries.length
    ? Object.fromEntries(
        entries.map(([key, values]) => [key, Array.isArray(values) && values.length === 1 ? values[0] : values]),
      )
    : undefined;
}

/** The project rows, in config order; `local` names the projects this install's config.json holds. */
export function projectRows(projects: Record<string, ProjectEntry> | undefined, local: string[]): ProjectRow[] {
  return Object.entries(projects ?? {}).map(([name, entry]) => ({ name, entry, inherited: !local.includes(name) }));
}

export function projectDraft(name: string, entry: ProjectEntry = {}): ProjectDraft {
  const write = entry.write ?? {};
  return {
    name,
    paths: (entry.paths ?? []).join("\n"),
    from: list(entry.from),
    filters: scopeRows(entry.filters),
    prefer: scopeRows(entry.prefer),
    bundle: write.bundle ?? "",
    user: write.user ?? "",
    agent: write.agent ?? "",
    channel: write.channel ?? "",
    metadata: Object.entries(write.metadata ?? {}).map(([key, value]) => ({ key, value: String(value) })),
  };
}

/** What stops a draft being saved: a key twice in one list would silently overwrite itself. */
export function draftErrors(draft: ProjectDraft): string[] {
  const twice = (keys: string[]) =>
    keys.map((key) => key.trim()).filter((key, i, all) => key && all.indexOf(key) !== i);
  return [
    ...twice(draft.filters.map((row) => row.key)).map((key) => `Filters name "${key}" twice.`),
    ...twice(draft.prefer.map((row) => row.key)).map((key) => `Prefer names "${key}" twice.`),
    ...twice(draft.metadata.map((row) => row.key)).map((key) => `Metadata names "${key}" twice.`),
  ];
}

/**
 * The entry to write for a draft. A field the person did not change keeps the value it had in `original`, in its own
 * shape (a one-element list, an empty object, the order of its values); fields Desktop has no control for stay too.
 */
export function projectEntry(draft: ProjectDraft, original: ProjectEntry = {}): ProjectEntry {
  const { paths: oldPaths, from: oldFrom, filters: oldFilters, prefer: oldPrefer, write: oldWrite, ...rest } = original;
  const base = projectDraft(draft.name, original);
  const text = (value: string) => value.trim() || undefined;
  const paths = draft.paths
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const from = draft.from.length === 1 ? draft.from[0] : draft.from;
  const filters = same(draft.filters, base.filters) ? oldFilters : scopeOf(draft.filters, oldFilters);
  const prefer = same(draft.prefer, base.prefer) ? oldPrefer : scopeOf(draft.prefer, oldPrefer);
  const writeSame = (["bundle", "user", "agent", "channel", "metadata"] as const).every((key) =>
    same(draft[key], base[key]),
  );
  let write = oldWrite;
  if (!writeSame) {
    const { bundle: _b, user: _u, agent: _a, channel: _c, metadata: oldMetadata = {}, ...writeRest } = oldWrite ?? {};
    const metadata = Object.fromEntries(
      draft.metadata
        .filter((row) => row.key.trim())
        .map((row) => {
          const key = row.key.trim();
          return [key, key in oldMetadata && String(oldMetadata[key]) === row.value ? oldMetadata[key] : row.value];
        }),
    );
    const next = {
      ...writeRest,
      ...(text(draft.bundle) ? { bundle: text(draft.bundle) } : {}),
      ...(text(draft.user) ? { user: text(draft.user) } : {}),
      ...(text(draft.agent) ? { agent: text(draft.agent) } : {}),
      ...(text(draft.channel) ? { channel: text(draft.channel) } : {}),
      ...(Object.keys(metadata).length ? { metadata } : {}),
    };
    write = Object.keys(next).length ? next : undefined;
  }
  const entry: ProjectEntry = {
    ...rest,
    ...(same(draft.paths, base.paths)
      ? oldPaths !== undefined
        ? { paths: oldPaths }
        : {}
      : paths.length
        ? { paths }
        : {}),
    ...(same(draft.from, base.from)
      ? oldFrom !== undefined
        ? { from: oldFrom }
        : {}
      : draft.from.length
        ? { from }
        : {}),
    ...(filters ? { filters } : {}),
    ...(prefer ? { prefer } : {}),
    ...(write ? { write } : {}),
  };
  // Keys keep the order the file had them in, so an unchanged entry serializes as it was.
  const order = Object.keys(original);
  return Object.fromEntries(Object.entries(entry).sort(([a], [b]) => rank(order, a) - rank(order, b)));
}
const rank = (order: string[], key: string) => (order.includes(key) ? order.indexOf(key) : order.length);

/** The body of a save: the entry under its name, and the old name unset when the project was renamed. */
export function projectChange(draft: ProjectDraft, original: { name: string; entry: ProjectEntry } | null) {
  const name = draft.name.trim();
  return {
    set: { [name]: projectEntry(draft, original?.entry) },
    ...(original && original.name !== name ? { unset: [original.name] } : {}),
  };
}

/** One line for the list: where the project lives and what it sets. */
export function projectSummary(entry: ProjectEntry): string[] {
  const filters = Object.keys(entry.filters ?? {});
  const prefer = Object.keys(entry.prefer ?? {});
  return [
    ...(entry.from !== undefined ? [`Reads ${list(entry.from).join(", ")}`] : []),
    ...(filters.length ? [`Filters ${filters.join(", ")}`] : []),
    ...(prefer.length ? [`Prefers ${prefer.join(", ")}`] : []),
    ...(entry.write?.bundle ? [`Writes to ${entry.write.bundle}`] : []),
  ];
}

/** Names akm refuses for a project (`none` selects no project; the others would reach Object.prototype). */
export const RESERVED_NAMES = ["none", "__proto__", "constructor", "prototype"];

/** The message under the Name field, or "" when the name can be used. `editing` is the name being edited, which may keep itself. */
export function nameError(name: string, existing: string[], editing = ""): string {
  const value = name.trim();
  if (!value) return "Enter a name.";
  if (RESERVED_NAMES.includes(value)) return `“${value}” is reserved. Choose another name.`;
  if (value !== editing && existing.includes(value)) return `A project named “${value}” already exists.`;
  return "";
}

/** How many things differ from the loaded draft, for "n unsaved changes". */
export function draftChanges(draft: ProjectDraft, base: ProjectDraft): number {
  let count = 0;
  for (const key of ["name", "paths", "bundle", "user", "agent", "channel"] as const)
    if (draft[key] !== base[key]) count++;
  if (!same(draft.from, base.from)) count++;
  for (const key of ["filters", "prefer", "metadata"] as const) {
    const rows = Math.max(draft[key].length, base[key].length);
    for (let i = 0; i < rows; i++) if (!same(draft[key][i], base[key][i])) count++;
  }
  return count;
}

/** `{key} = a, b` pieces for a scope, with "" shown as the absent value. */
export function scopeText(scope: Scope | undefined): Array<{ key: string; values: string[] }> {
  return Object.entries(scope ?? {}).map(([key, value]) => ({ key, values: list(value) }));
}

/** The list card's filter and preference line: "2 filters · ranks channel = work first". */
export function filterLine(entry: ProjectEntry): string {
  const filters = Object.keys(entry.filters ?? {}).length;
  const prefer = scopeText(entry.prefer)[0];
  const ranks = prefer
    ? `ranks ${prefer.key} = ${prefer.values.filter(Boolean)[0] ?? ""}${prefer.values.filter(Boolean).length > 1 ? ` +${prefer.values.filter(Boolean).length - 1}` : ""} first`
    : "default preference";
  return `${filters ? `${filters} ${filters === 1 ? "filter" : "filters"}` : "No filters"} · ${ranks}`;
}

/** What `GET /api/projects/overview` returns: a project's effective read and write bundles with their counts. */
export interface BundleCount {
  count: number;
  byType: Record<string, number>;
}
export interface OverviewBundle {
  name: string;
  configured: boolean;
  enabled: boolean;
  readable: boolean;
  writable: boolean;
  total: BundleCount | null;
  eligible: BundleCount | null;
}
export interface Overview {
  project: { name: string; prefer: Record<string, string | string[]>; write: { metadata: Record<string, unknown> } };
  fromImplicit: boolean;
  preferImplicit: boolean;
  writeBundle: { name: string | null; implicit: boolean; usable: boolean | null };
  bundles: OverviewBundle[];
}
