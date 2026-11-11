// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Desktop presentation only. This must never modify AKM's own configuration.
const file = path.join(
  process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"),
  "akm-desktop",
  "preferences.json",
);
export type Theme = "system" | "light" | "dark";
/** Which release line Desktop's own updater follows; absent means the stage of the embedded version. */
export type UpdateChannel = "stable" | "prerelease";
/** The npm/marketplace channel new harness plugins install from; absent means the stage of the embedded version. */
export type PluginChannel = "latest" | "next";
export interface Preferences {
  theme: Theme;
  updateChannel?: UpdateChannel;
  pluginChannel?: PluginChannel;
}
export function validTheme(value: unknown): value is Theme {
  return value === "system" || value === "light" || value === "dark";
}
export function validUpdateChannel(value: unknown): value is UpdateChannel {
  return value === "stable" || value === "prerelease";
}
export function validPluginChannel(value: unknown): value is PluginChannel {
  return value === "latest" || value === "next";
}
export async function readPreferences(): Promise<Preferences> {
  try {
    const value = JSON.parse(await readFile(file, "utf8"));
    return {
      theme: validTheme(value?.theme) ? value.theme : "system",
      ...(validUpdateChannel(value?.updateChannel) ? { updateChannel: value.updateChannel } : {}),
      ...(validPluginChannel(value?.pluginChannel) ? { pluginChannel: value.pluginChannel } : {}),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return { theme: "system" };
    throw error;
  }
}
let saving: Promise<unknown> = Promise.resolve();
/**
 * Merge `changes` into the saved preferences and write the file whole, atomically. Saves run one after another: the
 * rename keeps one file whole, but two overlapping read-merge-writes would drop one of their changes.
 */
export function savePreferences(changes: Partial<Preferences>): Promise<Preferences> {
  const result = saving.then(() => write(changes));
  saving = result.catch(() => undefined);
  return result;
}
async function write(changes: Partial<Preferences>): Promise<Preferences> {
  const next = { ...(await readPreferences()), ...changes };
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(next)}\n`, { mode: 0o600 });
  await rename(temporary, file);
  return next;
}
/** Saving a choice and applying it to the running app are separate results: the file is written either way. */
export async function tryApply(
  apply: () => Promise<void>,
): Promise<{ applied: true } | { applied: false; applyError: string }> {
  try {
    await apply();
    return { applied: true };
  } catch (error) {
    return { applied: false, applyError: error instanceof Error ? error.message : "Desktop service did not respond." };
  }
}
