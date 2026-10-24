// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * API keys akm holds for the user: `<configDir>/credentials.json`, a flat
 * `{ "<name>": "<key>" }` map (0600, in a 0700 directory), each key stored under
 * the name of the block it belongs to: a connection's name, `embedding`, or
 * `curateRerank`. A block whose `apiKey` is a `$VAR` reference reads that
 * variable and never touches this file. The bundle's `secrets/` store is for
 * secrets the user's own agents need and has nothing to do with these.
 */
import fs from "node:fs";
import path from "node:path";
import { isRecord, writeFileAtomic } from "../common";
import { ConfigError } from "../errors";
import { getConfigDir } from "../paths";
import { collectSensitiveValues } from "../redaction";
import { warnOnce } from "../warn";
import type { AkmConfig } from "./config-types";
import { envReferenceName } from "./schema/primitives";

function storePath(): string {
  return path.join(getConfigDir(), "credentials.json");
}

/** The stored keys; an absent file is empty and one that is not a JSON object is `undefined`. */
function readStore(): Record<string, string> | undefined {
  let text: string;
  try {
    text = fs.readFileSync(storePath(), "utf8");
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? {} : undefined;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? (parsed as Record<string, string>) : undefined;
  } catch {
    return undefined;
  }
}

function writeStore(store: Record<string, string>): void {
  fs.mkdirSync(path.dirname(storePath()), { recursive: true, mode: 0o700 });
  writeFileAtomic(storePath(), `${JSON.stringify(store, null, 2)}\n`, 0o600);
}

/** The key stored under `name`, if any. */
export function readCredential(name: string): string | undefined {
  const store = readStore();
  if (store === undefined) {
    warnOnce(`credentials:unreadable:${storePath()}`, `${storePath()} is not a JSON object of keys; ignoring it.`);
    return undefined;
  }
  return store[name] || undefined;
}

function writableStore(): Record<string, string> {
  const store = readStore();
  if (store === undefined) {
    throw new ConfigError(
      `${storePath()} is not a JSON object of keys; refusing to overwrite it.`,
      "INVALID_CONFIG_FILE",
    );
  }
  return store;
}

/** Store `value` under `name`, keeping every other key. */
export function writeCredential(name: string, value: string): void {
  writeStore({ ...writableStore(), [name]: value });
}

/** Remove the key stored under `name`. */
export function deleteCredential(name: string): void {
  const { [name]: _removed, ...rest } = writableStore();
  writeStore(rest);
}

/**
 * The key of the block named `name`, whose config `apiKey` is `apiKey`: the
 * variable it references, else `credentials.json[name]`. An unset variable is
 * named once and sends no key. `quiet` is for callers that only collect values to redact.
 */
export function resolveApiKey(
  apiKey: string | undefined,
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  quiet = false,
): string | undefined {
  const variable = apiKey === undefined ? undefined : envReferenceName(apiKey);
  if (variable === undefined) return readCredential(name);
  const value = env[variable]?.trim();
  if (!value && !quiet) {
    warnOnce(
      `credentials:env-unset:${variable}`,
      `Environment variable ${variable} referenced by an apiKey is unset or empty; requests are sent without a key.`,
    );
  }
  return value || undefined;
}

/** Every key the config can resolve now, for redaction. */
export function collectCredentialValues(config: AkmConfig, env: NodeJS.ProcessEnv = process.env): string[] {
  const keys = Object.entries(config.connections ?? {}).map(([name, c]) => resolveApiKey(c.apiKey, name, env, true));
  keys.push(
    resolveApiKey(config.embedding?.apiKey, "embedding", env, true),
    resolveApiKey(config.search?.curateRerank?.apiKey, "curateRerank", env, true),
  );
  return collectSensitiveValues(keys);
}
