// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Where each OpenCode major installs the akm plugin (#1049). `akm upgrade`
 * (`commands/sources/plugin-upgrade.ts`) refreshes these caches and `akm health`
 * (`commands/health/plugin-staleness.ts`) reads the akm-cli bundled in them, so
 * the layout is written down once, here.
 *
 * OpenCode 1 and OpenCode 2 share `~/.config/opencode` and `~/.cache/opencode`
 * but lay both out differently, and each major only loads its own package, so a
 * host is handled per flavor and a flavor never touches the other's package,
 * cache or config entry.
 */

import fs from "node:fs";
import path from "node:path";
import { tryParseJson } from "../../../core/common";
import type { PluginHarness } from "../../../sources/types";

export interface OpenCodeFlavor {
  harness: Extract<PluginHarness, "opencode" | "opencode-v2">;
  /** The npm package (and the name OpenCode uses in its config and cache). */
  pkg: "akm-opencode" | "akm-opencode-v2";
  /** The OpenCode major whose binary can re-create this plugin's cache. */
  major: 1 | 2;
  /** Config keys that name plugins, in the order they are read. */
  configKeys: readonly string[];
  /**
   * Read only the global config files. OpenCode 2's re-fetch is `opencode plugin add`, which writes
   * the global config, so it is only run for a spec that file already names.
   */
  globalConfigOnly: boolean;
  /** Where the cache of a spec (`<pkg>@<tag>`) lives under `<cacheHome>/opencode`. */
  cacheFolder: (spec: string) => string;
  /** The `node_modules` holding the installed plugin and its bundled akm-cli, inside a cache folder. */
  nodeModulesDir: (folder: string) => string | undefined;
  /** The `opencode` arguments that make it re-create the cache of `spec`, after that cache was moved away. */
  prefetch: (spec: string) => string[];
}

/** The newest numbered build folder (`<epoch-ms>`) under an OpenCode 2 cache folder. */
export function newestBuildDir(folder: string): string | undefined {
  try {
    const builds = fs.readdirSync(folder).filter((name) => /^\d+$/.test(name));
    builds.sort((a, b) => Number(b) - Number(a));
    return builds[0] ? path.join(folder, builds[0]) : undefined;
  } catch {
    return undefined;
  }
}

/** A package.json's `version`, or undefined when the file is missing, unreadable or has none. */
export function readPackageVersion(file: string): string | undefined {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  const pkg = tryParseJson(text) as { version?: unknown } | undefined;
  return typeof pkg?.version === "string" ? pkg.version : undefined;
}

export const OPENCODE_V1: OpenCodeFlavor = {
  harness: "opencode",
  pkg: "akm-opencode",
  major: 1,
  configKeys: ["plugin"],
  globalConfigOnly: false,
  // OpenCode 1: <cache>/opencode/packages/<spec>/node_modules/<pkg>
  cacheFolder: (spec) => path.join("packages", spec),
  nodeModulesDir: (folder) => path.join(folder, "node_modules"),
  // Any OpenCode command that resolves the config installs the plugin again.
  prefetch: () => ["debug", "config"],
};

export const OPENCODE_V2: OpenCodeFlavor = {
  harness: "opencode-v2",
  pkg: "akm-opencode-v2",
  major: 2,
  // OpenCode 2.0.26 reads both keys; its own `plugin add` writes `plugins`.
  configKeys: ["plugins", "plugin"],
  globalConfigOnly: true,
  // OpenCode 2: <cache>/opencode/npm/<spec>/<epoch-ms>/node_modules/<pkg>
  cacheFolder: (spec) => path.join("npm", spec),
  nodeModulesDir: (folder) => {
    const build = newestBuildDir(folder);
    return build ? path.join(build, "node_modules") : undefined;
  },
  // `debug config` does not resolve plugins in OpenCode 2; `plugin add` of a configured spec only reinstalls it.
  prefetch: (spec) => ["plugin", "add", spec],
};
