/**
 * `akm config validate` — verify the on-disk config matches the schema.
 *
 * Reads the user config file, validates against AkmConfigSchema, and either
 * prints "All checks passed." or a list of structured errors (path + message).
 * Exits non-zero on errors so it composes well in CI hooks.
 */
import fs from "node:fs";
import { parseConfigText } from "../core/config-io";
import { validateConfigShape } from "../core/config-schema";
import { ConfigError } from "../core/errors";
import { getConfigPath } from "../core/paths";

export async function runConfigValidate(): Promise<void> {
  const configPath = getConfigPath();

  if (!fs.existsSync(configPath)) {
    console.log(`No config file at ${configPath} — nothing to validate.`);
    return;
  }

  let text: string;
  try {
    text = fs.readFileSync(configPath, "utf8");
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new ConfigError(`Could not read config at ${configPath}: ${detail}`, "INVALID_CONFIG_FILE");
  }

  // parseConfigText throws ConfigError on malformed JSON (#458). Surface as-is.
  const raw = parseConfigText(text, configPath);

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
