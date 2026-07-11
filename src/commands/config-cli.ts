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
 *   - `parseConfigValue` returns a Partial<AkmConfig> so it can be merged with
 *     the runtime config object via `mergeConfigValue`.
 */
import { defineGroupCommand, defineJsonCommand, output } from "../cli/shared";
import { resolveStashDir } from "../core/common";
import { type AkmConfig, DEFAULT_CONFIG, loadConfig, loadUserConfig, saveConfig } from "../core/config/config";
import { configGet, configSet, configUnset, unknownKeyHint } from "../core/config/config-walker";
import { UsageError } from "../core/errors";
import { getCacheDir, getConfigPath, getDbPath, getDefaultStashDir } from "../core/paths";

// ── Public API ──────────────────────────────────────────────────────────────

export function getConfigValue(config: AkmConfig, key: string): unknown {
  if (key.split(".").at(-1) === "apiKey") return null;
  return redactConfigValue(configGet(config as unknown as Record<string, unknown>, key));
}

export function setConfigValue(config: AkmConfig, key: string, rawValue: string): AkmConfig {
  return configSet(config as unknown as Record<string, unknown>, key, rawValue) as unknown as AkmConfig;
}

export function unsetConfigValue(config: AkmConfig, key: string): AkmConfig {
  return configUnset(config as unknown as Record<string, unknown>, key) as unknown as AkmConfig;
}

/**
 * Compatibility shim: returns a `Partial<AkmConfig>` containing just the
 * change. Older code merged this onto the live config — new code should call
 * `setConfigValue` directly (which returns the full merged config).
 */
export function parseConfigValue(key: string, value: string): Partial<AkmConfig> {
  // Use a "marker" base so we can detect which top-level fields actually got
  // touched by the set call. Anything still equal to the marker is untouched.
  const SENTINEL = Symbol("untouched");
  const base: Record<string, unknown> = { semanticSearchMode: SENTINEL };
  const next = setConfigValue(base as unknown as AkmConfig, key, value) as unknown as Record<string, unknown>;
  const patch: Record<string, unknown> = {};
  for (const k of Object.keys(next)) {
    if (next[k] !== SENTINEL) {
      patch[k] = next[k];
    }
  }
  return patch as Partial<AkmConfig>;
}

export function listConfig(config: AkmConfig): Record<string, unknown> {
  return redactConfigValue({ ...DEFAULT_CONFIG, ...config }) as Record<string, unknown>;
}

function redactConfigValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactConfigValue);
  if (!value || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key !== "apiKey") result[key] = redactConfigValue(child);
  }
  return result;
}

export { unknownKeyHint };

// ── `akm config` command surface ────────────────────────────────────────────
// Extracted verbatim from src/cli.ts (WS6). The `main.subCommands.config` key
// and every config subcommand's args/output shape are byte-identical. The
// `skills.sh` toggle helpers and the `CONFIG_SUBCOMMAND_SET` routing constant
// are used ONLY by this command, so they move with the cluster. Leaf handlers
// whose body is a plain `runWithJsonErrors(() => { … })` are migrated to
// `defineJsonCommand`, which emits the same JSON envelope (stdout/stderr/
// exit-code) as the inline form.

const SKILLS_SH_NAME = "skills.sh";
const SKILLS_SH_URL = "https://skills.sh";
const SKILLS_SH_PROVIDER = "skills-sh";

function normalizeToggleTarget(target: string): "skills.sh" {
  const normalized = target.trim().toLowerCase();
  if (normalized === "skills.sh" || normalized === "skills-sh") return "skills.sh";
  throw new UsageError(`Unsupported target "${target}". Supported targets: skills.sh`);
}

function toggleSkillsShRegistry(enabled: boolean): { changed: boolean; component: string; enabled: boolean } {
  const config = loadUserConfig();
  const registries = (config.registries ?? DEFAULT_CONFIG.registries ?? []).map((registry) => ({ ...registry }));
  const idx = registries.findIndex(
    (registry) =>
      registry.provider === SKILLS_SH_PROVIDER || registry.name === SKILLS_SH_NAME || registry.url === SKILLS_SH_URL,
  );

  if (idx >= 0) {
    const existing = registries[idx];
    const wasEnabled = existing.enabled !== false;
    existing.enabled = enabled;
    saveConfig({ ...config, registries });
    return { changed: wasEnabled !== enabled, component: SKILLS_SH_NAME, enabled };
  }

  if (!enabled) {
    // Materialize the skills.sh registry explicitly if absent.
    registries.push({ url: SKILLS_SH_URL, name: SKILLS_SH_NAME, provider: SKILLS_SH_PROVIDER, enabled: false });
    saveConfig({ ...config, registries });
    return { changed: true, component: SKILLS_SH_NAME, enabled: false };
  }

  registries.push({ url: SKILLS_SH_URL, name: SKILLS_SH_NAME, provider: SKILLS_SH_PROVIDER, enabled: true });
  saveConfig({ ...config, registries });
  return { changed: true, component: SKILLS_SH_NAME, enabled: true };
}

function toggleComponent(
  targetRaw: string,
  enabled: boolean,
): { changed: boolean; component: string; enabled: boolean } {
  const target = normalizeToggleTarget(targetRaw);
  if (target === "skills.sh") return toggleSkillsShRegistry(enabled);
  // normalizeToggleTarget throws for any unsupported target; this is unreachable.
  throw new UsageError(`Unsupported target "${targetRaw}". Supported targets: skills.sh`);
}

export const configCommand = defineGroupCommand({
  meta: { name: "config", description: "Show and manage configuration" },
  args: {
    list: { type: "boolean", description: "List current configuration", default: false },
  },
  subCommands: {
    path: defineJsonCommand({
      meta: { name: "path", description: "Show paths to config, stash, cache, and index" },
      args: {
        all: { type: "boolean", description: "Show all paths (config, stash, cache, index)", default: false },
      },
      run({ args }) {
        const configPath = getConfigPath();
        if (args.all) {
          let stashDir: string;
          try {
            stashDir = resolveStashDir({ readOnly: true });
          } catch {
            stashDir = `${getDefaultStashDir()} (not initialized)`;
          }
          const cacheDir = getCacheDir();
          const result = {
            config: configPath,
            stash: stashDir,
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
    show: defineJsonCommand({
      meta: { name: "show", description: "Alias for `akm config list` — list current configuration" },
      run() {
        output("config", listConfig(loadConfig()));
      },
    }),
    get: defineJsonCommand({
      meta: { name: "get", description: "Get a configuration value by key" },
      args: {
        key: { type: "positional", required: true, description: "Config key (for example: embedding, stashDir)" },
      },
      run({ args }) {
        output("config", getConfigValue(loadConfig(), args.key));
      },
    }),
    set: defineJsonCommand({
      meta: { name: "set", description: "Set a configuration value by key" },
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
            "Suppress the post-write config dump on stdout. Use from hooks and CI scripts; the write still happens and errors still print.",
          default: false,
        },
        // #463: explicit layer flag for forward-compat. User layer is the only
        // settable layer today; the flag exists so plugin authors can encode
        // intent and the surface stays stable if project-layer writes return.
        layer: {
          type: "string",
          description: "Config layer to write to. Currently only `user` is supported.",
          default: "user",
        },
      },
      run({ args }) {
        if (args.layer && args.layer !== "user") {
          throw new UsageError(
            `Unsupported --layer "${args.layer}". Only "user" is settable in 0.9.0.`,
            "INVALID_FLAG_VALUE",
          );
        }
        // Use loadConfig (not loadUserConfig) so the project-config
        // deprecation warning fires consistently with `akm config get`
        // (#457). Effective merged shape is identical post-0.8.0.
        const updated = setConfigValue(loadConfig(), args.key, args.value);
        saveConfig(updated);
        if (!args.silent) {
          output("config", listConfig(updated));
        }
      },
    }),
    unset: defineJsonCommand({
      meta: { name: "unset", description: "Unset an optional configuration key or whole embedding/engine section" },
      args: {
        key: { type: "positional", required: true, description: "Config key to unset" },
        silent: {
          type: "boolean",
          description: "Suppress the post-write config dump on stdout.",
          default: false,
        },
        layer: {
          type: "string",
          description: "Config layer to write to. Currently only `user` is supported.",
          default: "user",
        },
      },
      run({ args }) {
        if (args.layer && args.layer !== "user") {
          throw new UsageError(
            `Unsupported --layer "${args.layer}". Only "user" is settable in 0.9.0.`,
            "INVALID_FLAG_VALUE",
          );
        }
        const updated = unsetConfigValue(loadConfig(), args.key);
        saveConfig(updated);
        if (!args.silent) {
          output("config", listConfig(updated));
        }
      },
    }),
    validate: defineJsonCommand({
      meta: {
        name: "validate",
        description: "Validate the on-disk config file against the schema. Exits non-zero on errors.",
      },
      async run() {
        const { runConfigValidate } = await import("../cli/config-validate.js");
        await runConfigValidate();
      },
    }),
    migrate: defineJsonCommand({
      meta: {
        name: "migrate",
        description:
          "Diagnose whether the user config is already in the current schema. Never writes or translates config.",
      },
      async run() {
        const { runConfigMigrate } = await import("../cli/config-migrate.js");
        await runConfigMigrate();
      },
    }),
    enable: defineJsonCommand({
      meta: { name: "enable", description: "Enable an optional component (skills.sh)" },
      args: {
        target: { type: "positional", description: "Component to enable (skills.sh)", required: true },
      },
      run({ args }) {
        const result = toggleComponent(args.target, true);
        output("enable", result);
      },
    }),
    disable: defineJsonCommand({
      meta: { name: "disable", description: "Disable an optional component (skills.sh)" },
      args: {
        target: { type: "positional", description: "Component to disable (skills.sh)", required: true },
      },
      run({ args }) {
        const result = toggleComponent(args.target, false);
        output("disable", result);
      },
    }),
  },
  // The bare `akm config` invocation (and `akm config --list`) dumps the
  // current config. defineGroupCommand short-circuits this body when a
  // registered subcommand ran, so the routing set stays derived from the
  // subCommands map and can never desync (previously validate/migrate were
  // missing from a hand-maintained set, causing a spurious second dump).
  defaultRun() {
    output("config", listConfig(loadConfig()));
  },
});
