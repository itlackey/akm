// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** The effective config the owner can read, and the validated changes they can make to it. */

import fs from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { assertUnsettable, listConfig, setConfigValue, unsetConfigValue } from "../commands/config-cli";
import { isRecord } from "../core/common";
import { type AkmConfig, loadConfig, mutateConfig, resetConfigCache } from "../core/config/config";
import { parseConfigText, readConfigText } from "../core/config/config-io";
import { dropUnusableProjects, NO_PROJECT, type ProjectConfig } from "../core/config/schema/projects";
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

/** Names that would reach Object.prototype when used as a key. */
const UNSAFE_NAMES = new Set(["__proto__", "constructor", "prototype"]);

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

/**
 * What akm says about the malformed parts of `projects` in this install's config file, in its own words, and the
 * names of the projects that file holds (the others are only inherited).
 */
function localProjects(configPath: string): { warnings: string[]; local: string[]; raw: Record<string, unknown> } {
  const warnings: string[] = [];
  let local: string[] = [];
  let raw: Record<string, unknown> = {};
  try {
    const text = readConfigText(configPath);
    if (text !== undefined) {
      const file = parseConfigText(text, configPath);
      if (isRecord(file.projects)) raw = file.projects;
      const kept = dropUnusableProjects(file, configPath, (_key, message) => warnings.push(message)).projects;
      local = isRecord(kept) ? Object.keys(kept) : [];
    }
  } catch {
    // An unreadable file fails the read above, not this one.
  }
  return { warnings, local, raw };
}

export function get() {
  const live = loadConfig();
  const effective = redactForUi(listConfig(live)) as Record<string, unknown>;
  // Projects hold no credentials; redaction would turn a value such as `filters.env` into "[redacted]" and a save would write that back.
  if (live.projects) effective.projects = live.projects;
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
  const projects = localProjects(configPath);
  return {
    path: configPath,
    projectWarnings: projects.warnings,
    localProjects: projects.local,
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

/**
 * Add, replace, rename (set the new name and unset the old) and remove `projects` entries in one atomic write.
 * Each entry is a whole project, written as sent (the reader takes a project whole by name); the complete config is
 * validated as for `change`, so akm's schema decides what is accepted. Names are not dotted config keys, so a name
 * may contain a dot. A project this install's config.json does not hold (inherited, or one akm ignores) cannot be
 * unset or renamed here, as `akm config unset` refuses a key it cannot remove.
 */
export function changeProjects(input: { set?: Record<string, ProjectConfig>; unset?: string[] }) {
  const set = input.set ?? {};
  const unset = input.unset ?? [];
  if (!isRecord(set) || Object.values(set).some((project) => !isRecord(project)))
    throw new UsageError("set must be an object of project names to project objects.");
  if (!Array.isArray(unset) || unset.some((name) => typeof name !== "string"))
    throw new UsageError("unset must be a list of project names.");
  for (const name of Object.keys(set)) {
    if (!name.trim() || name === NO_PROJECT || UNSAFE_NAMES.has(name))
      throw new UsageError(`"${name}" cannot name a project.`);
  }
  if (Object.keys(set).length === 0 && unset.length === 0) return { saved: false };
  const { local: held, raw } = localProjects(getConfigPath());
  for (const name of unset) {
    if (!held.includes(name))
      throw new UsageError(
        `Project "${name}" is not in ${getConfigPath()}, so it cannot be removed or renamed here.`,
        "TARGET_NOT_UPDATABLE",
        "It is inherited from an extended config, or akm ignores it: edit the file that holds it.",
      );
  }
  // A set is a no-op only when the file already holds exactly that entry, whatever akm makes of the file's own.
  const writeProjects = Object.keys(set).filter((name) => !isDeepStrictEqual(raw[name], set[name]));
  if (writeProjects.length === 0 && unset.length === 0) return { saved: false };
  const result = mutateConfig(
    (current) => {
      const projects: Record<string, ProjectConfig> = { ...current.projects };
      for (const name of unset) delete projects[name];
      Object.assign(projects, set);
      preserveUnrelatedConfig(current);
      return { ...current, projects };
    },
    { absentNoop: Object.keys(set).length === 0, writeProjects },
  );
  resetConfigCache();
  return { saved: result.written };
}
