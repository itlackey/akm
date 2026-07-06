// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Model alias registry for agent CLI dispatch (v1 spec §12.3).
 *
 * Translates human-friendly aliases and cross-platform model identifiers to
 * the exact string each agent CLI expects for its --model flag.
 *
 * Resolution order (highest → lowest precedence):
 *   1. Profile-level modelAliases from config.json (user-defined)
 *   2. Global modelAliases from config.json — platform column, then "*" fallback
 *   3. Built-in alias table
 *   4. Verbatim pass-through (caller already supplied an exact model ID)
 */

/** Per-platform model string map. Keys are platform names; values are exact CLI model strings. */
export type PlatformModelMap = Record<string, string>;

/**
 * Global alias table from the config root `modelAliases` key: alias →
 * platform → exact model string. The reserved platform key `"*"` is a
 * fallback used when no platform-specific column matches. Values are always
 * literal model strings — never other aliases (one resolution level, no
 * recursion).
 */
export type GlobalModelAliasTable = Record<string, PlatformModelMap>;

interface ModelAliasEntry {
  readonly alias: string;
  readonly platforms: PlatformModelMap;
}

/**
 * Built-in alias table. Alias keys are lowercase.
 *
 * Platform model string conventions:
 *   opencode — "<provider>/<model>"  e.g. "opencode/claude-opus-4-7"
 *   claude   — bare model name       e.g. "claude-opus-4-7"
 *              (Claude Code also accepts its own built-in shorthands, but we
 *               always resolve to the full name for determinism)
 */
const BUILTIN_ALIASES: readonly ModelAliasEntry[] = [
  {
    alias: "opus",
    platforms: {
      claude: "claude-opus-4-7",
      opencode: "opencode/claude-opus-4-7",
    },
  },
  {
    alias: "sonnet",
    platforms: {
      claude: "claude-sonnet-4-6",
      opencode: "opencode/claude-sonnet-4-6",
    },
  },
  {
    alias: "haiku",
    platforms: {
      claude: "claude-haiku-4-5-20251001",
      opencode: "opencode/claude-haiku-4-5",
    },
  },
];

/**
 * Resolve a model alias or exact model ID to the string the target platform
 * CLI expects for its --model flag.
 *
 * @param model   Raw alias ("opus") or exact model ID ("claude-opus-4-7").
 * @param platform Builder platform name ("claude", "opencode", ...).
 * @param custom  Profile-level aliases from config.json — take priority over globals and builtins.
 * @param global  Config-root `modelAliases` tier table (alias → platform → model, `"*"` fallback).
 * @returns Resolved model string, or `model` verbatim when no alias matches.
 */
export function resolveModel(
  model: string,
  platform: string,
  custom?: PlatformModelMap,
  global?: GlobalModelAliasTable,
): string {
  const key = model.toLowerCase();
  if (custom?.[key]) return custom[key];
  const tier = global?.[key];
  const fromGlobal = tier?.[platform] ?? tier?.["*"];
  if (fromGlobal) return fromGlobal;
  const entry = BUILTIN_ALIASES.find((a) => a.alias === key);
  return entry?.platforms[platform] ?? model;
}

/** Return all built-in alias entries (for tests and documentation). */
export function listBuiltinModelAliases(): readonly ModelAliasEntry[] {
  return BUILTIN_ALIASES;
}
