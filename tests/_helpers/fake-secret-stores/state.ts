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
