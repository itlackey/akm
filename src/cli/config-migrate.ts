// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { parseConfigText, readConfigText } from "../core/config/config-io";
import { CURRENT_CONFIG_VERSION, validateConfigShape } from "../core/config/config-schema";
import { ConfigError } from "../core/errors";
import { getConfigPath } from "../core/paths";

const MANUAL_GUIDANCE =
  "AKM 0.9 does not translate profile-based configuration. Recreate named engines, defaults.engine/defaults.llmEngine, and improve.strategies manually before retrying.";

/**
 * Diagnose the user config without loading runtime configuration or mutating
 * disk. Profile-to-engine conversion is intentionally ambiguous and never
 * happens automatically.
 */
export async function runConfigMigrate(): Promise<void> {
  const configPath = getConfigPath();
  let text: string | undefined;
  try {
    text = readConfigText(configPath);
  } catch (error) {
    throw new ConfigError(
      `Could not read config at ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
      "INVALID_CONFIG_FILE",
    );
  }
  if (text === undefined) {
    console.log(JSON.stringify({ status: "absent", path: configPath }));
    return;
  }

  let raw: unknown;
  try {
    raw = parseConfigText(text, configPath);
  } catch (error) {
    throw new ConfigError(
      `Invalid config file at ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
      "INVALID_CONFIG_FILE",
    );
  }
  const version = (raw as { configVersion?: unknown }).configVersion;
  if (version !== CURRENT_CONFIG_VERSION) {
    throw new ConfigError(
      `Unsupported configVersion at ${configPath}: expected "${CURRENT_CONFIG_VERSION}".`,
      "UNSUPPORTED_CONFIG_VERSION",
      MANUAL_GUIDANCE,
    );
  }
  const result = validateConfigShape(raw);
  if (!result.ok) {
    throw new ConfigError(
      `Invalid config at ${configPath}: ${result.errors.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`,
      "INVALID_CONFIG_FILE",
    );
  }
  console.log(JSON.stringify({ status: "current", path: configPath }));
}
