// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Config CLI commands — `akm config get/set/unset/list`.
 *
 * Thin wrappers around the schema walker in `core/config-walker.ts`. Adding a
 * new config field is one line of Zod schema in `core/config-schema.ts` and
 * zero lines here — the walker handles get/set/unset/coercion uniformly.
 *
 * All execution
 * settings use their canonical connection, harness and strategy paths; retired aliases are not
 * rewritten at this boundary.
 */
import os from "node:os";
import nodePath from "node:path";
import { isDeepStrictEqual } from "node:util";
import { defineGroupCommand, defineJsonCommand, output } from "../cli/shared";
import { isRecord } from "../core/common";
import {
  type AkmConfig,
  DEFAULT_CONFIG,
  getConfigValueSource,
  loadConfig,
  mutateConfig,
  parseAndValidateConfigText,
  unusableEntryAt,
} from "../core/config/config";
import { readConfigText } from "../core/config/config-io";
import { configGet, configSet, configUnset, unknownKeyHint } from "../core/config/config-walker";
import { isEnvReference } from "../core/config/schema/primitives";
import { UsageError } from "../core/errors";
import { getConfigPath } from "../core/paths";
import { isSecretKey } from "../core/redaction";
import { formatRegistryUrl } from "../core/registry-url";

// ── Public API ──────────────────────────────────────────────────────────────

export function getConfigValue(config: AkmConfig, key: string): unknown {
  const path = key.split(".");
  return redactSecretKeys(redactConfigValue(configGet(config as unknown as Record<string, unknown>, key), path), path);
}

export function setConfigValue(config: AkmConfig, key: string, rawValue: string): AkmConfig {
  return configSet(config as unknown as Record<string, unknown>, key, rawValue) as unknown as AkmConfig;
}

export function unsetConfigValue(config: AkmConfig, key: string): AkmConfig {
  return configUnset(config as unknown as Record<string, unknown>, key) as unknown as AkmConfig;
}

/**
 * Refuse an unset that would do nothing. An entry the reader drops is not in the config `unsetConfigValue` sees, so
 * it would no-op and say ok. Refuse before mutating rather than pretend it worked.
 */
export function assertUnsettable(key: string): void {
  const ignored = unusableEntryAt(key);
  if (ignored) {
    throw new UsageError(
      `Config key "${key}" is inside ${ignored.kind} "${ignored.name}", which akm ignores (${ignored.why}), so \`akm config\` cannot edit it.`,
      "TARGET_NOT_UPDATABLE",
      `Remove or fix the ${ignored.group}.${ignored.name} entry in ${getConfigPath()} by hand.`,
    );
  }
}

export function listConfig(config: AkmConfig): Record<string, unknown> {
  // Sources live in `bundles` (spread from config); the
  // retired top-level `sources[]` array is no longer surfaced.
  return redactConfigValue({ ...DEFAULT_CONFIG, ...config }) as Record<string, unknown>;
}

function redactConfigValue(value: unknown, path: string[] = []): unknown {
  const last = path.at(-1);
  if (last === "apiKey" && typeof value === "string" && !isEnvReference(value)) return undefined;
  if (typeof value === "string" && isRegistryUrlPath(path)) return formatRegistryUrl(value);
  if (Array.isArray(value)) return value.map((child, index) => redactConfigValue(child, [...path, String(index)]));
  if (!value || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key !== "apiKey" || (typeof child === "string" && isEnvReference(child))) {
      result[key] = redactConfigValue(child, [...path, key]);
    }
  }
  return result;
}

/**
 * What `akm config get`, `list`, `set`, `unset` and `diff` print: under `connections`, where the wire fields are the
 * endpoint's own and any name can carry a credential, the whole value of a secret-shaped key is dropped, whatever its
 * type, unless it is a `$VAR` reference. The `models` alias map is names, not secrets, and is left alone. Kept out of
 * `listConfig`, which Desktop saves from: a save must never lose a setting.
 */
export function redactSecretKeys(value: unknown, path: string[] = []): unknown {
  if (path.length > 0 && path[0] !== "connections") return value;
  if (path.includes("models")) return value;
  const last = path.at(-1);
  if (
    path.length > 2 &&
    last !== undefined &&
    value != null &&
    isSecretKey(last, value) &&
    !(typeof value === "string" && isEnvReference(value))
  ) {
    return undefined;
  }
  if (Array.isArray(value)) return value.map((child, index) => redactSecretKeys(child, [...path, String(index)]));
  if (!value || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const redacted = redactSecretKeys(child, [...path, key]);
    if (redacted !== undefined || child === undefined) result[key] = redacted;
  }
  return result;
}

function isRegistryUrlPath(path: string[]): boolean {
  return path[0] === "registries" && path.at(-1) === "url";
}

export { unknownKeyHint };

// ── `akm config diff` ────────────────────────────────────────────────

export interface ConfigDiffRow {
  path: string;
  local: unknown;
  other: unknown;
}

/**
 * Flatten a (redacted) config object down to `{dottedPath: leafValue}`
 * entries. A plain object descends; an array or scalar is a leaf — matching
 * `deepMergeConfig`'s own "objects merge, arrays replace wholesale" rule, so
 * an array difference reports as one row rather than per-index noise.
 */
function flattenConfigLeaves(value: unknown, prefix: string[], out: Map<string, unknown>): void {
  if (isRecord(value) && Object.keys(value).length > 0) {
    for (const [key, child] of Object.entries(value)) flattenConfigLeaves(child, [...prefix, key], out);
    return;
  }
  out.set(prefix.join("."), value);
}

/**
 * Diff two (already redacted) effective config objects into sorted
 * `{path, local, other}` rows for every leaf that differs — including a leaf
 * present on only one side (the other's value reads `undefined`).
 */
function diffConfigs(local: unknown, other: unknown): ConfigDiffRow[] {
  const localLeaves = new Map<string, unknown>();
  const otherLeaves = new Map<string, unknown>();
  flattenConfigLeaves(local, [], localLeaves);
  flattenConfigLeaves(other, [], otherLeaves);
  const paths = new Set([...localLeaves.keys(), ...otherLeaves.keys()]);
  const rows: ConfigDiffRow[] = [];
  for (const path of paths) {
    const localValue = localLeaves.get(path);
    const otherValue = otherLeaves.get(path);
    if (!isDeepStrictEqual(localValue, otherValue)) rows.push({ path, local: localValue, other: otherValue });
  }
  rows.sort((a, b) => a.path.localeCompare(b.path));
  return rows;
}

/**
 * `akm config diff <path>`: the current effective config against another config
 * file (`~` expands; a relative path is read from the working directory), secrets
 * redacted on both sides before comparison so a differing secret never
 * round-trips into the diff.
 */
export function akmConfigDiff(ref: string): { rows: ConfigDiffRow[] } {
  const current = loadConfig();
  const resolvedPath = nodePath.resolve(ref.startsWith("~") ? nodePath.join(os.homedir(), ref.slice(1)) : ref);
  const text = readConfigText(resolvedPath);
  if (text === undefined) throw new UsageError(`Config file ${resolvedPath} does not exist.`);
  const other = parseAndValidateConfigText(text, resolvedPath);
  const rows = diffConfigs(redactSecretKeys(redactConfigValue(current)), redactSecretKeys(redactConfigValue(other)));
  return { rows };
}

// ── `akm config` command surface ────────────────────────────────────────────
// Extracted verbatim from src/cli.ts (WS6). The `main.subCommands.config` key
// and every config subcommand's args/output shape are byte-identical. Leaf
// handlers whose body is a plain `runWithJsonErrors(() => { … })` are
// migrated to `defineJsonCommand`, which emits the same JSON envelope
// (stdout/stderr/exit-code) as the inline form.
//
// `akm config enable|disable` (a hardcoded alias for toggling the skills.sh
// registry) was removed in 0.9.0 (C4). Use `akm registry add|remove`, the
// general mechanism, instead.

export const configCommand = defineGroupCommand({
  meta: { name: "config", description: "Show and manage configuration" },
  subCommands: {
    path: defineJsonCommand({
      meta: { name: "path", description: "Print the path to the config file" },
      run() {
        console.log(getConfigPath());
      },
    }),
    list: defineJsonCommand({
      meta: { name: "list", description: "List current configuration" },
      run() {
        output("config", redactSecretKeys(listConfig(loadConfig())));
      },
    }),
    get: defineJsonCommand({
      meta: { name: "get", description: "Get a configuration value by key" },
      args: {
        key: { type: "positional", required: true, description: "Config key (for example: embedding, defaultBundle)" },
        "show-source": {
          type: "boolean",
          description: "Wrap the value as { value, source } (local or default)",
          default: false,
        },
      },
      run({ args }) {
        const value = getConfigValue(loadConfig(), args.key);
        output(
          "config",
          args["show-source"] ? { value: value ?? null, source: getConfigValueSource(args.key) } : (value ?? null),
        );
      },
    }),
    set: defineJsonCommand({
      meta: {
        name: "set",
        description:
          "Set a configuration value by key; prints the resulting config with ok: true. " +
          "Array and object values take JSON, quoted for the shell: akm config set projects.x.filters.project '[\"x\"]'. " +
          "Remove a key with `akm config unset`.",
      },
      args: {
        key: {
          type: "positional",
          required: true,
          description: "Config key (for example: defaultBundle, connections.fast.endpoint)",
        },
        value: { type: "positional", required: true, description: "Config value (JSON for arrays and objects)" },
        // #463: stable machine-friendly entry point for plugins / hooks.
        // `--silent` suppresses the config dump on stdout so hook-driven
        // writes don't pollute their host's output stream.
        silent: {
          type: "boolean",
          description: "Print nothing on success (for hooks and CI); errors still print",
          default: false,
        },
      },
      run({ args }) {
        const updated = mutateConfig((current) => setConfigValue(current, args.key, args.value)).config;
        if (!args.silent) {
          output("config", redactSecretKeys(listConfig(updated)));
        }
      },
    }),
    unset: defineJsonCommand({
      meta: {
        name: "unset",
        description:
          "Unset an optional configuration key or a whole section such as connections.fast or harnesses.opencode; prints the resulting config with ok: true",
      },
      args: {
        key: { type: "positional", required: true, description: "Config key to unset" },
        silent: {
          type: "boolean",
          description: "Print nothing on success (for hooks and CI); errors still print",
          default: false,
        },
      },
      run({ args }) {
        assertUnsettable(args.key);
        const result = mutateConfig((current) => unsetConfigValue(current, args.key), { absentNoop: true });
        const updated = result.config;
        if (!args.silent) {
          output("config", redactSecretKeys(listConfig(updated)));
        }
      },
    }),
    diff: defineJsonCommand({
      meta: {
        name: "diff",
        description: "Show effective-config differences against another config file, secrets redacted",
      },
      args: {
        ref: {
          type: "positional",
          required: true,
          description: "Other config file path",
        },
      },
      run({ args }) {
        output("config-diff", akmConfigDiff(args.ref));
      },
    }),
  },
  // The bare `akm config` invocation (and `akm config --list`) dumps the
  // current config. defineGroupCommand short-circuits this body when a
  // registered subcommand ran, so the routing set stays derived from the
  // subCommands map and can never desync.
  // Bare `akm config` runs `akm config list` (see insertBareListSubcommand in src/cli.ts).
});
