/**
 * Pure I/O helpers for AKM config files.
 *
 * No knowledge of the AkmConfig shape — these functions just read JSON(C) text
 * from disk and write JSON text back atomically. Validation and migration live
 * in `./config.ts` and `./config-migrate.ts`.
 *
 * Split out so the load path is testable without touching the filesystem
 * (`parseConfigText` is pure), and so a single atomic write path serves
 * `saveConfig`, the migrate command, and the setup wizard (#464.c).
 */
import fs from "node:fs";
import { writeFileAtomic } from "./common";
import { ConfigError } from "./errors";

/**
 * Read the raw text of a config file. Returns `undefined` when the file does
 * not exist (legitimate cold-start). Other I/O errors propagate.
 */
export function readConfigText(configPath: string): string | undefined {
  try {
    return fs.readFileSync(configPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

/**
 * Parse JSON(C) config text into a plain object. Strips `//` and `/* *​/`
 * comments before parsing.
 *
 * Throws {@link ConfigError} when the text is unparseable or when the root is
 * not a JSON object. Per #458, malformed config text is NOT silently rescued —
 * the caller must surface the parse error.
 */
export function parseConfigText(text: string, sourcePath?: string): Record<string, unknown> {
  const stripped = stripJsonComments(text);
  const where = sourcePath ? ` at ${sourcePath}` : "";

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new ConfigError(
      `Failed to parse config JSON${where}: ${detail}`,
      "INVALID_CONFIG_FILE",
      "Edit the file to fix the JSON syntax error. Comments (// and /* */) are allowed; trailing commas are not.",
    );
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ConfigError(
      `Config file${where} must contain a JSON object at the root, got ${describeJsonRoot(parsed)}.`,
      "INVALID_CONFIG_FILE",
    );
  }

  return parsed as Record<string, unknown>;
}

function describeJsonRoot(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  if (typeof value === "string") return "a string";
  if (typeof value === "number") return "a number";
  if (typeof value === "boolean") return "a boolean";
  return typeof value;
}

/**
 * Atomically write a config object to disk as pretty-printed JSON. Routes
 * through {@link writeFileAtomic} so partial writes can never corrupt the
 * config file (#464.c).
 */
export function writeConfigAtomic(configPath: string, config: Record<string, unknown>): void {
  writeFileAtomic(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

/**
 * Strip JavaScript-style comments from a JSON string (JSONC support).
 * Handles `//` line comments and `/* *​/` block comments while preserving
 * comment-like sequences inside quoted strings.
 */
export function stripJsonComments(text: string): string {
  let result = "";
  let i = 0;
  let inString = false;
  while (i < text.length) {
    if (inString) {
      if (text[i] === "\\") {
        result += text[i] + (text[i + 1] ?? "");
        i += 2;
        continue;
      }
      if (text[i] === '"') {
        inString = false;
      }
      result += text[i];
      i++;
      continue;
    }
    if (text[i] === '"') {
      inString = true;
      result += text[i];
      i++;
      continue;
    }
    if (text[i] === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (text[i] === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    result += text[i];
    i++;
  }
  return result;
}
