// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `binary-config-skew` advisory for `akm health`: warn when config.json
 * carries a `configVersion` NEWER than (or unorderable against) this binary's
 * CURRENT_CONFIG_VERSION — a newer akm wrote the shared config, so this
 * install is stale. That is the proven multi-install incident class. Silent
 * for current or older versions and for unreadable configs (config loading
 * reports its own errors).
 */

import { readTextFile } from "../../core/common";
import { CURRENT_CONFIG_VERSION } from "../../core/config/config-schema";
import { compareConfigVersion } from "../../core/config/config-version";
import type { HealthCheckResult } from "./types";

export function collectConfigSkewAdvisory(configPath: string): HealthCheckResult | undefined {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readTextFile(configPath, "Config file")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const onDisk = raw.configVersion as string | number | undefined;
  const order = compareConfigVersion(onDisk, CURRENT_CONFIG_VERSION);
  const skewed = order === 1 || (onDisk !== undefined && order === undefined);
  if (!skewed) return undefined;
  return {
    name: "binary-config-skew",
    kind: "deterministic",
    status: "warn",
    confidence: "high",
    message:
      `config.json has configVersion ${JSON.stringify(onDisk)} but this binary knows ${CURRENT_CONFIG_VERSION} — ` +
      "a newer akm wrote the shared config, so this install is stale. Upgrade this install; do not keep a stale " +
      "binary against the shared config/DBs.",
    evidence: { onDiskConfigVersion: onDisk, binaryConfigVersion: CURRENT_CONFIG_VERSION },
  };
}
