// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The state the fake store clients share with the test that started them: one
 * JSON file, named by `AKM_FAKE_STORE_STATE`, that each client reads and
 * rewrites, and a log of every command line it was given.
 */

import fs from "node:fs";

export interface FakeKeyringItem {
  path: string;
  label: string;
  attributes: Record<string, string>;
  secret: string;
}

export interface FakeStoreState {
  /** Secret Service keyrings by name, each a list of items. */
  keyrings: Record<string, FakeKeyringItem[]>;
  /** Azure Key Vaults by name, each a map of secret name to value. */
  vaults: Record<string, Record<string, string>>;
  /** Names of keyrings that are locked: their `Items` read as empty, as KWallet's does. */
  locked?: string[];
  /** Keyrings whose unlock prompt the user dismisses: they stay locked. */
  unlockDenied?: string[];
  /** A keyring's label, by name: default, its name. */
  labels?: Record<string, string>;
  /** Keyrings with no alias of their own name (default: every keyring is the alias of its name). */
  unaliased?: string[];
  /** Whether `SetAlias` takes any alias, as KWallet does; GNOME Keyring takes only `default`. */
  anyAlias?: boolean;
  /** Aliases set at run time (`SetAlias`), by alias, to a keyring name. */
  aliases?: Record<string, string>;
  /** Keyrings whose unlock prompt is open. */
  prompts?: string[];
  /** Azure Key Vault secrets that are disabled, by vault: listed by name only when asked for everything, and refused when read. */
  disabled?: Record<string, string[]>;
  /** Azure Key Vault secrets another Azure service manages, by vault. */
  managed?: Record<string, string[]>;
  /** Vaults whose `list` fails in an ordinary way (a server error). */
  listFails?: string[];
  /** How many `purge` calls per vault still answer a conflict (the delete is still going on). */
  purgeConflicts?: Record<string, number>;
  /** Azure Key Vault secrets that are deleted but recoverable, by vault, then name. */
  deleted?: Record<string, Record<string, string>>;
  /** Vaults that refuse `purge`, as one with purge protection or without purge permission does. */
  purgeForbidden?: string[];
  /** Every command line a fake client received, program first. */
  calls: string[][];
}

const statePath = process.env.AKM_FAKE_STORE_STATE as string;

export function loadState(): FakeStoreState {
  return JSON.parse(fs.readFileSync(statePath, "utf8")) as FakeStoreState;
}

export function saveState(state: FakeStoreState): void {
  fs.writeFileSync(statePath, JSON.stringify(state));
}

/** Record this invocation and return the state it starts from. */
export function beginCall(program: string): FakeStoreState {
  const state = loadState();
  state.calls.push([program, ...process.argv.slice(2)]);
  saveState(state);
  return state;
}

export function fail(message: string, status = 1): never {
  process.stderr.write(`${message}\n`);
  process.exit(status);
}

const COLLECTION_PREFIX = "/org/freedesktop/secrets/collection/";

/** The keyring an alias names, or undefined. */
export function keyringOfAlias(state: FakeStoreState, alias: string): string | undefined {
  const set = state.aliases?.[alias];
  if (set !== undefined) return set;
  return state.keyrings[alias] && !(state.unaliased ?? []).includes(alias) ? alias : undefined;
}

/** The keyring a collection argument names, as libsecret reads it: a path starting with `/` is an object path, any other is an alias. */
export function keyringOfCollection(state: FakeStoreState, collection: string): string | undefined {
  // A path element is [A-Za-z0-9_] only; libsecret asserts on anything else and secret-tool then hangs on a real service.
  const elements = collection.startsWith("/") ? collection.split("/").slice(1) : [collection];
  if (elements.some((element) => !/^\w+$/.test(element))) {
    fail(
      "(secret-tool:1): libsecret-CRITICAL **: secret_service_create_item_dbus_path: assertion 'collection_path != NULL && collection_path[0] != '\\0'' failed",
    );
  }
  if (collection.startsWith("/")) {
    const name = collection.slice(COLLECTION_PREFIX.length);
    return state.keyrings[name] ? name : undefined;
  }
  return keyringOfAlias(state, collection);
}
