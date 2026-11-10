// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

export interface SettingsEntry {
  path: string;
  value: unknown;
  source: string | null;
}
export interface SettingsGit {
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  dirtyPaths: number;
  lastCommit: { sha: string; subject: string; time: string } | null;
}
export interface SettingsBundle {
  name: string;
  kind: string;
  default: boolean;
  path: string | null;
  source: { kind: string; locator: string };
  writable: boolean;
  enabled: boolean;
  writableSetting?: boolean;
  components: Array<{ name: string; adapter: string; root?: string; writable?: boolean; configured: boolean }>;
  settingsSource: string | null;
  version: string | null;
  exists: boolean;
  itemCount: number;
  byType: Record<string, number>;
  git: SettingsGit | null;
}
export interface SettingsIndex {
  entryCount: number;
  lastBuiltAt: string | null;
  hasEmbeddings: boolean;
  embeddingCount: number | null;
  embeddingCoverage: number | null;
  semanticSearch: { mode: string; status: string } | null;
  byType: Record<string, number>;
  unavailable?: unknown;
  unreadable?: unknown;
}
export interface SettingsBundleResponse {
  defaultBundle: string | null;
  bundles: SettingsBundle[];
  index: SettingsIndex;
}
export interface SettingsConfig {
  path: string;
  exists: boolean;
  config: Record<string, unknown>;
  entries: SettingsEntry[];
  /** What akm ignores in the `projects` of config.json, in its own words. */
  projectWarnings: string[];
  automaticWriteTarget: { name: string; path: string | null } | null;
  connections: Array<{ name: string; default?: boolean; models?: Record<string, unknown> }>;
  harnesses: Array<{ name: string; platform?: string }>;
  env: Array<{ name: string; value: string }>;
}
export type FieldKind = "text" | "number" | "url" | "boolean" | "list" | "select";
export interface SettingsField {
  key: string;
  label: string;
  kind?: FieldKind;
  options?: Array<[string, string]>;
  disabledOptions?: string[];
  hint?: string;
  placeholder?: string;
}
export interface SettingsGroup {
  id: string;
  title: string;
  description: string;
  fields: SettingsField[];
}
export function valueAt(config: Record<string, unknown>, key: string): unknown {
  return key
    .split(".")
    .reduce<unknown>(
      (value, part) =>
        value && typeof value === "object" && !Array.isArray(value)
          ? (value as Record<string, unknown>)[part]
          : undefined,
      config,
    );
}
export function fieldText(value: unknown, kind: FieldKind = "text"): string {
  return value == null ? "" : kind === "list" ? (Array.isArray(value) ? value.join(", ") : "") : String(value);
}
export function provenance(source: string | null | undefined): string {
  return source === "default"
    ? "Default"
    : source === "file"
      ? "Set in config.json"
      : source === null
        ? "Source not recorded"
        : (source ?? "Not set yet");
}
export function configurationChanges(
  fields: SettingsField[],
  initial: Record<string, string>,
  values: Record<string, string>,
) {
  const set: Record<string, string> = {},
    unset: string[] = [];
  for (const field of fields) {
    const value = (values[field.key] ?? initial[field.key] ?? "").trim();
    if (value === initial[field.key]) continue;
    if (!value && field.kind !== "boolean") unset.push(field.key);
    else
      set[field.key] =
        field.kind === "list"
          ? JSON.stringify(
              value
                .split(",")
                .map((item) => item.trim())
                .filter(Boolean),
            )
          : value;
  }
  return { set, unset };
}
