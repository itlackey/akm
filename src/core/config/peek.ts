// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Read one value from the selected config file without loading the config.
 *
 * For the few settings read before (or beneath) the config load: CLI usage
 * capture runs before config is read, and SQLite opens apply the journal mode.
 * It reads only the file itself (no `extends` chain, no schema), and any
 * failure, a missing or broken file included, yields `undefined` so the caller
 * falls back to its default. It never throws and never warns.
 */
import { getConfigPath } from "../paths";
import { parseConfigText, readConfigText } from "./config-io";

export function peekConfigValue(keys: readonly string[], env: NodeJS.ProcessEnv = process.env): unknown {
  try {
    const text = readConfigText(getConfigPath(env));
    if (text === undefined) return undefined;
    let value: unknown = parseConfigText(text);
    for (const key of keys) {
      if (typeof value !== "object" || value === null) return undefined;
      value = (value as Record<string, unknown>)[key];
    }
    return value;
  } catch {
    return undefined;
  }
}
