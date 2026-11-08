// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Connections in Settings: the `connections` config entries as list rows and edit drafts, and a draft back to an entry.
 * Desktop checks only what a form can say before sending; akm's config schema decides what is accepted. A field the
 * person did not change keeps the value, shape and order it had, and keys Desktop has no control for stay as loaded.
 */

type Json = unknown;
export type ModelEntry = string | ({ model: string } & Record<string, Json>);
export interface ConnectionEntry {
  endpoint?: string;
  apiKey?: string;
  apiKeyFile?: string;
  models?: Record<string, ModelEntry>;
  contextLength?: number;
  timeoutMs?: number | null;
  concurrency?: number;
  [option: string]: unknown;
}
/** A row of `config.get().connections`: the entry plus what akm adds about it. */
export interface ConnectionRow extends ConnectionEntry {
  name: string;
  inherited?: boolean;
  usedBy?: string[];
  /** `file` (this install's config.json) or `extends:<ref>`: the config that defines it. */
  source?: string;
}
/** The configured entry of a row: `config.get()` adds the name, provenance and consumers, which are not the entry's. */
export function entryOf(row: ConnectionRow): ConnectionEntry {
  const { name: _name, inherited: _inherited, usedBy: _usedBy, source: _source, ...entry } = row;
  return entry;
}
export interface ModelRowDraft {
  alias: string;
  model: string;
  /** The model entry's request options as JSON text; empty when it has none. */
  options: string;
}
export interface ConnectionDraft {
  name: string;
  endpoint: string;
  apiKey: string;
  models: ModelRowDraft[];
  contextLength: string;
  timeoutMs: string;
  noTimeout: boolean;
  concurrency: string;
  /** The connection's request options as JSON text; empty when it has none. */
  options: string;
}

/** The keys akm owns on a connection; every other key is a request option sent as written. */
export const OWN_KEYS = ["endpoint", "apiKey", "apiKeyFile", "models", "contextLength", "timeoutMs", "concurrency"];
/** The longest timeout akm accepts (the workflow ceiling). */
export const MAX_TIMEOUT_MS = 24 * 60 * 60 * 1000;
export const NAME_PATTERN = /^(?!akm-)[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const pretty = (value: Record<string, unknown>) => (Object.keys(value).length ? JSON.stringify(value, null, 2) : "");

/** The connection's request options: every key akm does not own. */
export function requestOptions(entry: ConnectionEntry): Record<string, unknown> {
  return Object.fromEntries(Object.entries(entry).filter(([key]) => !OWN_KEYS.includes(key)));
}
function modelOptions(value: ModelEntry): Record<string, unknown> {
  return typeof value === "string" ? {} : Object.fromEntries(Object.entries(value).filter(([key]) => key !== "model"));
}

export function connectionDraft(name: string, entry: ConnectionEntry = {}): ConnectionDraft {
  return {
    name,
    endpoint: entry.endpoint ?? "",
    apiKey: entry.apiKey ?? "",
    models: Object.entries(entry.models ?? {}).map(([alias, value]) => ({
      alias,
      model: typeof value === "string" ? value : String(value.model ?? ""),
      options: pretty(modelOptions(value)),
    })),
    contextLength: entry.contextLength === undefined ? "" : String(entry.contextLength),
    timeoutMs: typeof entry.timeoutMs === "number" ? String(entry.timeoutMs) : "",
    noTimeout: entry.timeoutMs === null,
    concurrency: entry.concurrency === undefined ? "" : String(entry.concurrency),
    options: pretty(requestOptions(entry)),
  };
}
/** A new connection starts with the three aliases akm's own consumers look for. */
export function newConnectionDraft(): ConnectionDraft {
  return {
    ...connectionDraft(""),
    models: ["fast", "balanced", "reasoning"].map((alias) => ({ alias, model: "", options: "" })),
  };
}

function parseObject(text: string): Record<string, unknown> | undefined {
  if (!text.trim()) return {};
  try {
    const value = JSON.parse(text);
    return isObject(value) ? value : undefined;
  } catch {
    return undefined;
  }
}
/** A row with no model and no options is an alias left blank: it is not written and not checked. */
const blank = (row: ModelRowDraft) => !row.model.trim() && !row.options.trim();
const whole = (text: string) => /^[0-9]+$/.test(text.trim()) && Number(text) > 0;

/** What stops a draft being sent, by field: `name`, `endpoint`, `apiKey`, `models`, `model-{n}`, `modelOptions-{n}`, `contextLength`, `timeoutMs`, `concurrency`, `options`. */
export function connectionErrors(
  draft: ConnectionDraft,
  { existing, creating }: { existing: string[]; creating: boolean },
): Record<string, string> {
  const errors: Record<string, string> = {};
  const name = draft.name.trim();
  if (creating) {
    if (!name) errors.name = "Enter a name.";
    else if (!NAME_PATTERN.test(name))
      errors.name = "Use lowercase letters, digits and hyphens, and don't start with “akm-”.";
    else if (existing.includes(name)) errors.name = `A connection named “${name}” already exists.`;
  }
  try {
    const url = new URL(draft.endpoint.trim());
    if (!/^https?:$/.test(url.protocol)) throw new Error("scheme");
  } catch {
    errors.endpoint = "Enter a complete http or https URL.";
  }
  if (draft.apiKey.trim() && !draft.apiKey.trim().startsWith("$"))
    errors.apiKey = "Enter a reference such as $OPENAI_API_KEY, not the key itself.";
  const seen = new Set<string>();
  draft.models.forEach((row, index) => {
    if (blank(row)) return;
    const alias = row.alias.trim();
    if (!alias) errors[`alias-${index}`] = "Enter an alias.";
    else if (seen.has(alias)) errors[`alias-${index}`] = `“${alias}” is listed twice.`;
    seen.add(alias);
    if (!row.model.trim()) errors[`model-${index}`] = "Enter the model name.";
    if (parseObject(row.options) === undefined)
      errors[`modelOptions-${index}`] = "Request options must be a JSON object.";
  });
  if (draft.contextLength.trim() && !whole(draft.contextLength)) errors.contextLength = "Enter a whole number above 0.";
  if (
    draft.timeoutMs.trim() &&
    !draft.noTimeout &&
    (!whole(draft.timeoutMs) || Number(draft.timeoutMs) > MAX_TIMEOUT_MS)
  )
    errors.timeoutMs = `Enter a whole number above 0, at most ${MAX_TIMEOUT_MS.toLocaleString("en-US")}.`;
  if (draft.concurrency.trim() && !whole(draft.concurrency)) errors.concurrency = "Enter a whole number above 0.";
  const options = parseObject(draft.options);
  if (options === undefined) errors.options = "Request options must be a JSON object.";
  else {
    const owned = Object.keys(options).find((key) => OWN_KEYS.includes(key));
    if (owned) errors.options = `“${owned}” is set by the field above; remove it here.`;
  }
  return errors;
}

/** How many things differ from the loaded draft, for "n unsaved changes". */
export function connectionChanges(draft: ConnectionDraft, base: ConnectionDraft): number {
  let count = 0;
  for (const key of ["name", "endpoint", "apiKey", "contextLength", "timeoutMs", "concurrency", "options"] as const)
    if (draft[key] !== base[key]) count++;
  if (draft.noTimeout !== base.noTimeout) count++;
  const rows = Math.max(draft.models.length, base.models.length);
  for (let i = 0; i < rows; i++) if (!same(draft.models[i], base.models[i])) count++;
  return count;
}

/**
 * The entry to write for a draft. A field the person did not change keeps its loaded value (a model keeps its string or
 * object shape, option order is kept, retired keys such as `apiKeyFile` stay). Call only for a draft with no errors.
 */
export function connectionEntry(draft: ConnectionDraft, original: ConnectionEntry = {}): ConnectionEntry {
  const base = connectionDraft("", original);
  const entry: ConnectionEntry = { ...original };
  const set = <K extends string>(key: K, value: unknown) => {
    if (value === undefined) delete entry[key];
    else entry[key] = value;
  };
  if (draft.endpoint !== base.endpoint) set("endpoint", draft.endpoint.trim());
  if (draft.apiKey !== base.apiKey) set("apiKey", draft.apiKey.trim() || undefined);
  if (!same(draft.models, base.models)) {
    const models: Record<string, ModelEntry> = {};
    for (const row of draft.models) {
      if (blank(row)) continue;
      const alias = row.alias.trim();
      const before = original.models?.[alias];
      const baseRow = base.models.find((r) => r.alias === alias);
      if (before !== undefined && baseRow && same(baseRow, { ...row, alias })) {
        models[alias] = before;
        continue;
      }
      const options = parseObject(row.options) ?? {};
      // Options added make a string model an object; options all cleared make it a plain string again.
      models[alias] = Object.keys(options).length ? { model: row.model.trim(), ...options } : row.model.trim();
    }
    set("models", Object.keys(models).length ? models : undefined);
  }
  if (draft.contextLength !== base.contextLength)
    set("contextLength", draft.contextLength.trim() ? Number(draft.contextLength) : undefined);
  if (draft.timeoutMs !== base.timeoutMs || draft.noTimeout !== base.noTimeout)
    set("timeoutMs", draft.noTimeout ? null : draft.timeoutMs.trim() ? Number(draft.timeoutMs) : undefined);
  if (draft.concurrency !== base.concurrency)
    set("concurrency", draft.concurrency.trim() ? Number(draft.concurrency) : undefined);
  if (draft.options !== base.options) {
    for (const key of Object.keys(requestOptions(entry))) delete entry[key];
    Object.assign(entry, parseObject(draft.options) ?? {});
  }
  // Keys keep the order the file had them in, so an unchanged entry serializes as it was.
  const order = Object.keys(original);
  const rank = (key: string) => (order.includes(key) ? order.indexOf(key) : order.length);
  return Object.fromEntries(Object.entries(entry).sort(([a], [b]) => rank(a) - rank(b)));
}

/** The body of a save: the whole entry under its name; akm replaces the entry, so removed aliases and options go. */
export function connectionChange(name: string, entry: ConnectionEntry) {
  return { name: name.trim(), entry };
}

/** `Models fast, balanced, reasoning, +2 · Key $OPENAI_API_KEY` for a list row. */
export function connectionSummary(row: ConnectionEntry): string {
  const aliases = Object.keys(row.models ?? {});
  const models = aliases.length
    ? `Models ${aliases.slice(0, 3).join(", ")}${aliases.length > 3 ? `, +${aliases.length - 3}` : ""}`
    : "No models";
  return `${models} · ${row.apiKey ? `Key ${row.apiKey}` : "No key"}`;
}

/** The sentence under the intro, or a warning, for akm's default rule: the one named `default`, else the only one. */
export function defaultStatement(
  names: string[],
  defaultName: string | null,
): { kind: "none" } | { kind: "named" | "only"; name: string } | { kind: "ambiguous" } {
  if (!names.length) return { kind: "none" };
  if (defaultName) return { kind: defaultName === "default" ? "named" : "only", name: defaultName };
  return { kind: "ambiguous" };
}

/** An option value for display: scalars as written, anything else as JSON. */
export function optionText(value: unknown): string {
  return typeof value === "string" ? JSON.stringify(value) : JSON.stringify(value);
}
export const optionsText = (options: Record<string, unknown>): string =>
  Object.entries(options)
    .map(([key, value]) => `${key}: ${optionText(value)}`)
    .join(", ");

/** The effect of deleting, in the dialog's own sentences. */
export function deletionImpact(
  row: ConnectionRow,
  others: string[],
  defaultName: string | null,
): { references: string[]; defaultLine: string; inherited: boolean } {
  const rest = others.filter((name) => name !== row.name);
  return {
    references: row.usedBy ?? [],
    defaultLine:
      defaultName !== row.name
        ? ""
        : rest.length === 1
          ? `It is the default connection, used by model work that names none. Afterwards ${rest[0]} becomes the default (the only connection left).`
          : "It is the default connection, used by model work that names none. Afterwards no connection is the default, so that work runs on the default harness, if one is set.",
    inherited: false,
  };
}

/** The default connection first, then the others in the order they were configured. */
export function defaultFirst<T extends { name: string }>(rows: T[], defaultName: string | null): T[] {
  return [...rows].sort((a, b) => Number(b.name === defaultName) - Number(a.name === defaultName));
}
