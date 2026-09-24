// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Retired `experimental.*` key removal, as an `akm migrate` concern.
 *
 * `stripRetiredExperimentalKeys`
 * (`src/core/config/retired-experimental-keys-shim.ts`) tolerates a retired
 * key like `experimental.workflowEngine` in memory on every load, so a
 * config a 0.9.15 install wrote keeps working on 0.9.16+. This is the
 * on-disk counterpart, in the same one-time-migration shape as
 * `./config-extra-params.ts`: `akm migrate apply` removes the key from
 * `config.json` once, with the usual backup, so the in-memory warning goes
 * away for good.
 */

import {
  acquireConfigLock,
  backupExistingConfig,
  parseConfigText,
  readConfigText,
  writeConfigAtomic,
} from "../../../src/core/config/config-io";
import { RETIRED_EXPERIMENTAL_KEYS } from "../../../src/core/config/retired-experimental-keys-shim";

export interface ConfigRetiredExperimentalKeysPlan {
  /** One `experimental.<key>` entry per retired key that would be removed. */
  removed: string[];
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readRawConfig(configPath: string): Record<string, unknown> | undefined {
  const text = readConfigText(configPath);
  if (text === undefined) return undefined;
  return parseConfigText(text, configPath);
}

function retiredKeysPresent(raw: Record<string, unknown>): string[] {
  if (!isPlainRecord(raw.experimental)) return [];
  const experimental = raw.experimental;
  return RETIRED_EXPERIMENTAL_KEYS.filter((key) => key in experimental);
}

/**
 * Read-only: which retired `experimental.*` keys `akm migrate apply` would
 * remove from `config.json`. Never touches disk. Returns an empty plan when
 * the config file does not exist or carries none.
 */
export function findConfigRetiredExperimentalKeys(configPath: string): ConfigRetiredExperimentalKeysPlan {
  const raw = readRawConfig(configPath);
  if (!raw) return { removed: [] };
  return { removed: retiredKeysPresent(raw).map((key) => `experimental.${key}`) };
}

export interface ConfigRetiredExperimentalKeysResult extends ConfigRetiredExperimentalKeysPlan {
  applied: boolean;
}

/**
 * Persist removal of retired `experimental.*` keys from `config.json`, once,
 * with the usual backup. A no-op (and no backup) when there is nothing to
 * remove.
 */
export function applyConfigRetiredExperimentalKeys(configPath: string): ConfigRetiredExperimentalKeysResult {
  const raw = readRawConfig(configPath);
  if (!raw) return { applied: false, removed: [] };
  const retired = retiredKeysPresent(raw);
  if (retired.length === 0) return { applied: false, removed: [] };

  const experimental = { ...(raw.experimental as Record<string, unknown>) };
  for (const key of retired) delete experimental[key];
  const config = { ...raw, experimental };

  const release = acquireConfigLock();
  try {
    backupExistingConfig(configPath);
    writeConfigAtomic(configPath, config);
  } finally {
    release();
  }
  return { applied: true, removed: retired.map((key) => `experimental.${key}`) };
}
