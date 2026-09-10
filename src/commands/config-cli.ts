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
 * `configVersion` is controlled by the config lifecycle. All execution
 * settings use their canonical engine/strategy paths; retired aliases are not
 * rewritten at this boundary.
 */
import { isDeepStrictEqual } from "node:util";
import { defineGroupCommand, defineJsonCommand, output } from "../cli/shared";
import { isRecord, resolveStashDir } from "../core/common";
import {
  type AkmConfig,
  DEFAULT_CONFIG,
  getConfigValueSource,
  loadConfig,
  mutateConfig,
  parseAndValidateConfigText,
  resolveConfigRefSource,
} from "../core/config/config";
import { configGet, configSet, configUnset, unknownKeyHint } from "../core/config/config-walker";
import { UsageError } from "../core/errors";
import { getCacheDir, getConfigPath, getDbPath, getDefaultStashDir } from "../core/paths";
import { formatRegistryUrl } from "../core/registry-url";

// ── Public API ──────────────────────────────────────────────────────────────

export function getConfigValue(config: AkmConfig, key: string): unknown {
  return redactConfigValue(configGet(config as unknown as Record<string, unknown>, key), key.split("."));
}

export function setConfigValue(config: AkmConfig, key: string, rawValue: string): AkmConfig {
  return configSet(config as unknown as Record<string, unknown>, key, rawValue) as unknown as AkmConfig;
}

export function unsetConfigValue(config: AkmConfig, key: string): AkmConfig {
  return configUnset(config as unknown as Record<string, unknown>, key) as unknown as AkmConfig;
}

export function listConfig(config: AkmConfig): Record<string, unknown> {
  // 0.9.0 (spec §10.1): sources live in `bundles` (spread from config); the
  // retired top-level `sources[]` array is no longer surfaced.
  return redactConfigValue({ ...DEFAULT_CONFIG, ...config }) as Record<string, unknown>;
}

function redactConfigValue(value: unknown, path: string[] = []): unknown {
  if (typeof value === "string" && isRegistryUrlPath(path)) return formatRegistryUrl(value);
  if (Array.isArray(value)) return value.map((child, index) => redactConfigValue(child, [...path, String(index)]));
  if (!value || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (
      key !== "apiKey" ||
      (typeof child === "string" && /^\$(?:[A-Za-z_][A-Za-z0-9_]*|\{[A-Za-z_][A-Za-z0-9_]*\})$/.test(child))
    ) {
      result[key] = redactConfigValue(child, [...path, key]);
    }
  }
  return result;
}

function isRegistryUrlPath(path: string[]): boolean {
  return path[0] === "registries" && path.at(-1) === "url";
}

export { unknownKeyHint };

// ── `akm config diff` (#945) ────────────────────────────────────────────────

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
 * `akm config diff <path|bundle//path>`: the current effective config
 * (this instance's `extends` already applied) against another config file or
 * bundle-relative file (loaded through the same loader, its own `extends`
 * honoured), secrets redacted on both sides before comparison so a differing
 * secret never round-trips into the diff.
 */
export function akmConfigDiff(ref: string): { rows: ConfigDiffRow[] } {
  const current = loadConfig();
  const { text, resolvedPath } = resolveConfigRefSource(
    ref,
    current as unknown as Record<string, unknown>,
    getConfigPath(),
  );
  const other = parseAndValidateConfigText(text, resolvedPath);
  const rows = diffConfigs(redactConfigValue(current), redactConfigValue(other));
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
      meta: { name: "path", description: "Show paths to config, bundle, cache, and index" },
      args: {
        all: { type: "boolean", description: "Show all paths (config, bundle, cache, index)", default: false },
      },
      run({ args }) {
        const configPath = getConfigPath();
        if (args.all) {
          let stashDir: string;
          try {
            stashDir = resolveStashDir();
          } catch {
            stashDir = `${getDefaultStashDir()} (not initialized)`;
          }
          const cacheDir = getCacheDir();
          const result = {
            config: configPath,
            bundle: stashDir,
            cache: cacheDir,
            index: getDbPath(),
          };
          output("config", result);
        } else {
          console.log(configPath);
        }
      },
    }),
    list: defineJsonCommand({
      meta: { name: "list", description: "List current configuration" },
      run() {
        output("config", listConfig(loadConfig()));
      },
    }),
    get: defineJsonCommand({
      meta: { name: "get", description: "Get a configuration value by key" },
      args: {
        key: { type: "positional", required: true, description: "Config key (for example: embedding, defaultBundle)" },
        "show-source": {
          type: "boolean",
          description:
            'Wrap the value as { value, source }, where source is "local", "extends:<ref>" (the nearest ' +
            'extends chain member that sets it), or "default".',
          default: false,
        },
      },
      run({ args }) {
        const value = getConfigValue(loadConfig(), args.key);
        output("config", args["show-source"] ? { value, source: getConfigValueSource(args.key) } : value);
      },
    }),
    set: defineJsonCommand({
      meta: {
        name: "set",
        description: "Set a configuration value by key; prints the resulting config with ok: true",
      },
      args: {
        key: {
          type: "positional",
          required: true,
          description: "Config key (for example: embedding, engines.default)",
        },
        value: { type: "positional", required: true, description: "Config value" },
        // #463: stable machine-friendly entry point for plugins / hooks.
        // `--silent` suppresses the config dump on stdout so hook-driven
        // writes don't pollute their host's output stream.
        silent: {
          type: "boolean",
          description:
            "Suppress the post-write config dump on stdout entirely (prints nothing; exit code is the status). Use from hooks and CI scripts; the write still happens and errors still print.",
          default: false,
        },
      },
      run({ args }) {
        const updated = mutateConfig((current) => setConfigValue(current, args.key, args.value)).config;
        if (!args.silent) {
          output("config", listConfig(updated));
        }
      },
    }),
    unset: defineJsonCommand({
      meta: {
        name: "unset",
        description:
          "Unset an optional configuration key or whole embedding/engine section; prints the resulting config with ok: true",
      },
      args: {
        key: { type: "positional", required: true, description: "Config key to unset" },
        silent: {
          type: "boolean",
          description:
            "Suppress the post-write config dump on stdout entirely (prints nothing; exit code is the status).",
          default: false,
        },
      },
      run({ args }) {
        // A key only an `extends` base supplies has nothing local to remove:
        // `unsetConfigValue` would silently no-op and the value comes right
        // back on the next load. Refuse before mutating rather than pretend
        // it worked.
        const source = getConfigValueSource(args.key);
        if (source.startsWith("extends:")) {
          throw new UsageError(
            `Config key "${args.key}" is inherited from ${source} and cannot be unset here.`,
            "TARGET_NOT_UPDATABLE",
            `Override it locally with "akm config set ${args.key} <value>", or edit the base file directly.`,
          );
        }
        const result = mutateConfig((current) => unsetConfigValue(current, args.key), { absentNoop: true });
        const updated = result.config;
        if (!args.silent) {
          output("config", listConfig(updated));
        }
      },
    }),
    diff: defineJsonCommand({
      meta: {
        name: "diff",
        description:
          "Show effective-config differences against another config file or bundle-relative file, secrets redacted",
      },
      args: {
        ref: {
          type: "positional",
          required: true,
          description: "Other config: a file path or bundle//path (relative to the bundle's content root)",
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
  // No `defaultRun`: bare `akm config` is a usage error (exit 2), the canonical
  // bare-group behavior — owner ruling 12. Run `akm config list` for what the
  // bare form used to print.
});
