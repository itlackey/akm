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

function scopeRows(scope: Scope | undefined): ScopeRow[] {
  return Object.entries(scope ?? {}).map(([key, value]) => {
    const values = list(value);
    return { key, values: values.filter(Boolean).join(", "), absent: values.includes("") };
  });
}
function scopeOf(rows: ScopeRow[]): Scope | undefined {
  const entries = rows
    .map((row) => {
      const values = row.values
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
      return [row.key.trim(), row.absent ? [...values, ""] : values] as const;
    })
    .filter(([key, values]) => key && values.length);
  return entries.length
    ? Object.fromEntries(entries.map(([key, values]) => [key, values.length === 1 ? values[0] : values]))
    : undefined;
}

/** The project rows, in config order. A project whose every setting is inherited is read-only here. */
export function projectRows(
  projects: Record<string, ProjectEntry> | undefined,
  entries: Array<{ path: string; source: string | null }>,
): ProjectRow[] {
  return Object.entries(projects ?? {}).map(([name, entry]) => {
    const own = entries.filter((item) => item.path === `projects.${name}` || item.path.startsWith(`projects.${name}.`));
    return { name, entry, inherited: own.length > 0 && own.every((item) => item.source?.startsWith("extends:")) };
  });
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

/**
 * The entry to write for a draft. Fields Desktop has no control for stay as they were in `original`; a metadata value
 * keeps its type (number or boolean) when the text is unchanged.
 */
export function projectEntry(draft: ProjectDraft, original: ProjectEntry = {}): ProjectEntry {
  const { paths: _paths, from: _from, filters: _filters, prefer: _prefer, write: oldWrite = {}, ...rest } = original;
  const {
    bundle: _bundle,
    user: _user,
    agent: _agent,
    channel: _channel,
    metadata: oldMetadata = {},
    ...writeRest
  } = oldWrite;
  const text = (value: string) => value.trim() || undefined;
  const paths = draft.paths
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const metadata = Object.fromEntries(
    draft.metadata
      .filter((row) => row.key.trim())
      .map((row) => {
        const key = row.key.trim();
        return [key, key in oldMetadata && String(oldMetadata[key]) === row.value ? oldMetadata[key] : row.value];
      }),
  );
  const write = {
    ...writeRest,
    ...(text(draft.bundle) ? { bundle: text(draft.bundle) } : {}),
    ...(text(draft.user) ? { user: text(draft.user) } : {}),
    ...(text(draft.agent) ? { agent: text(draft.agent) } : {}),
    ...(text(draft.channel) ? { channel: text(draft.channel) } : {}),
    ...(Object.keys(metadata).length ? { metadata } : {}),
  };
  const filters = scopeOf(draft.filters);
  const prefer = scopeOf(draft.prefer);
  return {
    ...rest,
    ...(paths.length ? { paths } : {}),
    ...(draft.from.length ? { from: draft.from.length === 1 ? draft.from[0] : draft.from } : {}),
    ...(filters ? { filters } : {}),
    ...(prefer ? { prefer } : {}),
    ...(Object.keys(write).length ? { write } : {}),
  };
}

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
