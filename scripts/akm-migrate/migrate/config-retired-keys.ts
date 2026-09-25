// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Retired config-key removal, as an `akm migrate` concern.
 *
 * `stripRetiredConfigKeys` (`src/core/config/retired-config-keys-shim.ts`,
 * driven by `RETIRED_CONFIG_KEYS` in `src/core/config/retired-keys.ts`)
 * tolerates every registered `"ignored"` retired key — top-level
 * (`agent`, `llm`, `profiles`, ...) or nested (`experimental.workflowEngine`)
 * — in memory on every load, so a config an older install wrote keeps
 * working. This is the on-disk counterpart, in the same one-time-migration
 * shape as `./config-extra-params.ts`: `akm migrate apply` removes every
 * present retired path from `config.json` once, with the usual backup, so
 * the in-memory warning goes away for good. Generalized from the
 * `experimental.*`-only `config-retired-experimental-keys.ts` — the warning
 * named `akm migrate apply` as the fix for every retired key, but the
 * migrator only ever cleaned up `experimental.*`, so the warning could never
 * be cleared for a top-level retired key like `llm` or `profiles`.
 *
 * Reuses `retiredConfigKeysIn`/`withoutRetiredConfigKeys` from the shim
 * instead of a second path walker, so there is exactly one implementation
 * of "find/remove a registered retired path" shared by the read shim and
 * this migrator.
 */

import {
  acquireConfigLock,
  backupExistingConfig,
  parseConfigText,
  readConfigText,
  writeConfigAtomic,
} from "../../../src/core/config/config-io";
import { retiredConfigKeysIn, withoutRetiredConfigKeys } from "../../../src/core/config/retired-config-keys-shim";

export interface ConfigRetiredKeysPlan {
  /** One dotted path (e.g. `"llm"`, `"experimental.workflowEngine"`) per retired key that would be removed. */
  removed: string[];
}

function readRawConfig(configPath: string): Record<string, unknown> | undefined {
  const text = readConfigText(configPath);
  if (text === undefined) return undefined;
  return parseConfigText(text, configPath);
}

/**
 * Read-only: which registered retired config keys `akm migrate apply` would
 * remove from `config.json`. Never touches disk. Returns an empty plan when
 * the config file does not exist or carries none.
 */
export function findConfigRetiredKeys(configPath: string): ConfigRetiredKeysPlan {
  const raw = readRawConfig(configPath);
  if (!raw) return { removed: [] };
  return { removed: retiredConfigKeysIn(raw) };
}

export interface ConfigRetiredKeysResult extends ConfigRetiredKeysPlan {
  applied: boolean;
}

/**
 * Persist removal of every registered retired config key from
 * `config.json`, once, with the usual backup. A no-op (and no backup) when
 * there is nothing to remove.
 */
export function applyConfigRetiredKeys(configPath: string): ConfigRetiredKeysResult {
  const raw = readRawConfig(configPath);
  if (!raw) return { applied: false, removed: [] };
  const retired = retiredConfigKeysIn(raw);
  if (retired.length === 0) return { applied: false, removed: [] };

  const config = withoutRetiredConfigKeys(raw, retired);

  const release = acquireConfigLock();
  try {
    backupExistingConfig(configPath);
    writeConfigAtomic(configPath, config);
  } finally {
    release();
  }
  return { applied: true, removed: retired };
}
