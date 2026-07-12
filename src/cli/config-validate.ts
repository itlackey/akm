// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm config validate` — verify the on-disk config matches the schema.
 *
 * Reads the user config file, validates against AkmConfigSchema, and either
 * prints "All checks passed." or a list of structured errors (path + message).
 * Exits non-zero on errors so it composes well in CI hooks.
 */
import { parseConfigText, readConfigText } from "../core/config/config-io";
import { CURRENT_CONFIG_VERSION, validateConfigShape } from "../core/config/config-schema";
import { ConfigError } from "../core/errors";
import { getConfigPath } from "../core/paths";

export async function runConfigValidate(): Promise<void> {
  const configPath = getConfigPath();

  let text: string | undefined;
  try {
    text = readConfigText(configPath);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new ConfigError(`Could not read config at ${configPath}: ${detail}`, "INVALID_CONFIG_FILE");
  }
  if (text === undefined) {
    console.log(`No config file at ${configPath} — nothing to validate.`);
    return;
  }

  // parseConfigText throws ConfigError on malformed JSON (#458). Surface as-is.
  const raw = parseConfigText(text, configPath);
  if (raw.configVersion !== CURRENT_CONFIG_VERSION) {
    throw new ConfigError(
      `Unsupported configVersion at ${configPath}: expected "${CURRENT_CONFIG_VERSION}".`,
      "UNSUPPORTED_CONFIG_VERSION",
      "Recreate engines and improve.strategies manually; AKM 0.9 never translates profile-based configuration.",
    );
  }

  const result = validateConfigShape(raw);
  if (result.ok) {
    console.log(`All checks passed. (${configPath})`);
    return;
  }

  const lines = result.errors.map((e) => `  - ${e.path || "(root)"}: ${e.message}`).join("\n");
  throw new ConfigError(
    `Config at ${configPath} has ${result.errors.length} validation error${result.errors.length === 1 ? "" : "s"}:\n${lines}`,
    "INVALID_CONFIG_FILE",
    "Fix the listed fields, or run `akm config migrate` if the errors look like legacy-shape leftovers.",
  );
}
