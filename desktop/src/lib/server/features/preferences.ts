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
/** The saved file exists but cannot be used. `damaged` is a file that was read and is not a preferences object; otherwise it could not be read at all. */
export class PreferencesUnreadable extends Error {
  file = file;
  damaged: boolean;
  constructor(cause: unknown, damaged: boolean) {
    super(`${file} could not be read: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.damaged = damaged;
  }
}
/** The saved preferences, or `{ theme: "system" }` when none were saved yet. Throws {@link PreferencesUnreadable} for a file that is there but unusable. */
export async function readPreferences(): Promise<Preferences> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { theme: "system" };
    throw new PreferencesUnreadable(error, false);
  }
  try {
    const value = JSON.parse(text);
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Not an object.");
    return {
      theme: validTheme(value?.theme) ? value.theme : "system",
      ...(validUpdateChannel(value?.updateChannel) ? { updateChannel: value.updateChannel } : {}),
      ...(validPluginChannel(value?.pluginChannel) ? { pluginChannel: value.pluginChannel } : {}),
    };
  } catch (error) {
    throw new PreferencesUnreadable(error, true);
  }
}
/** What the views show: the saved preferences, or the defaults with `unreadable` saying which file could not be read and why. */
export async function preferencesView(): Promise<Preferences & { unreadable?: { file: string; error: string } }> {
  try {
    return await readPreferences();
  } catch (error) {
    if (!(error instanceof PreferencesUnreadable)) throw error;
    return { theme: "system", unreadable: { file: error.file, error: error.message } };
  }
}
let saving: Promise<unknown> = Promise.resolve();
/**
 * Merge `changes` into the saved preferences and write the file whole, atomically. Saves run one after another: the
 * rename keeps one file whole, but two overlapping read-merge-writes would drop one of their changes.
 */
export function savePreferences(changes: Partial<Preferences>): Promise<Preferences & { movedAside?: string }> {
  const result = saving.then(() => write(changes));
  saving = result.catch(() => undefined);
  return result;
}
/**
 * A damaged file is moved aside once, under a name that says so, before the first save writes a new one; a file that
 * cannot be read at all is left alone and the save fails with the reason.
 */
async function write(changes: Partial<Preferences>): Promise<Preferences & { movedAside?: string }> {
  let current: Preferences;
  let movedAside: string | undefined;
  try {
    current = await readPreferences();
  } catch (error) {
    if (!(error instanceof PreferencesUnreadable && error.damaged)) throw error;
    movedAside = `${file}.unreadable-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    await rename(file, movedAside);
    current = { theme: "system" };
  }
  const next = { ...current, ...changes };
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(next)}\n`, { mode: 0o600 });
  await rename(temporary, file);
  return movedAside ? { ...next, movedAside } : next;
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
