// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Fake secret store clients for tests: `secret-tool` and `busctl` over an
 * in-file Secret Service, and `az` over an in-file Azure Key Vault. The store
 * adapters run real programs, so a test puts these on `PATH` in their place.
 */

import fs from "node:fs";
import path from "node:path";
import { clearAdapterCaches } from "../../src/core/adapter/registry";
import type { FakeStoreState } from "./fake-secret-stores/state";
import { makeSandboxDir, withEnv } from "./sandbox";

export type { FakeKeyringItem, FakeStoreState } from "./fake-secret-stores/state";

const CLIENTS = ["secret-tool", "busctl", "az"] as const;

export interface FakeSecretStores {
  /** The stores as the fake clients see them now. */
  state(): FakeStoreState;
}

/**
 * Run `run` with the fake clients first on `PATH`, over stores that start as
 * `initial`. `only` limits which clients exist, to stand for a machine without one.
 */
export async function withFakeSecretStores<T>(
  initial: Partial<Pick<FakeStoreState, "keyrings" | "vaults">>,
  run: (stores: FakeSecretStores) => Promise<T>,
  only: readonly (typeof CLIENTS)[number][] = CLIENTS,
): Promise<T> {
  const bin = makeSandboxDir("akm-fake-stores");
  clearAdapterCaches();
  try {
    const statePath = path.join(bin.dir, "state.json");
    fs.writeFileSync(statePath, JSON.stringify({ keyrings: {}, vaults: {}, calls: [], ...initial }));
    for (const client of only) {
      const script = path.join(import.meta.dir, "fake-secret-stores", `${client}.ts`);
      fs.writeFileSync(
        path.join(bin.dir, client),
        `#!${process.execPath}\nawait import(${JSON.stringify(script)});\n`,
        { mode: 0o755 },
      );
    }
    return await withEnv(
      { PATH: `${bin.dir}${path.delimiter}${process.env.PATH ?? ""}`, AKM_FAKE_STORE_STATE: statePath },
      () => run({ state: () => JSON.parse(fs.readFileSync(statePath, "utf8")) as FakeStoreState }),
    );
  } finally {
    clearAdapterCaches();
    bin.cleanup();
  }
}
