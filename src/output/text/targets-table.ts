// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Plain-text table of connections, harnesses and the work that runs on them
 * (the rows `src/commands/targets.ts` builds), shared by `akm info` and
 * `akm health`: three small aligned tables, one per row type, each omitted when empty.
 */

type Row = Record<string, unknown>;

const text = (value: unknown): string => (value === undefined || value === null ? "-" : String(value));
const yesNo = (value: unknown): string => (value === undefined ? "-" : value ? "yes" : "no");

/** Left-aligned columns, two spaces apart, the header first. */
function table(headers: readonly string[], cells: readonly (readonly string[])[]): string[] {
  const widths = headers.map((header, i) => Math.max(header.length, ...cells.map((row) => row[i]?.length ?? 0)));
  const line = (row: readonly string[]) =>
    row
      .map((cell, i) => cell.padEnd(widths[i] ?? cell.length))
      .join("  ")
      .trimEnd();
  return [line(headers), ...cells.map(line)];
}

/** The reachability column: answered, or why not. */
function reachable(row: Row): string {
  return row.reachable === true ? "yes" : `no${row.error ? ` (${text(row.error)})` : ""}`;
}

/** The work column: where it runs, or that it does not. */
function runsOn(row: Row): string {
  if (row.kind === null || row.kind === undefined) return "off";
  return row.kind === "local" ? "built-in embedder" : `${text(row.kind)} ${text(row.target)}`;
}

/** What to look at in a work row: what resolves elsewhere, or what is wrong. */
function notes(row: Row): string {
  const parts = [
    Array.isArray(row.overrides) && row.overrides.length > 0 ? `elsewhere: ${row.overrides.join(", ")}` : "",
    row.problem ? text(row.problem) : "",
  ];
  return parts.filter(Boolean).join("; ");
}

/** A column: its header, its cell, and whether it shows only when some row has the field (reachability not asked, no usage looked up). */
interface Column {
  readonly header: string;
  readonly cell: (row: Row) => string;
  readonly field?: string;
}

const CONNECTION_COLUMNS: readonly Column[] = [
  { header: "NAME", cell: (row) => text(row.name) },
  { header: "DEFAULT", cell: (row) => (row.default ? "yes" : "") },
  { header: "ENDPOINT", cell: (row) => text(row.endpoint) },
  { header: "KEY", cell: (row) => text(row.key) },
  { header: "REACHABLE", cell: reachable, field: "reachable" },
  { header: "LAST USED", cell: (row) => text(row.lastUsedAt), field: "lastUsedAt" },
];

const HARNESS_COLUMNS: readonly Column[] = [
  { header: "NAME", cell: (row) => text(row.name) },
  { header: "DEFAULT", cell: (row) => (row.default ? "yes" : "") },
  { header: "PLATFORM", cell: (row) => text(row.platform) },
  { header: "INSTALLED", cell: (row) => yesNo(row.installed) },
  { header: "VERSION", cell: (row) => text(row.version), field: "version" },
  { header: "LAST USED", cell: (row) => text(row.lastUsedAt), field: "lastUsedAt" },
];

const WORK_COLUMNS: readonly Column[] = [
  { header: "WORK", cell: (row) => text(row.process) },
  { header: "RUNS ON", cell: runsOn },
  { header: "MODEL", cell: (row) => text(row.model) },
  { header: "NOTES", cell: notes },
];

function section(title: string, columns: readonly Column[], rows: readonly Row[]): string[] {
  if (rows.length === 0) return [];
  const shown = columns.filter(
    (column) => column.field === undefined || rows.some((row) => row[column.field as string] !== undefined),
  );
  const body = table(
    shown.map((column) => column.header),
    rows.map((row) => shown.map((column) => column.cell(row))),
  );
  return [`${title}:`, ...body.map((line) => `  ${line}`)];
}

export function renderTargetsTable(rows: readonly unknown[]): string[] {
  const of = (type: string) => rows.filter((row): row is Row => (row as Row | null)?.type === type);
  return [
    ...section("connections", CONNECTION_COLUMNS, of("connection")),
    ...section("harnesses", HARNESS_COLUMNS, of("harness")),
    ...section("work", WORK_COLUMNS, of("process")),
  ];
}
