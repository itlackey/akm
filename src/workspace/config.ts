// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** The effective config the owner can read, and the validated changes they can make to it. */

import fs from "node:fs";
import { assertUnsettable, listConfig, setConfigValue, unsetConfigValue } from "../commands/config-cli";
import { type AkmConfig, loadConfig, mutateConfig, resetConfigCache } from "../core/config/config";
import { UsageError } from "../core/errors";
import { getConfigPath } from "../core/paths";
import { resolveWorkingStashTarget } from "../core/write-source";
import { configSource, preserveUnrelatedConfig, workingStashDir } from "./readers";
import { isSecretEnvName, redactForUi } from "./redact";

/** Where an automatic write goes (no defaultWriteTarget): AKM_BUNDLE_DIR first, then the default bundle. */
function automaticWriteTarget(config: AkmConfig) {
  try {
    const { source } = resolveWorkingStashTarget(config, { requireWritable: false });
    const path = source.path ?? null;
    return { name: source.name, path, workingStash: path !== null && path === workingStashDir(config) };
  } catch {
    return null; // No AKM_BUNDLE_DIR and no usable default bundle: writes need an explicit target.
  }
}

interface ConfigEntry {
  path: string;
  value: unknown;
  /** `default`, `file` (this install's config.json) or `extends:<ref>`; `null` when the key cannot be traced. */
  source: string | null;
}

/** Flatten to dotted leaf paths. Arrays and empty objects are leaves, matching how config layers merge. */
function configLeaves(value: unknown, prefix: string[], out: Array<{ path: string[]; value: unknown }>): void {
  if (value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length > 0) {
    for (const [key, child] of Object.entries(value)) configLeaves(child, [...prefix, key], out);
    return;
  }
  out.push({ path: prefix, value });
}

export function get() {
  const live = loadConfig();
  const effective = redactForUi(listConfig(live)) as Record<string, unknown>;
  const leaves: Array<{ path: string[]; value: unknown }> = [];
  configLeaves(effective, [], leaves);
  const entries: ConfigEntry[] = leaves.map(({ path, value }) => ({
    path: path.join("."),
    value,
    source: configSource(path),
  }));
  const named = (entries: unknown) =>
    Object.entries((entries ?? {}) as Record<string, unknown>).map(([name, entry]) => ({
      name,
      ...(entry as Record<string, unknown>),
    }));
  const env = Object.keys(process.env)
    .filter((name) => name.startsWith("AKM_"))
    .sort()
    .map((name) => ({ name, value: isSecretEnvName(name) ? "[redacted]" : (process.env[name] ?? "") }));
  const configPath = getConfigPath();
  return {
    path: configPath,
    exists: fs.existsSync(configPath),
    config: effective,
    automaticWriteTarget: automaticWriteTarget(live),
    entries,
    connections: named(effective.connections),
    harnesses: named(effective.harnesses),
    env,
  };
}

/**
 * Set and unset config keys through the same validated path as `akm config set` / `unset`: each value is coerced
 * and checked against the schema, literal API keys are refused, and the whole file is validated before one atomic
 * write. An unset the CLI refuses (`assertUnsettable`) or skips (no config file) is refused or skipped here too.
 */
export function change(input: { set?: Record<string, string>; unset?: string[] }) {
  const set = input.set ?? {};
  const unset = input.unset ?? [];
  if (typeof set !== "object" || Array.isArray(set)) throw new UsageError("set must be an object of config keys.");
  if (!Array.isArray(unset) || unset.some((key) => typeof key !== "string" || !key.trim()))
    throw new UsageError("unset must be a list of config keys.");
  for (const [key, value] of Object.entries(set)) {
    if (!key.trim()) throw new UsageError("Config keys must not be empty.");
    if (typeof value !== "string")
      throw new UsageError(`The value for ${key} must be a string, as on the command line.`);
  }
  if (Object.keys(set).length === 0 && unset.length === 0) return { saved: false };
  const result = mutateConfig(
    (current) => {
      let updated = current;
      for (const [key, value] of Object.entries(set)) updated = setConfigValue(updated, key, value);
      for (const key of unset) {
        assertUnsettable(key);
        updated = unsetConfigValue(updated, key);
      }
      if (updated !== current) preserveUnrelatedConfig(current);
      return updated;
    },
    // With no config file there is nothing to unset; a set still has to create it.
    { absentNoop: Object.keys(set).length === 0 },
  );
  resetConfigCache();
  return { saved: result.written };
}
