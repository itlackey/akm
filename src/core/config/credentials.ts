// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * API keys akm holds for the user: `<configDir>/credentials.json`, a flat
 * `{ "<name>": "<key>" }` map (0600, in a 0700 directory). A key is stored under
 * the name of the block it belongs to: a connection's name, `embedding`, or
 * `curateRerank`. A block whose `apiKey` is a `$VAR` reference reads that
 * variable instead and never touches this file. The bundle's `secrets/` store is
 * for secrets the user's own agents need and has nothing to do with these.
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

/** Where a block's key is read from, decided from its config alone; nothing is read to decide it. */
export type CredentialSource = { readonly env: string } | { readonly credential: string };

export function credentialsPath(): string {
  return path.join(getConfigDir(), "credentials.json");
}

function readStore(): Record<string, string> | undefined {
  let text: string;
  try {
    text = fs.readFileSync(credentialsPath(), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) return undefined;
    return Object.fromEntries(Object.entries(parsed).filter(([, value]) => typeof value === "string")) as Record<
      string,
      string
    >;
  } catch {
    return undefined;
  }
}

/** The key stored under `name`, or `undefined` when there is none or the file cannot be read. */
export function readCredential(name: string): string | undefined {
  const store = readStore();
  if (store === undefined) {
    warnOnce(
      `credentials:unreadable:${credentialsPath()}`,
      `${credentialsPath()} is not a JSON object of keys; its keys are ignored. Fix or remove the file, or run \`akm setup\`.`,
    );
    return undefined;
  }
  const value = store[name];
  return value !== undefined && value.length > 0 ? value : undefined;
}

function writeStore(store: Record<string, string>): void {
  const file = credentialsPath();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileAtomic(file, `${JSON.stringify(store, null, 2)}\n`, 0o600);
}

function requireStore(): Record<string, string> {
  const store = readStore();
  if (store === undefined) {
    throw new ConfigError(
      `${credentialsPath()} is not a JSON object of keys; refusing to overwrite it.`,
      "INVALID_CONFIG_FILE",
      "Fix or remove the file, then retry.",
    );
  }
  return store;
}

/** Store `value` under `name`, keeping every other key. */
export function writeCredential(name: string, value: string): void {
  writeStore({ ...requireStore(), [name]: value });
}

/** Remove the key stored under `name`; a name with none is left alone. */
export function deleteCredential(name: string): void {
  const store = requireStore();
  if (!(name in store)) return;
  const { [name]: _removed, ...rest } = store;
  writeStore(rest);
}

/** Where the key of the block named `name` comes from: its `$VAR` reference, else `credentials.json`. */
export function credentialSource(apiKey: string | undefined, name: string): CredentialSource {
  const variable = apiKey === undefined ? undefined : envReferenceName(apiKey);
  return variable === undefined ? { credential: name } : { env: variable };
}

/**
 * The key `source` names, read now. An unset variable is named once and sends
 * no key; so does a name `credentials.json` has nothing for. `quiet` skips the
 * warning for callers that only collect values to redact.
 */
export function readCredentialSource(
  source: CredentialSource,
  env: NodeJS.ProcessEnv = process.env,
  quiet = false,
): string | undefined {
  if ("credential" in source) return readCredential(source.credential);
  const value = env[source.env]?.trim();
  if (value) return value;
  if (!quiet) {
    warnOnce(
      `credentials:env-unset:${source.env}`,
      `Environment variable ${source.env} referenced by an apiKey is unset or empty; requests are sent without a key.`,
    );
  }
  return undefined;
}

/** The key of the block named `name`, whose config `apiKey` is `apiKey`. */
export function resolveApiKey(
  apiKey: string | undefined,
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return readCredentialSource(credentialSource(apiKey, name), env);
}

/** Every key the config can resolve now, for redaction. A block that cannot resolve one is skipped. */
export function collectCredentialValues(config: AkmConfig, env: NodeJS.ProcessEnv = process.env): string[] {
  const values: (string | undefined)[] = Object.entries(config.connections ?? {}).map(([name, connection]) =>
    readCredentialSource(credentialSource(connection.apiKey, name), env, true),
  );
  values.push(
    readCredentialSource(credentialSource(config.embedding?.apiKey, "embedding"), env, true),
    readCredentialSource(credentialSource(config.search?.curateRerank?.apiKey, "curateRerank"), env, true),
  );
  return collectSensitiveValues(values);
}
