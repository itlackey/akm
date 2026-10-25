// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The user's `models.json` (retired): `<configDir>/models.json`, an alias to
 * model table per engine. It is read, in memory, as part of the conversion of
 * the `engines` form ({@link convertEngineConfig}); `akm migrate apply` moves it
 * out of the config directory once its aliases are folded into the config.
 */
import fs from "node:fs";
import path from "node:path";
import { getCacheDir, getConfigDir } from "../paths";

function modelsFilePath(): string {
  return path.join(getConfigDir(), "models.json");
}

/** The user's `models.json`, parsed; absent or unreadable is no overlay. */
export function readModelsFile(): unknown {
  try {
    return JSON.parse(fs.readFileSync(modelsFilePath(), "utf8"));
  } catch {
    return undefined;
  }
}

export function modelsFileExists(): boolean {
  return fs.existsSync(modelsFilePath());
}

/** Move `models.json` to `<cacheDir>/config-backups/models.json.<timestamp>` and return where it went. */
export function retireModelsFile(now = new Date()): string {
  const backupDir = path.join(getCacheDir(), "config-backups");
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const target = path.join(backupDir, `models.json.${now.toISOString().replace(/[.:]/g, "-")}`);
  fs.copyFileSync(modelsFilePath(), target, fs.constants.COPYFILE_EXCL);
  fs.rmSync(modelsFilePath());
  return target;
}
