// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Legacy `stashDir`/`sources[]`/`installed` -> `bundles`/`defaultBundle`
 * conversion, as an `akm migrate` concern.
 *
 * `migrateLegacySourceShape` (`src/core/config/legacy-source-shape-shim.ts`)
 * already folds this shape in memory on every load and warns that
 * `akm migrate apply` will rewrite the file — advice that had no on-disk
 * counterpart: the retired-keys step (`./config-retired-keys.ts`) leaves
 * these keys alone because the registry marks them `"lifted"`, and no other
 * step wrote the conversion back. This is that counterpart, in the same
 * one-time-migration shape as `./config-extra-params.ts`: persist
 * the conversion the shim's pure `convertLegacySourceShape` already computes
 * once, with the usual backup, so the read shim's warning becomes true and
 * stops recurring. There is no second converter here — this calls the
 * shim's exported `convertLegacySourceShape` for both the plan and the
 * write (never `migrateLegacySourceShape`, which also warns).
 */

import {
  acquireConfigLock,
  backupExistingConfig,
  parseConfigText,
  readConfigText,
  writeConfigAtomic,
} from "../../../src/core/config/config-io";
import { convertLegacySourceShape } from "../../../src/core/config/legacy-source-shape-shim";

export interface ConfigLegacySourceShapePlan {
  /** Legacy keys that would be converted (folded into `bundles`/`defaultBundle`, or dropped for `installed`). */
  converted: string[];
}

function readRawConfig(configPath: string): Record<string, unknown> | undefined {
  const text = readConfigText(configPath);
  if (text === undefined) return undefined;
  return parseConfigText(text, configPath);
}

/**
 * Read-only: what `akm migrate apply` would convert in `config.json`'s
 * legacy `stashDir`/`sources[]`/`installed` shape. Never touches disk.
 * Returns an empty plan when the config file does not exist or carries
 * none of the legacy shape.
 */
export function findConfigLegacySourceShape(configPath: string): ConfigLegacySourceShapePlan {
  const raw = readRawConfig(configPath);
  if (!raw) return { converted: [] };
  return { converted: convertLegacySourceShape(raw).converted };
}

export interface ConfigLegacySourceShapeResult extends ConfigLegacySourceShapePlan {
  applied: boolean;
}

/**
 * Persist the legacy `stashDir`/`sources[]`/`installed` -> `bundles`/
 * `defaultBundle` conversion to `config.json`, once, with the usual backup.
 * A no-op (and no backup) when the config carries none of the legacy shape.
 */
export function applyConfigLegacySourceShape(configPath: string): ConfigLegacySourceShapeResult {
  const raw = readRawConfig(configPath);
  if (!raw) return { applied: false, converted: [] };
  const { config: migrated, converted } = convertLegacySourceShape(raw);
  if (converted.length === 0) return { applied: false, converted: [] };

  const release = acquireConfigLock();
  try {
    backupExistingConfig(configPath);
    writeConfigAtomic(configPath, migrated);
  } finally {
    release();
  }
  return { applied: true, converted };
}
