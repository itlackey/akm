// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Generic `md` / `html` / `text` rendering of a shaped output envelope (D7).
 *
 * Every command gets `json`, `jsonl`, and `yaml` for free because those are
 * serializations of the envelope rather than renderings of it. `md`, `html`,
 * and `text` are renderings, and before D7 only `akm health` had `md`/`html`:
 * `md` silently emitted the JSON envelope everywhere else and `html` threw.
 * `text` had the same silent-JSON gap for any command with no registered
 * text formatter, closed later than `md`/`html` — see `renderGenericText`
 * below for why it is its own function rather than a reuse of
 * `renderGenericMarkdown`.
 *
 * These functions close that gap structurally rather than per command. A
 * command that registers a bespoke renderer (`akm health`) still wins; every
 * other command falls back to a real rendering derived from whatever its
 * envelope happens to contain. The shape is discovered, not declared, so a new
 * command is covered the day it is added.
 *
 * Deliberately dependency-free apart from the shared detail types and
 * `escapeHtml`: this module sits underneath the per-command renderer
 * registries and must not import them.
 */

import { escapeHtml } from "./html-render";

/** A row of an array-of-uniform-objects table: every entry shares these keys. */
type TableRow = Record<string, unknown>;

/**
 * True when `value` is a non-empty array of plain objects — the shape worth
 * rendering as a table rather than as a nested list. Uniformity is judged on
 * the union of keys, not on strict equality, so one row carrying an extra
 * optional field still tabulates (its column is simply blank elsewhere).
 */
function isTabular(value: unknown): value is TableRow[] {
  if (!Array.isArray(value) || value.length === 0) return false;
  return value.every((row) => row !== null && typeof row === "object" && !Array.isArray(row));
}

/** Column order for a table: first appearance across all rows, order-stable. */
function tableColumns(rows: readonly TableRow[]): string[] {
  const columns: string[] = [];
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!columns.includes(key)) columns.push(key);
    }
  }
  return columns;
}

/**
 * Render a leaf value for display. Objects and arrays that reach a cell are
 * JSON-encoded rather than expanded — a table cell is not a place to nest.
 */
function displayScalar(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

/**
 * Root-level envelope metadata the shape registry stamps on top of a
 * command's actual result: `shape` (the discriminator) and `schemaVersion`
 * (the envelope's own version), both added by the passthrough stamp in
 * `src/output/shapes/passthrough.ts` and equivalent per-command shapers
 * elsewhere. Transport bookkeeping, not a result anyone asked for — a `##
 * shape` / `## schemaVersion` section (`renderGenericMarkdown`), an
 * `<h2>shape</h2>` block (`renderGenericHtml`), or a `shape=…` line
 * (`renderGenericText`) is noise in every command's output, so every generic
 * renderer drops both. ONLY at the root, though: some shapes reuse
 * `schemaVersion` as genuine per-entry content one level down (each event in
 * `log list`'s `events[]` carries its own `schemaVersion`, see
 * `shapeEventEntry` in `src/output/shapes/helpers.ts`), and that must
 * survive untouched — every renderer below applies this filter only to the
 * top-level `Object.entries` loop over the envelope, never recursively.
 */
const ENVELOPE_META_KEYS = new Set(["shape", "schemaVersion"]);

// ── Markdown ─────────────────────────────────────────────────────────────────

/** Escape the one character that can break a Markdown table row. */
function escapeCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function markdownTable(rows: readonly TableRow[]): string[] {
  const columns = tableColumns(rows);
  if (columns.length === 0) return [];
  const lines = [
    `| ${columns.join(" | ")} |`,
    `| ${columns.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${columns.map((c) => escapeCell(displayScalar(row[c]))).join(" | ")} |`),
  ];
  return lines;
}

function markdownValue(value: unknown, depth: number): string[] {
  if (isTabular(value)) return markdownTable(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return ["_(none)_"];
    return value.map((item) => `- ${escapeCell(displayScalar(item))}`);
  }
  if (value !== null && typeof value === "object") {
    const lines: string[] = [];
    for (const [key, nested] of Object.entries(value)) {
      // Headings stop at h6; deeper nesting continues as bolded labels.
      const heading = "#".repeat(Math.min(depth, 6));
      lines.push(depth <= 6 ? `${heading} ${key}` : `**${key}**`, "", ...markdownValue(nested, depth + 1), "");
    }
    return lines;
  }
  return [displayScalar(value) === "" ? "_(empty)_" : displayScalar(value)];
}

/**
 * Render a shaped envelope as Markdown. `command` titles the document so a
 * rendered file identifies itself once detached from the invocation.
 */
export function renderGenericMarkdown(command: string, value: unknown): string {
  const body =
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? Object.entries(value)
          .filter(([key]) => !ENVELOPE_META_KEYS.has(key)) // transport metadata, not a result
          .flatMap(([key, nested]) => [`## ${key}`, "", ...markdownValue(nested, 3), ""])
      : markdownValue(value, 2);
  const lines = [`# ${command}`, "", ...body];
  const rendered = lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
  return `${rendered}\n`;
}

// ── HTML ─────────────────────────────────────────────────────────────────────

function htmlTable(rows: readonly TableRow[]): string {
  const columns = tableColumns(rows);
  if (columns.length === 0) return "";
  const head = `<tr>${columns.map((c) => `<th scope="col">${escapeHtml(c)}</th>`).join("")}</tr>`;
  const body = rows
    .map((row) => `<tr>${columns.map((c) => `<td>${escapeHtml(displayScalar(row[c]))}</td>`).join("")}</tr>`)
    .join("");
  return `<table><thead>${head}</thead><tbody>${body}</tbody></table>`;
}

function htmlValue(value: unknown, depth: number): string {
  if (isTabular(value)) return htmlTable(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return "<p><em>(none)</em></p>";
    return `<ul>${value.map((item) => `<li>${escapeHtml(displayScalar(item))}</li>`).join("")}</ul>`;
  }
  if (value !== null && typeof value === "object") {
    const level = Math.min(depth, 6);
    return Object.entries(value)
      .map(([key, nested]) => `<h${level}>${escapeHtml(key)}</h${level}>${htmlValue(nested, depth + 1)}`)
      .join("");
  }
  const scalar = displayScalar(value);
  return scalar === "" ? "<p><em>(empty)</em></p>" : `<p>${escapeHtml(scalar)}</p>`;
}

/**
 * Render a shaped envelope as a self-contained HTML document.
 *
 * Self-contained matters: the output is routinely redirected to a file and
 * opened directly, so it carries its own minimal styling and references
 * nothing external.
 */
export function renderGenericHtml(command: string, value: unknown): string {
  const body =
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? Object.entries(value)
          .filter(([key]) => !ENVELOPE_META_KEYS.has(key)) // transport metadata, not a result
          .map(([key, nested]) => `<h2>${escapeHtml(key)}</h2>${htmlValue(nested, 3)}`)
          .join("")
      : htmlValue(value, 2);
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>akm ${escapeHtml(command)}</title>`,
    "<style>",
    "body{font:16px/1.5 system-ui,sans-serif;margin:2rem auto;max-width:60rem;padding:0 1rem}",
    "table{border-collapse:collapse;width:100%;margin:0 0 1rem}",
    "th,td{border:1px solid #8884;padding:.35rem .6rem;text-align:left}",
    "th{background:#8881}",
    "h1{margin-bottom:1.5rem}",
    "@media(prefers-color-scheme:dark){body{background:#111;color:#eee}}",
    "</style>",
    "</head>",
    "<body>",
    `<h1>akm ${escapeHtml(command)}</h1>`,
    body === "" ? "<p><em>(no output)</em></p>" : body,
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

// ── Text ─────────────────────────────────────────────────────────────────────

/**
 * Flatten `value` onto `lines` as `dotted.path=value` entries — the exact
 * algorithm `formatConfigPlain` (`src/output/text/command-format.ts`)
 * already established as this CLI's real plain-text house style for `akm
 * config list`. Arrays serialize as one compact-JSON line rather than
 * index-per-line (`items.0.name=…`), matching that same precedent instead of
 * inventing a second convention: the arrays that reach this generic
 * fallback are typically short id/tag lists, where one JSON-array line reads
 * better than N extra `path.0=`, `path.1=`, … lines.
 *
 * Exported so command-specific text formatters (e.g. `formatHealthPlain` in
 * `src/output/text/health-format.ts`) can reuse the SAME scalar-tree
 * convention for the parts of their envelope that are plain nested
 * scalars/objects, while overriding just the parts that need bespoke
 * handling (arrays of status-bearing records, where this function's
 * one-JSON-line-per-array behavior is the exact defect those formatters
 * exist to fix). Reuse beats a second flattener.
 */
export function flattenForText(value: unknown, path: string, lines: string[]): void {
  if (value === null || value === undefined) {
    lines.push(`${path}=`);
  } else if (Array.isArray(value)) {
    lines.push(`${path}=${JSON.stringify(value)}`);
  } else if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) {
      lines.push(`${path}={}`);
      return;
    }
    for (const [key, nested] of entries) {
      flattenForText(nested, `${path}.${key}`, lines);
    }
  } else {
    lines.push(`${path}=${String(value)}`);
  }
}

/**
 * Render a shaped envelope as flat `key=value` text — no markup characters.
 *
 * This is a DISTINCT function from `renderGenericMarkdown`, not a reuse of
 * it, and that is a deliberate reversal of this fallback's first cut, which
 * called `renderGenericMarkdown` directly for `text` on the reasoning that
 * it emits no HTML and is therefore "plain-text-safe." That reasoning was
 * wrong: `#` heading markers, `_..._` emphasis, and `| ... |` table syntax
 * ARE markup — a terminal happens to print them as literal characters
 * instead of throwing, but a user piping `--format text` into `grep` or a
 * line-oriented script still sees literal `#`/`_`/`|` noise that plain JSON
 * at least didn't have. That is the exact "one format wearing another
 * format's flag" defect this whole fallback exists to close, with Markdown
 * substituted for JSON instead of JSON itself.
 *
 * `akm config list --format text` and `akm info --format text` already
 * establish this CLI's real plain-text convention — flat `dotted.path=value`
 * lines, no markup — so the generic fallback now matches its registered
 * siblings (what a command looks like once someone writes it a bespoke
 * formatter) instead of matching `md`'s.
 */
export function renderGenericText(command: string, value: unknown): string {
  const lines: string[] = [];
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (ENVELOPE_META_KEYS.has(key)) continue; // transport metadata, not a result
      flattenForText(nested, key, lines);
    }
  } else {
    flattenForText(value, command, lines);
  }
  return lines.length === 0 ? `${command}: (empty)\n` : `${lines.join("\n")}\n`;
}
